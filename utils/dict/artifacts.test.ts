/**
 * 真产物一致性检查。
 *
 * 前面两个测试文件用的是造的假数据，只证明代码逻辑对；
 * 这里直接读 `data/core-words.tsv` 与 `public/dict/`，证明**交给用户的那份词表**
 * 没丢词、没串词、释义是真中文。内容出问题得在这里挡住。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCoreTsv, serializeShard } from './build';
import { createDictLookup, normalizeSurface } from './lookup';
import { parseIndex, parseShard } from './source';
import type { DictIndex, DictShard } from './types';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sourceText = readFileSync(join(root, 'data', 'core-words.tsv'), 'utf8');
const indexText = readFileSync(join(root, 'public', 'dict', 'index.json'), 'utf8');

const parsed = parseCoreTsv(sourceText);
const index = parseIndex(indexText);

function readShard(file: string): DictShard {
  return parseShard(readFileSync(join(root, 'public', 'dict', file), 'utf8'));
}

const allShards = index.shards.map((info) => readShard(info.file));

describe('核心词表源文件', () => {
  it('零错误零警告地通过校验', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it('词条数量足以支撑日常查词（FR-B1 的目标见 TODO 的 M1-9）', () => {
    // 这只是防「文件被截断」的下限；FR-B1 的 2000–3000 目标尚未达到
    expect(parsed.entries.length).toBeGreaterThanOrEqual(500);
  });

  it('每条都有中文释义，不会混进没翻译的条目', () => {
    const missing = parsed.entries.filter(
      (e) => !e.defZh.some((def) => /[\u4e00-\u9fff]/.test(def)),
    );
    expect(missing.map((e) => e.lemma)).toEqual([]);
  });

  it('每条都有音标与词性', () => {
    expect(parsed.entries.filter((e) => e.phoneticUs === '').map((e) => e.lemma)).toEqual([]);
    expect(parsed.entries.filter((e) => e.pos.length === 0).map((e) => e.lemma)).toEqual([]);
  });
});

describe('发布产物与源文件一致', () => {
  it('清单条数等于源文件词条数', () => {
    expect(index.count).toBe(parsed.entries.length);
  });

  it('分片里的词正好是源文件的词，不多不少', () => {
    const inShards = allShards.flatMap((s) => Object.keys(s.words));
    expect(inShards).toHaveLength(parsed.entries.length);
    expect(new Set(inShards).size).toBe(parsed.entries.length);
    expect(inShards.sort()).toEqual(parsed.entries.map((e) => e.lemma).sort());
  });

  it('分片内容与源文件逐字段一致（防止产物没重新生成）', () => {
    const byLemma = new Map(allShards.flatMap((s) => Object.entries(s.words)));
    for (const entry of parsed.entries) {
      expect(byLemma.get(entry.lemma)).toEqual(entry);
    }
  });

  it('清单里记的字节数就是文件真实大小', () => {
    for (const info of index.shards) {
      const shard = allShards.find((s) => s.name === info.name);
      expect(shard).toBeDefined();
      expect(info.bytes).toBe(new TextEncoder().encode(serializeShard(shard!)).length);
    }
  });
});

describe('用真词表查询', () => {
  async function realDict() {
    const files: Record<string, string> = { 'index.json': indexText };
    for (const info of index.shards) {
      files[info.file] = readFileSync(join(root, 'public', 'dict', info.file), 'utf8');
    }
    return createDictLookup({
      readIndex: async () => files['index.json']!,
      readShard: async (file) => {
        const text = files[file];
        if (text === undefined) throw new Error(`缺分片 ${file}`);
        return text;
      },
    });
  }

  it('常用词同步查得到，划词噪声也扛得住', async () => {
    const dict = await realDict();
    await dict.warm();

    expect(dict.lookup('run')?.entry.defZh).toEqual(['跑', '经营']);
    expect(dict.lookup('"Run,"')?.entry.lemma).toBe('run');
    expect(dict.lookup('the')?.entry.pos).toEqual(['art.']);
  });

  it('整份词表单次载入后全量可查', async () => {
    const dict = await realDict();
    await dict.warm();

    const missed = parsed.entries
      .map((e) => e.lemma)
      .filter((lemma) => dict.lookup(normalizeSurface(lemma)) === undefined);
    expect(missed).toEqual([]);
  });
});
