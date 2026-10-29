/**
 * FR-F4 的词频筛选口径（`changes/M1M2-closeout.md` 切片 4）。
 *
 * 关键口径：`freqBnc === 0` **不是"排名第 0"，是"没有排名"**。
 * 内置词条都有排名；导入词里没被 BNC 收录的词是 0。
 * 把 0 当排名会导致"筛前 2 万词"把一堆没排名的词也捞进来。
 */
import { describe, expect, it } from 'vitest';

import type { Word } from '../db/types';
import { matchesFilter, type ListRow } from './filter';

function row(partial: Partial<Word> & { lemma: string }): ListRow {
  const { lemma, ...rest } = partial;
  const word: Word = {
    id: lemma,
    lemma,
    surface: lemma,
    phoneticUs: '',
    phoneticUk: '',
    phoneticSrc: null,
    defSrc: 'imported',
    defZh: [],
    pos: [],
    examTags: [],
    freqBnc: 0,
    freqCoca: 0,
    exchange: '',
    status: 'new',
    meetCount: 0,
    isLemmatized: false,
    inflectionOf: null,
    isUnlisted: false,
    origin: 'native',
    fallbackDef: [],
    llmDef: [],
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...rest,
  };
  return { word, domains: [], domainCounts: {}, sceneCount: 0 };
}

describe('词频区间的"无排名"口径', () => {
  it('freqBnc = 0 的词不进"前 2 万词"区间', () => {
    const noRank = row({ lemma: 'obscure', freqBnc: 0 });
    expect(matchesFilter(noRank, { freqTo: 20000 })).toBe(false);
  });

  it('有排名的词正常命中区间', () => {
    const ranked = row({ lemma: 'run', freqBnc: 208 });
    expect(matchesFilter(ranked, { freqTo: 20000 })).toBe(true);
    expect(matchesFilter(ranked, { freqFrom: 100, freqTo: 300 })).toBe(true);
  });

  it('区间只设下界时，无排名词仍然不进（0 不该被当成最小值）', () => {
    const noRank = row({ lemma: 'obscure', freqBnc: 0 });
    expect(matchesFilter(noRank, { freqFrom: 1 })).toBe(false);
  });

  it('不设词频条件时，无排名词照常显示', () => {
    const noRank = row({ lemma: 'obscure', freqBnc: 0 });
    expect(matchesFilter(noRank, {})).toBe(true);
  });
});

describe('考试标签筛选', () => {
  it('多选之间是 OR', () => {
    const a = row({ lemma: 'a', examTags: ['cet4'] });
    const b = row({ lemma: 'b', examTags: ['gre'] });
    expect(matchesFilter(a, { examTags: ['cet4', 'gre'] })).toBe(true);
    expect(matchesFilter(b, { examTags: ['cet4', 'gre'] })).toBe(true);
  });

  it('没有标签的词不进带标签的筛选', () => {
    const none = row({ lemma: 'c' });
    expect(matchesFilter(none, { examTags: ['cet4'] })).toBe(false);
  });
});
