/**
 * 词典与生词本解耦（`decisions/0031` 的核心契约）。
 *
 * 上一轮的教训：把导入的 77 万条写进 `words`（生词本表），靠
 * `defSrc === 'imported'` 过滤区分，结果漏一处就"词典全变生词"。
 *
 * 本轮把词典独立到 `dict` store。这些用例锁的就是「两者谁都看不见谁」：
 * - 写词典不影响生词本的计数 / 列表 / 下划线集合；
 * - 写生词本不影响词典的计数 / 查询；
 * - 「移除词库」只清 `dict`，生词本一条不少。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { clearAllData } from './maintenance';
import { clearDict, countDictEntries, getDictEntry, writeDictEntries } from '../dict/dict-store';
import { lookupImported } from '../dict/imported-lookup';
import type { DictEntry } from './types';
import { countWords, listNewWords, listWords, upsertWord } from './words';

function entry(lemma: string): DictEntry {
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

beforeEach(async () => {
  await clearAllData({ keepSettings: true });
  await clearDict();
});

describe('写词典不污染生词本', () => {
  it('导入 500 条词典后：角标仍 0、列表仍空、下划线集合仍空', async () => {
    const entries = Array.from({ length: 500 }, (_, i) => entry(`word${i}`));
    await writeDictEntries(entries);

    expect(await countDictEntries()).toBe(500);
    // 生词本三个口径全部不受影响
    expect(await countWords()).toBe(0);
    expect(await listWords()).toEqual([]);
    expect(await listNewWords()).toEqual([]);
  });

  it('生词本里有词时，导入词典不会把它挤掉或改写', async () => {
    const { word } = await upsertWord({ lemma: 'run', defZh: ['v. 跑'], defSrc: 'authored', now: 1 });
    await writeDictEntries([entry('run'), entry('study')]);

    const mine = (await listWords())[0];
    expect(mine!.id).toBe(word.id);
    expect(mine!.defZh).toEqual(['v. 跑']);
    expect(await countWords()).toBe(1);
  });
});

describe('写生词本不影响词典', () => {
  it('收藏一个词典里也有的词，词典条目本身不变', async () => {
    await writeDictEntries([{ ...entry('constraint'), defZh: ['n. 约束'] }]);
    await upsertWord({ lemma: 'constraint', now: 1 });

    const dictHit = await getDictEntry('constraint');
    expect(dictHit?.defZh).toEqual(['n. 约束']);
    expect(await countDictEntries()).toBe(1);
    // 生词本里也有一条，两者互不覆盖
    expect((await listWords()).map((w) => w.lemma)).toEqual(['constraint']);
  });
});

describe('移除词库只清词典', () => {
  it('生词本条目一条不少', async () => {
    await writeDictEntries([entry('aaa'), entry('bbb'), entry('run')]);
    await upsertWord({ lemma: 'run', now: 1 });
    await upsertWord({ lemma: 'study', now: 2 });

    const removed = await clearDict();
    expect(removed.removed).toBe(3);
    expect(await countDictEntries()).toBe(0);
    // 生词本完好
    expect((await listWords()).map((w) => w.lemma).sort()).toEqual(['run', 'study']);
    expect(await countWords()).toBe(2);
    // 词典查询随之失效
    expect(await lookupImported('run')).toBeNull();
  });
});
