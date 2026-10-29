/**
 * 同步冲突合并（PLAN.md FR-H3）。
 *
 * 重点是**墓碑参与同一场时间比较**这件事：写错了的典型症状是"在 B 设备加回来的词，
 * 下次同步后又被删掉"，而用例里只要覆盖「先删后改」这一格就能挡住。
 */
import { describe, expect, it } from 'vitest';
import { decideMerge, mergeRows, mergeScenes, type SyncedRow } from './merge';
import type { Scene } from '../db/types';

const row = (id: string, updatedAt: number, deletedAt: number | null = null): SyncedRow => ({
  id,
  updatedAt,
  deletedAt,
});

describe('decideMerge：后写胜出', () => {
  it('只有一边有 → 那一边赢', () => {
    expect(decideMerge(row('a', 1), undefined)?.winner).toBe('local');
    expect(decideMerge(undefined, row('a', 1))?.winner).toBe('remote');
    expect(decideMerge(undefined, undefined)).toBeNull();
  });

  it('时间新的赢', () => {
    expect(decideMerge(row('a', 20), row('a', 10))?.winner).toBe('local');
    expect(decideMerge(row('a', 10), row('a', 20))?.winner).toBe('remote');
  });

  it('本地有墓碑但更旧 → 远端（未删）赢：加回来的词不该被旧墓碑删掉', () => {
    const decision = decideMerge(row('a', 10, 10), row('a', 20, null));
    expect(decision?.winner).toBe('remote');
  });

  it('本地未删且更新 → 本地赢：后写胜出对删除同样成立', () => {
    const decision = decideMerge(row('a', 20, null), row('a', 10, 10));
    expect(decision?.winner).toBe('local');
  });

  it('远端墓碑更新 → 远端赢（删除被同步过来）', () => {
    const decision = decideMerge(row('a', 10, null), row('a', 20, 20));
    expect(decision?.winner).toBe('remote');
  });

  it('时间相同且一方已删 → 墓碑赢（保守：删除不被悄悄撤销）', () => {
    expect(decideMerge(row('a', 10, 10), row('a', 10, null))).toEqual({ winner: 'local', tie: true });
    expect(decideMerge(row('a', 10, null), row('a', 10, 10))).toEqual({ winner: 'remote', tie: true });
  });

  it('完全相同 → local 且标为平局（调用方可据此跳过写入）', () => {
    expect(decideMerge(row('a', 10, 10), row('a', 10, 10))).toEqual({ winner: 'local', tie: true });
  });
});

describe('mergeRows：双端交替编辑不丢数据', () => {
  it('A 改一条、B 加一条 → 合并后两边都有', () => {
    const local = [row('a', 20, null), row('b', 5)];
    const remote = [row('a', 10, null), row('c', 15)];

    const outcome = mergeRows(local, remote);
    const ids = outcome.rows.map((r) => r.id).sort();

    expect(ids).toEqual(['a', 'b', 'c']);
    // a 取本地（更新），c 是远端新增
    expect(outcome.rows.find((r) => r.id === 'a')?.updatedAt).toBe(20);
    expect(outcome.rows.find((r) => r.id === 'c')?.updatedAt).toBe(15);
  });

  it('一端删除、另一端修改：晚的那次赢', () => {
    const deletedLater = mergeRows([row('a', 30, 30)], [row('a', 20, null)]);
    expect(deletedLater.rows[0]?.deletedAt).toBe(30);

    const editedLater = mergeRows([row('a', 20, null)], [row('a', 30, 30)]);
    expect(editedLater.rows[0]?.deletedAt).toBe(30); // 远端更晚的删除胜出
  });

  it('对称性：merge(A,B) 与 merge(B,A) 得到同一批行（时间相同按墓碑规则）', () => {
    const a = [row('x', 10, null), row('y', 20, 20), row('z', 5)];
    const b = [row('x', 10, 10), row('y', 10), row('w', 1)];

    const forward = mergeRows(a, b).rows.sort((l, r) => l.id.localeCompare(r.id));
    const backward = mergeRows(b, a).rows.sort((l, r) => l.id.localeCompare(r.id));

    expect(forward).toEqual(backward);
  });

  it('重复合并是幂等的（同一份远端导两次不会再变）', () => {
    const local = [row('a', 20, null)];
    const remote = [row('a', 10, null), row('b', 5)];

    const once = mergeRows(local, remote).rows;
    const twice = mergeRows(once, remote).rows;

    expect(twice).toEqual(once);
  });

  it('统计：新增 / 更新 / 从远端取得的条数分开报', () => {
    const outcome = mergeRows([row('a', 10), row('b', 30)], [row('a', 20), row('c', 1)]);

    expect(outcome.added).toBe(1); // c
    expect(outcome.updated).toBe(1); // a
    expect(outcome.takenFromRemote).toBe(2); // a + c
  });

  it('本地有、远端没有 → 保留本地（远端没有不代表删除）', () => {
    const outcome = mergeRows([row('only-local', 5)], []);
    expect(outcome.rows.map((r) => r.id)).toEqual(['only-local']);
  });
});

describe('mergeScenes：同 id 字段冲突确定性收敛', () => {
  const conflict = (translation: string, sourceTitle: string): Scene => ({
    id: 'same-scene-id',
    wordId: 'word-id',
    text: 'same text',
    highlightFrom: 0,
    highlightTo: 4,
    translation,
    sourceUrl: 'https://example.com',
    sourceTitle,
    domain: 'example.com',
    capturedAt: 100,
    contentHash: 'same-hash',
  });

  it('translation 与其他字段都不因 local / remote 参数顺序改变胜者', () => {
    const a = conflict('译文 A', '标题 A');
    const b = conflict('译文 B', '标题 B');

    expect(mergeScenes([a], [b], {}).rows).toEqual(mergeScenes([b], [a], {}).rows);
  });

  it('不同 id 同 contentHash 去重时也不丢非空译文', () => {
    const empty = { ...conflict('', '旧标题'), id: 'a-scene', translation: null };
    const translated = { ...conflict('译文', '新标题'), id: 'z-scene' };

    const outcome = mergeScenes([empty], [translated], {});

    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]).toMatchObject({ translation: '译文', sourceTitle: '新标题' });
  });

  it('本地物化优先更新同 id，再考虑复用同 contentHash 的其他 id', () => {
    const stale = { ...conflict('', '旧标题'), translation: null, contentHash: 'old-hash' };
    const translated = { ...conflict('译文', '新标题'), contentHash: 'new-hash' };
    const duplicate = { ...translated, id: 'other-scene', translation: null, sourceTitle: '旧标题' };

    const outcome = mergeScenes([stale, duplicate], [translated], {});

    expect(outcome.localRows).toHaveLength(1);
    expect(outcome.localRows[0]).toMatchObject({ id: stale.id, translation: '译文', contentHash: 'new-hash' });
  });

  it('平局采用代码单元顺序，不受设备 locale 影响', () => {
    const upper = conflict('Z', 'same');
    const lower = conflict('a', 'same');

    expect(mergeScenes([upper], [lower], {}).rows[0]?.translation).toBe('Z');
    expect(mergeScenes([lower], [upper], {}).rows[0]?.translation).toBe('Z');
  });

  it('别名查询不把 Object.prototype 成员当成重定向', () => {
    const inheritedName = { ...conflict('译文', '标题'), wordId: 'toString' };

    const outcome = mergeScenes([inheritedName], [], {});

    expect(outcome.rows[0]?.wordId).toBe('toString');
    expect(outcome.rows[0]?.contentHash).toBe(inheritedName.contentHash);
  });
});
