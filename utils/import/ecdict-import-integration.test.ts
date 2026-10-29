/**
 * 导入的一致性不变量（FR-B7 / FR-B7b）。
 *
 * 背景（用户实测 2026-10-22）：完整档导入 77 万条后，
 * `dict` 数据齐全但 `Meta.importedInflections` 是空的（映射条目数 = 0）。
 * 原因：映射在建库**之后**单独跑一步（`importFile` 里 `writeDictEntries` 完再 `buildImportedInflections`），
 * 77 万条写入约 2 分钟，用户在这期间关掉/刷新管理台就会留下「词典有、映射无」的不一致。
 *
 * 这些用例锁住"导入必须同时产出词典与映射"这个不变量。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { clearAllData } from '../db/maintenance';
import { getMeta, setMeta } from '../db/kv';
import type { DictEntry } from '../db/types';
import { clearDict, countDictEntries, getDictEntry, writeDictEntries } from '../dict/dict-store';
import { lookupImported } from '../dict/imported-lookup';
import { collectEcdictBatch } from './ecdict-apply';
import { parseEcdictRows, type EcdictRow } from './ecdict-parse';
import { runEcdictImport } from './ecdict-apply';

const HEADER = 'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio';

function csvRow(fields: Record<string, string>): string {
  const cols = ['word', 'phonetic', 'definition', 'translation', 'pos', 'collins', 'oxford', 'tag', 'bnc', 'frq', 'exchange', 'detail', 'audio'];
  return cols.map((c) => {
    const v = fields[c] ?? '';
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
}

function rows(...items: Record<string, string>[]): EcdictRow[] {
  const p = parseEcdictRows([HEADER, ...items.map(csvRow)].join('\r\n'));
  expect(p.headerOk).toBe(true);
  return p.rows;
}

const DISPATCH = {
  word: 'dispatch',
  translation: 'vt. 派遣',
  tag: 'cet6 toefl',
  exchange: 'd:dispatched/p:dispatched/s:dispatches/i:dispatching/3:dispatches',
};

beforeEach(async () => {
  await clearAllData({ keepSettings: true });
  await clearDict();
});

describe('导入的一致性：词典与变形映射必须同时就位', () => {
  it('一次导入后：dict 有条目 且 映射可还原 dispatching', async () => {
    const batch = collectEcdictBatch(rows(DISPATCH), 'full');
    const result = await runEcdictImport(batch.entries);

    expect(await countDictEntries()).toBe(1);
    const { importedInflections } = await getMeta();
    expect(Object.keys(importedInflections).length).toBeGreaterThan(0);

    const hit = await lookupImported('dispatching');
    expect(hit?.entry.lemma).toBe('dispatch');
  });

  it('中途取消时恢复调用前的词典与变形映射', async () => {
    const previous: DictEntry = {
      lemma: 'old',
      surface: 'old',
      phoneticUs: '',
      phoneticSrc: null,
      defZh: ['旧词典'],
      pos: [],
      examTags: [],
      freqBnc: 0,
      freqCoca: 0,
      exchange: 's:olds',
      source: 'ecdict',
    };
    const previousInflections = { olds: { lemma: 'old', label: '复数' } };
    await writeDictEntries([previous]);
    await setMeta({ importedInflections: previousInflections });

    const batch = collectEcdictBatch(
      rows(DISPATCH, { word: 'study', translation: 'n. 学习', tag: 'cet4', exchange: 's:studies' }),
      'full',
    );
    let cancelled = false;
    const result = await runEcdictImport(batch.entries, {
      batchSize: 1,
      isCancelled: () => cancelled,
      onProgress: () => {
        cancelled = true;
      },
    });

    expect(result.cancelled).toBe(true);
    expect(await countDictEntries()).toBe(1);
    expect(await getDictEntry('old')).toEqual(previous);
    expect(await getDictEntry('dispatch')).toBeUndefined();
    expect((await getMeta()).importedInflections).toEqual(previousInflections);
  });

  it('后续批次失败时恢复调用前的词典与变形映射', async () => {
    const previous: DictEntry = {
      lemma: 'old',
      surface: 'old',
      phoneticUs: '',
      phoneticSrc: null,
      defZh: ['旧词典'],
      pos: [],
      examTags: [],
      freqBnc: 0,
      freqCoca: 0,
      exchange: 's:olds',
      source: 'ecdict',
    };
    const previousInflections = { olds: { lemma: 'old', label: '复数' } };
    await writeDictEntries([previous]);
    await setMeta({ importedInflections: previousInflections });

    const good = collectEcdictBatch(rows(DISPATCH), 'full').entries[0]!;
    const bad = {
      ...good,
      lemma: 'broken',
      defZh: [() => undefined] as unknown as string[],
    };
    await expect(runEcdictImport([good, bad], { batchSize: 1 })).rejects.toBeTruthy();

    expect(await countDictEntries()).toBe(1);
    expect(await getDictEntry('old')).toEqual(previous);
    expect(await getDictEntry('dispatch')).toBeUndefined();
    expect((await getMeta()).importedInflections).toEqual(previousInflections);
  });
});
