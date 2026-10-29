#!/usr/bin/env node
/**
 * 构建核心词表分片。
 *
 *   node scripts/build-dict.ts            构建并写入 public/dict/
 *   node scripts/build-dict.ts --check    只校验，不写文件（CI 用）
 *
 * 产物：
 *   public/dict/index.json          版本清单 + 分片表
 *   public/dict/shard-<name>.json   分片本体
 *
 * 这些文件是包内资源，内容脚本经 `web_accessible_resources` 读取（PLAN.md §4.5 P3）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCoreTsv,
  serializeIndex,
  serializeShard,
  shardEntries,
} from '../utils/dict/build.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(root, 'data', 'core-words.tsv');
const outDir = join(root, 'public', 'dict');
const checkOnly = process.argv.includes('--check');

/** P3 的常驻分片容量。核心词表本身就在这个量级以内，因此实际只出一个分片 */
const HOT_MAX = 30_000;

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

const parsed = parseCoreTsv(readFileSync(sourceFile, 'utf8'));

for (const warning of parsed.warnings) console.warn(`[warn] ${warning}`);

if (parsed.errors.length > 0) {
  for (const error of parsed.errors) console.error(`[error] ${error}`);
  console.error(`\n校验失败：${parsed.errors.length} 处问题，未写出任何文件。`);
  process.exit(1);
}

const built = shardEntries(parsed.entries, {
  version,
  generatedAt: new Date().toISOString(),
  hotMax: HOT_MAX,
});

const summary = {
  source: 'data/core-words.tsv',
  version,
  entries: parsed.entries.length,
  warnings: parsed.warnings.length,
  shards: built.index.shards.map((s) => `${s.file} (${s.count} 词, ${s.bytes} B)`),
  totalBytes: built.index.shards.reduce((sum, s) => sum + s.bytes, 0),
};

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * 分片是提交进仓库的，所以「源改了、产物忘了重新生成」是真实风险。
 * --check 不只校验源，还逐字节比对产物，让漂移在 CI 就暴露。
 */
function findDrift(): string[] {
  const drift: string[] = [];
  const expected = new Set<string>(['index.json']);

  // 同目录下由别的脚本产出的文件，不算本脚本的多余产物。
  // `inflections.json` 由 scripts/build-inflections.ts 生成（FR-B3a）。
  const ownedByOtherScripts = new Set<string>(['inflections.json']);

  const indexText = readIfExists(join(outDir, 'index.json'));
  if (indexText === null) {
    drift.push('index.json 缺失');
  } else {
    const onDisk = JSON.parse(indexText) as Record<string, unknown>;
    // generatedAt 每次构建都变，比对时沿用盘上的值，只比结构
    const fresh = { ...built.index, generatedAt: onDisk['generatedAt'] ?? '' };
    if (JSON.stringify(onDisk) !== JSON.stringify(fresh)) drift.push('index.json 与源文件不一致');
  }

  for (const shard of built.shards) {
    const file = `shard-${shard.name}.json`;
    expected.add(file);
    const text = readIfExists(join(outDir, file));
    if (text === null) drift.push(`${file} 缺失`);
    else if (text !== serializeShard(shard)) drift.push(`${file} 与源文件不一致`);
  }

  if (existsSync(outDir)) {
    for (const name of readdirSync(outDir)) {
      if (name.endsWith('.json') && !expected.has(name) && !ownedByOtherScripts.has(name)) {
        drift.push(`${name} 是多余的（源文件里已无对应分片）`);
      }
    }
  }

  return drift;
}

if (checkOnly) {
  const drift = findDrift();
  if (drift.length > 0) {
    for (const item of drift) console.error(`[drift] ${item}`);
    console.error(`\n词表产物与 data/core-words.tsv 不一致：${drift.length} 处。`);
    console.error('跑 `node scripts/build-dict.ts` 重新生成后再提交。');
    process.exit(1);
  }
  console.log(JSON.stringify({ ...summary, wrote: false, drift: 0 }, null, 2));
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.json'), serializeIndex(built.index), 'utf8');
for (const shard of built.shards) {
  writeFileSync(join(outDir, `shard-${shard.name}.json`), serializeShard(shard), 'utf8');
}

console.log(JSON.stringify({ ...summary, wrote: true, outDir: 'public/dict' }, null, 2));
