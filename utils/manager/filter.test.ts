/**
 * 搜索 / 筛选 / 排序的单测（PLAN.md §1.F 的实现口径逐条对应）。
 *
 * 重点在**语义边界**：条件间 AND、条件内 OR、排序稳定性、匹配大小写。
 * 这些是"看起来显然、写错也不报错"的地方——比如把 AND 写成 OR，
 * 用户只会觉得"筛选好像没生效"。
 */
import { describe, expect, it } from 'vitest';
import type { WordStatus } from '../db/types';
import {
  availableFacets,
  compareRows,
  DEFAULT_SORT,
  matchesFilter,
  matchesSearch,
  selectRows,
} from './filter';
import { makeRow as row } from './testing';

describe('matchesSearch（FR-F3 子串匹配）', () => {
  it('空搜索词匹配一切', () => {
    expect(matchesSearch(row({ lemma: 'run' }), '')).toBe(true);
    expect(matchesSearch(row({ lemma: 'run' }), '   ')).toBe(true);
  });

  it('子串匹配而非前缀匹配', () => {
    // "unn" 在 "running" 中间——FR-F3 要的是模糊子串，不是前缀匹配
    expect(matchesSearch(row({ lemma: 'running' }), 'unn')).toBe(true);
    // 反向确认：不是前缀但确实存在
    expect(matchesSearch(row({ lemma: 'running' }), 'runn')).toBe(true);
    // 顺序错乱不算子串（本项目不做编辑距离/模糊纠错，见 filter.ts 的说明）
    expect(matchesSearch(row({ lemma: 'running' }), 'nur')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(matchesSearch(row({ lemma: 'Run' }), 'RUN')).toBe(true);
    expect(matchesSearch(row({ lemma: 'run' }), 'RuN')).toBe(true);
  });

  it('同时匹配 lemma 与 surface', () => {
    // 列表显示 surface（"went"），但 lemma 是 "go"——两种输入都该命中
    const r = row({ lemma: 'go', surface: 'went' });
    expect(matchesSearch(r, 'go')).toBe(true);
    expect(matchesSearch(r, 'went')).toBe(true);
  });

  it('两端空白被忽略', () => {
    expect(matchesSearch(row({ lemma: 'run' }), '  run  ')).toBe(true);
  });

  it('不匹配的词返回 false', () => {
    expect(matchesSearch(row({ lemma: 'run' }), 'swim')).toBe(false);
  });
});

describe('matchesFilter（FR-F4 条件间 AND）', () => {
  it('多条件同时满足才留下', () => {
    const r = row({ lemma: 'run', status: 'known', meetCount: 3 }, { sceneCount: 2 });

    expect(matchesFilter(r, { statuses: ['known'], hasScenes: true })).toBe(true);
    // 状态对但没例句 → AND 语义下应被排除
    expect(matchesFilter(r, { statuses: ['known'], hasScenes: false })).toBe(false);
  });

  it('状态多选是 OR', () => {
    const r = row({ lemma: 'run', status: 'known' });

    expect(matchesFilter(r, { statuses: ['known', 'ignored'] })).toBe(true);
    expect(matchesFilter(r, { statuses: ['new', 'ignored'] })).toBe(false);
  });

  it('空数组表示不筛，而不是"什么都不匹配"', () => {
    // 这条容易写反：`[].includes(x)` 恒为 false，会把所有行滤掉
    const r = row({ lemma: 'run', status: 'known' });
    expect(matchesFilter(r, { statuses: [], domains: [], examTags: [] })).toBe(true);
  });

  it('域名多选是 OR，且任一命中即可', () => {
    const r = row({ lemma: 'run' }, { domains: ['a.com', 'b.com'] });

    expect(matchesFilter(r, { domains: ['b.com'] })).toBe(true);
    expect(matchesFilter(r, { domains: ['a.com', 'b.com'] })).toBe(true);
    expect(matchesFilter(r, { domains: ['c.com'] })).toBe(false);
  });

  it('考试标签多选是 OR', () => {
    const r = row({ lemma: 'run', examTags: ['cet4'] });
    expect(matchesFilter(r, { examTags: ['cet6', 'cet4'] })).toBe(true);
    expect(matchesFilter(r, { examTags: ['gre'] })).toBe(false);
  });

  it('时间区间是闭区间', () => {
    const r = row({ lemma: 'run', createdAt: 1000 });

    expect(matchesFilter(r, { createdFrom: 1000, createdTo: 1000 })).toBe(true);
    expect(matchesFilter(r, { createdFrom: 1001 })).toBe(false);
    expect(matchesFilter(r, { createdTo: 999 })).toBe(false);
  });

  it('区间某一端为 null 表示该端不设限', () => {
    const r = row({ lemma: 'run', createdAt: 1000 });
    expect(matchesFilter(r, { createdFrom: null, createdTo: null })).toBe(true);
    expect(matchesFilter(r, { createdFrom: 500, createdTo: null })).toBe(true);
  });

  it('词频区间按 freqBnc', () => {
    const r = row({ lemma: 'run', freqBnc: 500 });
    expect(matchesFilter(r, { freqFrom: 100, freqTo: 1000 })).toBe(true);
    expect(matchesFilter(r, { freqFrom: 501 })).toBe(false);
  });

  it('hasScenes 三态：undefined 不筛、true 只留有的、false 只留没有的', () => {
    const withScenes = row({ lemma: 'a' }, { sceneCount: 1 });
    const without = row({ lemma: 'b' }, { sceneCount: 0 });

    expect(matchesFilter(withScenes, {})).toBe(true);
    expect(matchesFilter(without, {})).toBe(true);
    expect(matchesFilter(withScenes, { hasScenes: true })).toBe(true);
    expect(matchesFilter(without, { hasScenes: true })).toBe(false);
    expect(matchesFilter(withScenes, { hasScenes: false })).toBe(false);
    expect(matchesFilter(without, { hasScenes: false })).toBe(true);
  });

  it('软删除的词默认不出现', () => {
    const deleted = row({ lemma: 'gone', deletedAt: 5000 });
    expect(matchesFilter(deleted, {})).toBe(false);
    expect(matchesFilter(deleted, { includeDeleted: true })).toBe(true);
  });
});

describe('compareRows / selectRows（FR-F5 排序稳定性）', () => {
  it('四种排序键各自正确', () => {
    const a = row({ lemma: 'apple', createdAt: 100, meetCount: 5, freqBnc: 10 });
    const b = row({ lemma: 'banana', createdAt: 200, meetCount: 1, freqBnc: 90 });

    expect(compareRows(a, b, { key: 'createdAt', direction: 'asc' })).toBeLessThan(0);
    expect(compareRows(a, b, { key: 'meetCount', direction: 'asc' })).toBeGreaterThan(0);
    expect(compareRows(a, b, { key: 'freqBnc', direction: 'asc' })).toBeLessThan(0);
    expect(compareRows(a, b, { key: 'lemma', direction: 'asc' })).toBeLessThan(0);
  });

  it('升降序只翻转主键，不翻转兜底', () => {
    const a = row({ lemma: 'apple', createdAt: 100 });
    const b = row({ lemma: 'banana', createdAt: 100 });

    // 主键相同 → 无论方向，都按 lemma 升序（兜底不随方向翻转）
    expect(compareRows(a, b, { key: 'createdAt', direction: 'asc' })).toBeLessThan(0);
    expect(compareRows(a, b, { key: 'createdAt', direction: 'desc' })).toBeLessThan(0);
  });

  it('主键相同时顺序确定，两次排序结果一致', () => {
    // 虚拟滚动按索引切片，顺序不稳会让滚动时行内容跳动
    const rows = [
      row({ lemma: 'c', meetCount: 1 }),
      row({ lemma: 'a', meetCount: 1 }),
      row({ lemma: 'b', meetCount: 1 }),
    ];
    const spec = { key: 'meetCount' as const, direction: 'desc' as const };

    const first = selectRows(rows, {}, spec).map((r) => r.word.lemma);
    const second = selectRows(rows, {}, spec).map((r) => r.word.lemma);

    expect(first).toEqual(['a', 'b', 'c']);
    expect(second).toEqual(first);
  });

  it('不修改入参数组', () => {
    const rows = [row({ lemma: 'b', createdAt: 2 }), row({ lemma: 'a', createdAt: 1 })];
    const before = rows.map((r) => r.word.lemma);

    selectRows(rows, {}, { key: 'createdAt', direction: 'asc' });

    // 原地 sort 会让 React 因引用未变而不重渲染
    expect(rows.map((r) => r.word.lemma)).toEqual(before);
  });

  it('升序 / 降序结果互为反向（主键无重复时）', () => {
    const rows = [
      row({ lemma: 'a', meetCount: 1 }),
      row({ lemma: 'b', meetCount: 2 }),
      row({ lemma: 'c', meetCount: 3 }),
    ];

    const asc = selectRows(rows, {}, { key: 'meetCount', direction: 'asc' });
    const desc = selectRows(rows, {}, { key: 'meetCount', direction: 'desc' });

    expect(asc.map((r) => r.word.lemma)).toEqual(['a', 'b', 'c']);
    expect(desc.map((r) => r.word.lemma)).toEqual(['c', 'b', 'a']);
  });

  it('筛选与排序一次算完：先筛后排', () => {
    const rows = [
      row({ lemma: 'a', status: 'known', meetCount: 1 }),
      row({ lemma: 'b', status: 'new', meetCount: 9 }),
      row({ lemma: 'c', status: 'known', meetCount: 5 }),
    ];

    const result = selectRows(rows, { statuses: ['known'] }, { key: 'meetCount', direction: 'desc' });
    expect(result.map((r) => r.word.lemma)).toEqual(['c', 'a']);
  });

  it('DEFAULT_SORT 是创建时间降序（最近加的排最上）', () => {
    expect(DEFAULT_SORT).toEqual({ key: 'createdAt', direction: 'desc' });
  });
});

describe('availableFacets', () => {
  it('从当前数据抽出域名与标签，去重并排序', () => {
    const rows = [
      row({ lemma: 'a', examTags: ['cet6'] }, { domains: ['b.com', 'a.com'] }),
      row({ lemma: 'b', examTags: ['cet4', 'cet6'] }, { domains: ['a.com'] }),
    ];

    expect(availableFacets(rows)).toEqual({
      domains: ['a.com', 'b.com'],
      examTags: ['cet4', 'cet6'],
    });
  });

  it('空串不进筛选项', () => {
    // domainOf 解析失败会返回空串，进下拉框会变成一个无法理解的空选项
    const rows = [row({ lemma: 'a', examTags: [''] }, { domains: [''] })];
    expect(availableFacets(rows)).toEqual({ domains: [], examTags: [] });
  });

  it('空输入返回空', () => {
    expect(availableFacets([])).toEqual({ domains: [], examTags: [] });
  });
});

describe('状态类型完整性', () => {
  it('三种状态都能被筛到（防新增状态漏处理）', () => {
    const statuses: WordStatus[] = ['new', 'known', 'ignored'];
    for (const status of statuses) {
      expect(matchesFilter(row({ lemma: 'x', status }), { statuses: [status] })).toBe(true);
    }
  });
});
