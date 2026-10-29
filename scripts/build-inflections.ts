#!/usr/bin/env node
/**
 * 构建变形索引产物（PLAN.md FR-B3a / FR-B3d、§4.5 P4）。
 *
 *   node scripts/build-inflections.ts            构建并写入 public/dict/
 *   node scripts/build-inflections.ts --check     只校验，不写文件（CI 用）
 *
 * 产物：
 *   public/dict/inflections.json   surface → 候选原形 的反向索引
 *
 * 输入是**钉版入仓的原始拉取结果** `data/inflections/wikidata-forms.tsv`
 * （由 `scripts/fetch-inflections.ts` 生成）。原始产物与派生产物分开，
 * 是为了让"过滤规则改了"与"上游数据变了"两件事可分辨。
 *
 * 与 `build-dict.ts` 同一模式：产物入库，`--check` 逐字节比对守漂移。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReverseIndex,
  labelForFeatures,
  shouldKeepForm,
  type InflectionRecord,
} from '../utils/dict/lemmatize.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(root, 'data', 'inflections', 'wikidata-forms.tsv');
const outDir = join(root, 'public', 'dict');
const outFile = join(outDir, 'inflections.json');
const checkOnly = process.argv.includes('--check');

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

/** 产物格式。改了结构必须升版本，让内容脚本能判断兼容性 */
const ARTIFACT_VERSION = 1;

interface RawRow {
  lemma: string;
  form: string;
  features: string[];
}

function parseRaw(text: string): RawRow[] {
  const rows: RawRow[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [lemma = '', form = '', features = ''] = line.split('\t');
    if (!lemma || !form) continue;
    rows.push({ lemma, form, features: features ? features.split(',').filter(Boolean) : [] });
  }
  return rows;
}

/**
 * 原始行摊平成 `InflectionRecord`。
 *
 * 一行可能带多个特征（`Q110786,Q146786,Q3910936`）。逐个特征展开，
 * 让下游的"特征白名单 / 排除"能独立判定每一条。
 * 一条特征都不带的 form 保留 feature='' —— 它进不了提示语，但仍可能有用，
 * 交给 `shouldKeepForm` 决定去留而不是在这里静默丢弃。
 */
function expand(rows: RawRow[]): InflectionRecord[] {
  const out: InflectionRecord[] = [];
  for (const row of rows) {
    if (row.features.length === 0) {
      out.push({ lemma: row.lemma, form: row.form, feature: '' });
      continue;
    }
    for (const feature of row.features) {
      out.push({ lemma: row.lemma, form: row.form, feature });
    }
  }
  return out;
}

const raw = parseRaw(readFileSync(sourceFile, 'utf8'));
const expanded = expand(raw);

// 统计过滤效果：让"过滤规则吃掉了多少"在构建输出里可见，而不是悄无声息
const kept = expanded.filter((r) => shouldKeepForm(r.lemma, r.form, r.feature));
const dropped = expanded.length - kept.length;

const index = buildReverseIndex(expanded);

/** 序列化：surface 升序，候选按原形升序——保证重算逐字节可复现 */
function serialize(): string {
  const entries = [...index.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([surface, bucket]) => {
      const candidates = [...bucket.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([lemma, features]) => ({ lemma, hint: labelForFeatures(features) }));
      return [surface, candidates] as const;
    });

  const payload = {
    version: ARTIFACT_VERSION,
    dictVersion: version,
    source: 'Wikidata Lexeme (CC0)',
    count: entries.length,
    entries: Object.fromEntries(entries),
  };
  return JSON.stringify(payload);
}

const next = serialize();

const summary = {
  source: 'data/inflections/wikidata-forms.tsv',
  target: 'public/dict/inflections.json',
  rawRows: raw.length,
  expandedRecords: expanded.length,
  keptRecords: kept.length,
  droppedRecords: dropped,
  surfaces: index.size,
  bytes: new TextEncoder().encode(next).length,
};

/**
 * 漂移检测。
 *
 * 比的是**语义**而不是字节：`dictVersion` 随 package.json 版本走，
 * 版本变了不该算漂移（否则每次发版都要重跑构建）。
 */
function findDrift(): string[] {
  if (!existsSync(outFile)) return ['inflections.json 缺失'];
  try {
    const onDisk = JSON.parse(readFileSync(outFile, 'utf8')) as {
      version?: number;
      count?: number;
      entries?: Record<string, unknown>;
    };
    const fresh = JSON.parse(next) as { version: number; count: number; entries: Record<string, unknown> };
    const drift: string[] = [];
    if (onDisk.version !== fresh.version) drift.push(`产物格式版本不一致：盘上 ${onDisk.version}，预期 ${fresh.version}`);
    if (onDisk.count !== fresh.count) drift.push(`surface 条目数不一致：盘上 ${onDisk.count}，预期 ${fresh.count}`);
    if (JSON.stringify(onDisk.entries) !== JSON.stringify(fresh.entries)) {
      drift.push('索引内容与源文件不一致');
    }
    return drift;
  } catch (err) {
    return [`inflections.json 解析失败：${err instanceof Error ? err.message : String(err)}`];
  }
}

if (checkOnly) {
  const drift = findDrift();
  if (drift.length > 0) {
    for (const item of drift) console.error(`[drift] ${item}`);
    console.error('\n变形索引产物与 data/inflections/wikidata-forms.tsv 不一致。');
    console.error('跑 `node scripts/build-inflections.ts` 重新生成后再提交。');
    process.exit(1);
  }
  console.log(JSON.stringify({ ...summary, wrote: false, drift: 0 }, null, 2));
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const before = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
writeFileSync(outFile, next, 'utf8');

console.log(
  JSON.stringify({ ...summary, wrote: before !== next, outDir: 'public/dict' }, null, 2),
);
