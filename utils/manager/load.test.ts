/**
 * 数据装载的单测（FR-F2 的"例句数"与"来源域名"两列）。
 *
 * 关键区分：
 * - `sceneCount` 是**例句条数**（重复域名也各算一条）
 * - `domains` 是**去重后的域名**（列表与筛选项用）
 * - `domainCounts` 是**域名 → 例句数**（统计 Top N 用）
 *
 * 三者用一个值代替会出错，所以这里逐条锁住。
 */
import { describe, expect, it } from 'vitest';
import { loadRows, type SceneFact } from './load';
import { makeWord } from './testing';

describe('loadRows', () => {
  it('例句数与域名去重分别正确', async () => {
    const rows = await loadRows({
      wordLoader: async () => [makeWord({ lemma: 'run', id: 'w1' })],
      sceneLoader: async (): Promise<SceneFact[]> => [
        { wordId: 'w1', domain: 'a.com' },
        { wordId: 'w1', domain: 'a.com' },
        { wordId: 'w1', domain: 'b.com' },
      ],
    });

    expect(rows).toHaveLength(1);
    // 三条例句
    expect(rows[0]!.sceneCount).toBe(3);
    // 两个站
    expect(rows[0]!.domains.sort()).toEqual(['a.com', 'b.com']);
    // 每个站的条数
    expect(rows[0]!.domainCounts).toEqual({ 'a.com': 2, 'b.com': 1 });
  });

  it('没有例句的词三项都为空', async () => {
    const rows = await loadRows({
      wordLoader: async () => [makeWord({ lemma: 'lonely', id: 'w1' })],
      sceneLoader: async () => [],
    });

    expect(rows[0]).toMatchObject({ sceneCount: 0, domains: [], domainCounts: {} });
  });

  it('例句归到正确的词上（不串词）', async () => {
    const rows = await loadRows({
      wordLoader: async () => [
        makeWord({ lemma: 'a', id: 'w1' }),
        makeWord({ lemma: 'b', id: 'w2' }),
      ],
      sceneLoader: async () => [
        { wordId: 'w1', domain: 'x.com' },
        { wordId: 'w2', domain: 'y.com' },
        { wordId: 'w2', domain: 'y.com' },
      ],
    });

    expect(rows[0]!.sceneCount).toBe(1);
    expect(rows[1]!.sceneCount).toBe(2);
    expect(rows[1]!.domains).toEqual(['y.com']);
  });

  it('孤立例句（词已不存在）不产生额外的行', async () => {
    const rows = await loadRows({
      wordLoader: async () => [makeWord({ lemma: 'a', id: 'w1' })],
      sceneLoader: async () => [{ wordId: 'ghost', domain: 'x.com' }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.sceneCount).toBe(0);
  });

  it('空域名被排除在 domains 与 domainCounts 之外', async () => {
    // domainOf 解析失败会返回空串；进筛选项会变成无法理解的空选项
    const rows = await loadRows({
      wordLoader: async () => [makeWord({ lemma: 'a', id: 'w1' })],
      sceneLoader: async () => [
        { wordId: 'w1', domain: '' },
        { wordId: 'w1', domain: 'ok.com' },
      ],
    });

    expect(rows[0]!.domains).toEqual(['ok.com']);
    expect(rows[0]!.domainCounts).toEqual({ 'ok.com': 1 });
    // sceneCount 仍按真实例句数算（空域名也是一条例句）
    expect(rows[0]!.sceneCount).toBe(2);
  });

  it('软删除的词也被装载（过滤交给纯函数层）', async () => {
    const rows = await loadRows({
      wordLoader: async () => [makeWord({ lemma: 'gone', id: 'w1', deletedAt: 5000 })],
      sceneLoader: async () => [],
    });

    // 装载层不做过滤：界面要能"显示已删除"，统计要能正确排除
    expect(rows).toHaveLength(1);
  });

  it('空数据返回空数组', async () => {
    const rows = await loadRows({ wordLoader: async () => [], sceneLoader: async () => [] });
    expect(rows).toEqual([]);
  });
});
