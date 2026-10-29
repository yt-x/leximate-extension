/**
 * FR-B7 验收判定：分档整合、去重、写入 `dict` store（`decisions/0031`）。
 *
 * 与旧版的关键差异：**导入进 `dict`（词典），不进 `words`（生词本）**。
 * 因此这里不再有「跳过内置词」——内置词表在分片里，与 `dict` 是两条数据来源，
 * 查询时合并，写库时互不干扰。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { STORE, readTx, req } from '../db/schema';
import type { DictEntry } from '../db/types';
import { clearAllData } from '../db/maintenance';
import { clearDict, countDictEntries, getDictEntry, writeDictEntries } from '../dict/dict-store';
import { collectEcdictBatch, countEcdictPlan } from './ecdict-apply';
import { parseEcdictRows, type EcdictRow } from './ecdict-parse';

function csvRow(fields: Record<string, string>): string {
  const cols = ['word', 'phonetic', 'definition', 'translation', 'pos', 'collins', 'oxford', 'tag', 'bnc', 'frq', 'exchange', 'detail', 'audio'];
  // 含逗号/引号的值必须按 RFC4180 加引号，否则列会错位
  return cols
    .map((c) => {
      const value = fields[c] ?? '';
      return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    })
    .join(',');
}

const HEADER = 'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio';

function rows(...items: Record<string, string>[]): EcdictRow[] {
  const text = [HEADER, ...items.map(csvRow)].join('\r\n');
  const parsed = parseEcdictRows(text);
  expect(parsed.headerOk).toBe(true);
  return parsed.rows;
}

beforeEach(async () => {
  await clearAllData({ keepSettings: true });
  await clearDict();
});

describe('countEcdictPlan（分档整合）', () => {
  const sample = rows(
    { word: 'zebra', translation: 'n. 斑马', tag: 'zk' },
    { word: 'constraint', translation: 'n. 约束', tag: 'cet6 toefl gre' },
    { word: 'obscure', translation: 'a. obscure', tag: '' },
  );

  it('标准档只收带考试标签的行', () => {
    expect(countEcdictPlan(sample, 'standard')).toEqual({ total: 2, skippedByTier: 1 });
  });

  it('完整档收全部', () => {
    expect(countEcdictPlan(sample, 'full')).toEqual({ total: 3, skippedByTier: 0 });
  });
});

describe('collectEcdictBatch', () => {
  it('产出的条目带全部词典字段，且没有生词本字段', () => {
    const sample = rows({
      word: 'constraint',
      phonetic: "kən'streint",
      translation: 'n. 强制, 约束',
      tag: 'cet6',
      bnc: '2988',
      frq: '4643',
      exchange: 's:constraints',
    });
    const result = collectEcdictBatch(sample, 'full');
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.lemma).toBe('constraint');
    expect(entry.defZh).toEqual(['n. 强制, 约束']);
    expect(entry.examTags).toEqual(['cet6']);
    expect(entry.freqBnc).toBe(2988);
    expect(entry.exchange).toBe('s:constraints');
    expect(entry.source).toBe('ecdict');
    // 生词本字段一个都不该有
    expect(entry).not.toHaveProperty('meetCount');
    expect(entry).not.toHaveProperty('status');
    expect(entry).not.toHaveProperty('deletedAt');
  });

  it('同一 lemma 重复出现时只留第一条（文件被手工改过的情况）', () => {
    const sample = rows({ word: 'dup', translation: 'n. a' }, { word: 'dup', translation: 'n. b' });
    const result = collectEcdictBatch(sample, 'full');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.defZh).toEqual(['n. a']);
    expect(result.skippedDuplicate).toBe(1);
  });

  it('大小写不同归一成同一个 lemma', () => {
    const sample = rows({ word: 'PC', translation: '个人电脑' });
    expect(collectEcdictBatch(sample, 'full').entries[0]?.lemma).toBe('pc');
  });
});

describe('写入 dict store（与生词本互不干扰）', () => {
  function makeEntry(lemma: string): DictEntry {
    return {
      lemma,
      surface: lemma,
      phoneticUs: '',
      phoneticSrc: null,
      defZh: [`释义 ${lemma}`],
      pos: [],
      examTags: [],
      freqBnc: 0,
      freqCoca: 0,
      exchange: '',
      source: 'ecdict',
    };
  }

  it('分批写入全部条目', async () => {
    const progress: number[] = [];
    const summary = await writeDictEntries(['w1', 'w2', 'w3'].map(makeEntry), {
      batchSize: 2,
      onProgress: (done) => progress.push(done),
    });
    expect(summary).toEqual({ written: 3, cancelled: false });
    expect(progress).toEqual([2, 3]);
    expect(await countDictEntries()).toBe(3);
  });

  it('取消后回滚已写批次，并恢复被覆盖的旧词典条目', async () => {
    const previous = { ...makeEntry('c1'), defZh: ['旧释义'] };
    await writeDictEntries([previous]);

    let cancelled = false;
    const summary = await writeDictEntries(['c1', 'c2', 'c3', 'c4'].map(makeEntry), {
      batchSize: 2,
      isCancelled: () => cancelled,
      onProgress: () => {
        cancelled = true;
      },
    });
    expect(summary).toEqual({ written: 2, cancelled: true });
    expect(await countDictEntries()).toBe(1);
    expect(await getDictEntry('c1')).toEqual(previous);
    expect(await getDictEntry('c2')).toBeUndefined();
  });

  it('批内写入是事务性的：一条出事整批回滚', async () => {
    const good = makeEntry('g1');
    const bad = { ...makeEntry('g2'), lemma: undefined } as unknown as DictEntry;
    await expect(writeDictEntries([good, bad], { batchSize: 10 })).rejects.toBeTruthy();
    expect(await countDictEntries()).toBe(0);
  });

  it('写入词典后生词本仍是空的（这是本轮的核心判据）', async () => {
    await writeDictEntries(['run', 'study', 'constraint'].map(makeEntry));
    expect(await countDictEntries()).toBe(3);
    const words = await readTx(STORE.words, (tx) => req<unknown[]>(tx.objectStore(STORE.words).getAll()));
    expect(words).toHaveLength(0);
  });

  it('按 lemma 直查取得到', async () => {
    await writeDictEntries([makeEntry('constraint')]);
    const hit = await getDictEntry('constraint');
    expect(hit?.defZh).toEqual(['释义 constraint']);
  });
});
