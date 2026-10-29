/**
 * 选中集的单测（PLAN.md FR-F6）。
 *
 * 核心语义：**存 id 而非下标**。因此换筛选/排序后选中项不漂移——
 * 若存下标，"按时间排序"切成"按次数排序"会让用户勾的词变成另一批，
 * 而界面上完全看不出来。这条必须锁住。
 */
import { describe, expect, it } from 'vitest';
import {
  BULK_STATUSES,
  clearSelection,
  deleteConfirmText,
  deselectAll,
  emptySelection,
  idsOf,
  isAllSelected,
  liveIds,
  selectAll,
  staleIds,
  toggleOne,
} from './selection';

describe('基本操作', () => {
  it('空选中集', () => {
    expect(emptySelection().size).toBe(0);
  });

  it('toggleOne 加入再移除', () => {
    const a = toggleOne(emptySelection(), 'x');
    expect([...a]).toEqual(['x']);

    const b = toggleOne(a, 'x');
    expect(b.size).toBe(0);
  });

  it('selectAll 是并集而非替换（跨筛选多选生效）', () => {
    // FR-F6 要求"全选与跨筛选多选都生效"：
    // 先筛 A 勾几个、再筛 B 勾几个，两批都要在
    const first = selectAll(emptySelection(), ['a', 'b']);
    const second = selectAll(first, ['c']);

    expect([...second].sort()).toEqual(['a', 'b', 'c']);
  });

  it('deselectAll 只移除给定的，保留其余', () => {
    const sel = selectAll(emptySelection(), ['a', 'b', 'c']);
    expect([...deselectAll(sel, ['b'])].sort()).toEqual(['a', 'c']);
  });

  it('clearSelection 清空', () => {
    const sel = selectAll(emptySelection(), ['a']);
    expect(clearSelection().size).toBe(0);
    expect(sel.size).toBe(1);
  });

  it('isAllSelected：空列表返回 false 而不是"全部选中"', () => {
    // 返回 true 会让"全选"复选框在空列表上显示为已勾选
    expect(isAllSelected(emptySelection(), [])).toBe(false);
    expect(isAllSelected(emptySelection(), ['a'])).toBe(false);
  });

  it('isAllSelected：全部命中才 true', () => {
    const sel = selectAll(emptySelection(), ['a', 'b']);
    expect(isAllSelected(sel, ['a', 'b'])).toBe(true);
    expect(isAllSelected(sel, ['a', 'b', 'c'])).toBe(false);
  });

  it('不可变：原选中集不被改动', () => {
    const original = selectAll(emptySelection(), ['a']);
    toggleOne(original, 'b');
    deselectAll(original, ['a']);

    expect([...original]).toEqual(['a']);
  });
});

describe('存活判定（跨筛选/删除后的对账）', () => {
  it('liveIds 只保留仍存在的', () => {
    const sel = selectAll(emptySelection(), ['a', 'b', 'c']);
    expect(liveIds(sel, ['a', 'c', 'd']).sort()).toEqual(['a', 'c']);
  });

  it('staleIds 找出已消失的，供界面提示', () => {
    // 用户勾了 3 个、在别处删掉 1 个；界面若不提示会显示"已选 3"实际只有 2
    const sel = selectAll(emptySelection(), ['a', 'b', 'c']);
    expect(staleIds(sel, ['a', 'c'])).toEqual(['b']);
  });

  it('liveIds + staleIds = 原选中集', () => {
    const sel = selectAll(emptySelection(), ['a', 'b', 'c']);
    const existing = ['a', 'c'];

    expect(liveIds(sel, existing).length + staleIds(sel, existing).length).toBe(sel.size);
  });

  it('全都不存在时 liveIds 为空、staleIds 保留全部', () => {
    const sel = selectAll(emptySelection(), ['a', 'b']);
    expect(liveIds(sel, [])).toEqual([]);
    expect(staleIds(sel, []).sort()).toEqual(['a', 'b']);
  });
});

describe('idsOf', () => {
  it('抽出行里的 id', () => {
    expect(idsOf([{ word: { id: 'x' } }, { word: { id: 'y' } }])).toEqual(['x', 'y']);
  });

  it('空数组返回空', () => {
    expect(idsOf([])).toEqual([]);
  });
});

describe('deleteConfirmText（FR-F6 二次确认）', () => {
  it('文案里带着条数', () => {
    // §1.F 定的是"展示将要删除的条数并要求再点一次"
    expect(deleteConfirmText(3)).toContain('3');
  });

  it('说明不可撤销', () => {
    expect(deleteConfirmText(1)).toContain('不可撤销');
  });

  it('条数为 0 或负数时返回空串（界面据此不显示确认）', () => {
    expect(deleteConfirmText(0)).toBe('');
    expect(deleteConfirmText(-1)).toBe('');
  });
});

describe('BULK_STATUSES', () => {
  it('三种状态都可批量设置，含 ignored（否则没有"批量取消忽略"的入口）', () => {
    expect([...BULK_STATUSES].sort()).toEqual(['ignored', 'known', 'new']);
  });
});
