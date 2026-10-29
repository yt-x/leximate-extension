/**
 * 统计计算的单测（PLAN.md FR-F8）。
 *
 * 重点是**口径一致性**：遇到次数分布必须与下划线的分档同源
 * （都用 `meetCountTier`），否则会出现"统计说 3 次、下划线按 4 档画"。
 */
import { describe, expect, it } from 'vitest';
import { meetCountTier } from '../content/highlight-plan';
import { computeStats, startOfLocalDay, TOP_DOMAINS } from './stats';
import { makeRow as row } from './testing';

/** 固定"现在"，避免用例依赖真实时钟 */
const NOW = new Date('2026-10-15T12:00:00').getTime();

describe('startOfLocalDay', () => {
  it('取本地日历日零点，不是 UTC 零点', () => {
    const start = startOfLocalDay(NOW);
    const d = new Date(start);

    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
    expect(d.getDate()).toBe(new Date(NOW).getDate());
  });
});

describe('computeStats 基本计数', () => {
  it('总词数、已掌握、例句总数', () => {
    const rows = [
      row({ lemma: 'a', status: 'known' }, { sceneCount: 2 }),
      row({ lemma: 'b', status: 'new' }, { sceneCount: 3 }),
      row({ lemma: 'c', status: 'known' }, { sceneCount: 0 }),
    ];

    const stats = computeStats(rows, NOW);
    expect(stats.totalWords).toBe(3);
    expect(stats.knownCount).toBe(2);
    expect(stats.totalScenes).toBe(5);
  });

  it('按状态分组', () => {
    const rows = [
      row({ lemma: 'a', status: 'new' }),
      row({ lemma: 'b', status: 'ignored' }),
      row({ lemma: 'c', status: 'known' }),
      row({ lemma: 'd', status: 'ignored' }),
      row({ lemma: 'e', status: 'known' }),
    ];

    expect(computeStats(rows, NOW).byStatus).toEqual({
      new: 1,
      known: 2,
      ignored: 2,
    });
  });

  it('今日新增按本地日切，昨天的算昨天', () => {
    const todayStart = startOfLocalDay(NOW);
    const rows = [
      row({ lemma: 'today', createdAt: todayStart }),
      row({ lemma: 'alsoToday', createdAt: NOW }),
      row({ lemma: 'yesterday', createdAt: todayStart - 1 }),
    ];

    expect(computeStats(rows, NOW).newToday).toBe(2);
  });

  it('软删除的词完全不计入（否则总数与列表行数对不上）', () => {
    const rows = [
      row({ lemma: 'live' }, { sceneCount: 1 }),
      row({ lemma: 'deleted', deletedAt: 5000 }, { sceneCount: 9 }),
    ];

    const stats = computeStats(rows, NOW);
    expect(stats.totalWords).toBe(1);
    expect(stats.totalScenes).toBe(1);
    expect(stats.byStatus.new).toBe(1);
  });

  it('空输入返回全零而不是抛错', () => {
    const stats = computeStats([], NOW);
    expect(stats.totalWords).toBe(0);
    expect(stats.topDomains).toEqual([]);
    expect(stats.meetDistribution).toHaveLength(5);
  });
});

describe('computeStats 遇见次数分布（与下划线同源）', () => {
  it('五档，档位与 meetCountTier 完全一致', () => {
    // 这条例比的就是"统计口径 == 呈现口径"
    for (const count of [0, 1, 2, 3, 4, 5, 10, 99]) {
      const stats = computeStats([row({ lemma: `w${count}`, meetCount: count })], NOW);
      const hit = stats.meetDistribution.find((b) => b.count === 1);
      expect(hit!.tier).toBe(meetCountTier(count));
    }
  });

  it('同档的词合进同一档', () => {
    const rows = [
      row({ lemma: 'a', meetCount: 5 }),
      row({ lemma: 'b', meetCount: 8 }),
      row({ lemma: 'c', meetCount: 1 }),
    ];

    const stats = computeStats(rows, NOW);
    expect(stats.meetDistribution[4]!.count).toBe(2); // 5 及以上
    expect(stats.meetDistribution[0]!.count).toBe(1); // 1
  });

  it('最高档无上界，其余档上界 = 下一档下界 - 1', () => {
    const buckets = computeStats([], NOW).meetDistribution;

    expect(buckets[0]).toMatchObject({ tier: 1, from: 0, to: 1 });
    expect(buckets[4]).toMatchObject({ tier: 5, from: 5, to: null });
    for (let i = 0; i < 4; i += 1) {
      expect(buckets[i]!.to).toBe(buckets[i + 1]!.from - 1);
    }
  });

  it('所有词恰好落进一档（分档无缝隙也无重叠）', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ lemma: `w${i}`, meetCount: i }));
    const total = computeStats(rows, NOW).meetDistribution.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(12);
  });
});

describe('computeStats 来源域名 Top N', () => {
  it('按例句数降序，取前 5 条', () => {
    const rows = [
      row({ lemma: 'a' }, { domains: ['big.com'] }),
      row({ lemma: 'b' }, { domains: ['big.com'] }),
      row({ lemma: 'c' }, { domains: ['big.com'] }),
      row({ lemma: 'd' }, { domains: ['mid.com'] }),
      row({ lemma: 'e' }, { domains: ['mid.com'] }),
      row({ lemma: 'f' }, { domains: ['s1.com'] }),
      row({ lemma: 'g' }, { domains: ['s2.com'] }),
      row({ lemma: 'h' }, { domains: ['s3.com'] }),
      row({ lemma: 'i' }, { domains: ['s4.com'] }),
    ];

    const stats = computeStats(rows, NOW);
    expect(stats.topDomains).toHaveLength(TOP_DOMAINS);
    expect(stats.topDomains[0]).toEqual({ domain: 'big.com', count: 3 });
    expect(stats.topDomains[1]).toEqual({ domain: 'mid.com', count: 2 });
  });

  it('条数相同时按域名升序，顺序确定', () => {
    const rows = [
      row({ lemma: 'a' }, { domains: ['z.com'] }),
      row({ lemma: 'b' }, { domains: ['a.com'] }),
      row({ lemma: 'c' }, { domains: ['m.com'] }),
    ];

    expect(computeStats(rows, NOW).topDomains.map((d) => d.domain)).toEqual([
      'a.com',
      'm.com',
      'z.com',
    ]);
  });

  it('一个词在同一域名下多条例句按条数计（不是按词计）', () => {
    const rows = [row({ lemma: 'a' }, { domains: ['x.com', 'x.com', 'x.com'] })];
    expect(computeStats(rows, NOW).topDomains).toEqual([{ domain: 'x.com', count: 3 }]);
  });

  it('空域名不进榜', () => {
    const rows = [row({ lemma: 'a' }, { domains: [''] })];
    expect(computeStats(rows, NOW).topDomains).toEqual([]);
  });

  it('不足 5 个域名时有几个给几个', () => {
    const rows = [row({ lemma: 'a' }, { domains: ['only.com'] })];
    expect(computeStats(rows, NOW).topDomains).toHaveLength(1);
  });
});
