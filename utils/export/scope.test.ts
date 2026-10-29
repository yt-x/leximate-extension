/**
 * 导出范围（PLAN.md FR-G1）的测试。
 *
 * 三个范围最容易写成同一个实现——"反正都是 rows"——所以每条都要有
 * **能区分它们**的断言：筛选后 `all` 与 `filtered` 必须给出不同的行数，
 * 而 `selected` 必须跨筛选生效（FR-F6 的原话）。
 */
import { describe, expect, it } from 'vitest';
import { makeRow } from '../manager/testing';
import { EXPORT_SCOPES, pickRows, scopeCounts } from './scope';

const alpha = makeRow({ lemma: 'alpha' });
const beta = makeRow({ lemma: 'beta' });
const gamma = makeRow({ lemma: 'gamma' });

const rows = [alpha, beta, gamma];
/** 当前筛选结果：只剩 gamma 与 alpha，且顺序已经变了 */
const filtered = [gamma, alpha];

describe('三种范围', () => {
  it('all：库里活着的全部词，与当前筛选无关', () => {
    const picked = pickRows({ rows, filtered, scope: 'all', selection: new Set<string>() });
    expect(picked.map((row) => row.word.lemma)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('filtered：就是列表当前展示的那批，顺序照旧', () => {
    const picked = pickRows({ rows, filtered, scope: 'filtered', selection: new Set<string>() });
    expect(picked.map((row) => row.word.lemma)).toEqual(['gamma', 'alpha']);
  });

  it('selected：跨筛选生效——换筛选前勾的词也在内（FR-F6）', () => {
    // beta 不在 filtered 里（被筛掉了），但它仍被勾选着
    const selection = new Set([beta.word.id, gamma.word.id]);
    const picked = pickRows({ rows, filtered, scope: 'selected', selection });
    // 顺序取列表顺序，不取勾选顺序
    expect(picked.map((row) => row.word.lemma)).toEqual(['beta', 'gamma']);
  });

  it('选中集里的过期 id（词已在别处删掉）被忽略，不报错也不计入', () => {
    const selection = new Set([alpha.word.id, 'already-gone']);
    const picked = pickRows({ rows, filtered, scope: 'selected', selection });
    expect(picked.map((row) => row.word.lemma)).toEqual(['alpha']);
  });

  it('scopeCounts 给出的三个数字与 pickRows 完全一致', () => {
    const selection = new Set([beta.word.id]);
    const counts = scopeCounts({ rows, filtered, selection });
    expect(counts).toEqual({ all: 3, filtered: 2, selected: 1 });
    for (const item of EXPORT_SCOPES) {
      expect(pickRows({ rows, filtered, scope: item.value, selection })).toHaveLength(
        counts[item.value],
      );
    }
  });
});
