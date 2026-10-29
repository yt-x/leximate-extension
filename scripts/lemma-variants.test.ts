/**
 * 取数匹配键变体的单测（`changes/M1M2-closeout.md` 切片 6）。
 *
 * 判定：33 个"有词位但没取到"的词，其真实 Wikidata lemma 必须在变体列表里。
 * 这些对照来自 2026-10-18 的实测（`.local/staging/inflection-gap-findings.md`）。
 */
import { describe, expect, it } from 'vitest';

import { lemmaVariants } from './lemma-variants';

describe('lemmaVariants：实测命中的 33 个词', () => {
  const cases: Array<[string, string]> = [
    // 大小写
    ['american', 'American'],
    ['african', 'African'],
    ['british', 'British'],
    ['french', 'French'],
    ['christmas', 'Christmas'],
    ['spanish', 'Spanish'],
    ['russian', 'Russian'],
    ['italian', 'Italian'],
    ['japanese', 'Japanese'],
    ['indian', 'Indian'],
    ['irish', 'Irish'],
    ['scottish', 'Scottish'],
    ['victorian', 'Victorian'],
    ['european', 'European'],
    ['chinese', 'Chinese'],
    ['christian', 'Christian'],
    ['australian', 'Australian'],
    ['marxism', 'Marxism'],
    ['marxist', 'Marxist'],
    ['tory', 'Tory'],
    ['pc', 'PC'],
    ['pm', 'PM'],
    ['tv', 'TV'],
    // 英美拼写
    ['favor', 'favour'],
    ['rumor', 'rumour'],
    ['labor', 'labour'],
    ['favourite', 'favorite'],
    ['organisation', 'organization'],
    // 字符差异（原词 `o'clock` 本身由第一批精确查询覆盖，这里只验弯引号变体）
    ["o'clock", 'o’clock'],
    ['north-east', 'northeast'],
  ];

  for (const [ours, theirs] of cases) {
    it(`${ours} 的变体包含 ${theirs}`, () => {
      const variants = lemmaVariants(ours);
      expect(variants).toContain(theirs);
    });
  }
});

describe('lemmaVariants：边界', () => {
  it('不返回原词本身（避免重复查询）', () => {
    expect(lemmaVariants('run')).not.toContain('run');
  });

  it('结果去重', () => {
    const variants = lemmaVariants('american');
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('空串返回空数组', () => {
    expect(lemmaVariants('')).toEqual([]);
  });

  it('已大写的词不会生成同名变体', () => {
    expect(lemmaVariants('American')).not.toContain('American');
  });

  it('连字符词同时给拼接写法', () => {
    expect(lemmaVariants('north-east')).toContain('northeast');
    expect(lemmaVariants('north-east')).toContain('Northeast');
  });
});
