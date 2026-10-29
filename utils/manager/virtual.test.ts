/**
 * 虚拟滚动切片的单测（PLAN.md FR-F2 实现口径）。
 *
 * 口径原文是"1 万词滚动 60fps"，不可离线断言；
 * §1.F 把它换成**可测的等价物**：渲染行数 ≤ 可视行数 + 2 屏缓冲，与总词数无关。
 * 本文件测的就是这条。
 */
import { describe, expect, it } from 'vitest';
import type { ListRow } from './filter';
import { makeRow } from './testing';
import { computeWindow, OVERSCAN_SCREENS, scrollTopForIndex } from './virtual';

function makeRows(n: number): ListRow[] {
  return Array.from({ length: n }, (_, i) =>
    makeRow({ lemma: `word${i}`, createdAt: i, updatedAt: i }),
  );
}

const ROW_HEIGHT = 40;
const VIEWPORT = 600; // 15 行可视

describe('computeWindow（FR-F2）', () => {
  it('渲染行数与总词数无关（1 万词也只渲染一屏多）', () => {
    const rows = makeRows(10_000);
    const win = computeWindow(rows, 0, VIEWPORT, ROW_HEIGHT);

    const visibleCount = Math.ceil(VIEWPORT / ROW_HEIGHT); // 15
    const limit = visibleCount + visibleCount * OVERSCAN_SCREENS; // 15 + 30

    // §1.F 的核心断言：不进 DOM 的行数受控
    expect(win.rows.length).toBeLessThanOrEqual(limit);
    expect(win.rows.length).toBeGreaterThanOrEqual(visibleCount);
  });

  it('还没滚动时从第 0 行开始，上方无占位', () => {
    const win = computeWindow(makeRows(100), 0, VIEWPORT, ROW_HEIGHT);
    expect(win.start).toBe(0);
    expect(win.paddingTop).toBe(0);
  });

  it('滚动后窗口跟着下移，上下占位撑出正确总高', () => {
    const rows = makeRows(1000);
    const scrollTop = 10_000; // 第 250 行
    const win = computeWindow(rows, scrollTop, VIEWPORT, ROW_HEIGHT);

    expect(win.start).toBeGreaterThan(0);
    expect(win.rows[0]!.word.lemma).toBe(`word${win.start}`);

    // 占位 + 渲染行 = 完整高度，否则滚动条长度会不对
    const total = win.paddingTop + win.rows.length * ROW_HEIGHT + win.paddingBottom;
    expect(total).toBe(1000 * ROW_HEIGHT);
  });

  it('滚到底时不越界，且末尾有内容', () => {
    const rows = makeRows(100);
    const maxScroll = 100 * ROW_HEIGHT - VIEWPORT;
    const win = computeWindow(rows, maxScroll, VIEWPORT, ROW_HEIGHT);

    expect(win.end).toBe(100);
    expect(win.paddingBottom).toBe(0);
    // 最后一行必须可见，否则底部会永久露白
    expect(win.rows[win.rows.length - 1]!.word.lemma).toBe('word99');
  });

  it('滚动位置超过总高也不报错（内容变短时会发生）', () => {
    const rows = makeRows(10);
    const win = computeWindow(rows, 999_999, VIEWPORT, ROW_HEIGHT);

    expect(win.end).toBe(10);
    expect(win.paddingTop + win.rows.length * ROW_HEIGHT + win.paddingBottom).toBe(10 * ROW_HEIGHT);
  });

  it('负的滚动位置当 0 处理（浏览器回弹会给负值）', () => {
    const win = computeWindow(makeRows(100), -500, VIEWPORT, ROW_HEIGHT);
    expect(win.start).toBe(0);
    expect(win.paddingTop).toBe(0);
  });

  it('空列表返回空窗口且高度为 0', () => {
    const win = computeWindow([], 0, VIEWPORT, ROW_HEIGHT);
    expect(win.rows).toEqual([]);
    expect(win.paddingTop).toBe(0);
    expect(win.paddingBottom).toBe(0);
  });

  it('行高非法时退回全渲染而不是白屏', () => {
    // 这是界面参数错误，不该让用户看到空列表
    const rows = makeRows(5);
    expect(computeWindow(rows, 0, VIEWPORT, 0).rows).toHaveLength(5);
    expect(computeWindow(rows, 0, VIEWPORT, -1).rows).toHaveLength(5);
    expect(computeWindow(rows, 0, 0, ROW_HEIGHT).rows).toHaveLength(5);
  });

  it('切片内容与原始数组对应位置一致（没有错位）', () => {
    const rows = makeRows(500);
    const win = computeWindow(rows, 4000, VIEWPORT, ROW_HEIGHT);

    win.rows.forEach((r, i) => {
      expect(r.word.lemma).toBe(`word${win.start + i}`);
    });
  });

  it('start <= end 恒成立（不产生负长度的 slice）', () => {
    const rows = makeRows(50);
    for (const top of [0, 1, 999, 5000, 100_000]) {
      const win = computeWindow(rows, top, VIEWPORT, ROW_HEIGHT);
      expect(win.start).toBeLessThanOrEqual(win.end);
    }
  });
});

describe('scrollTopForIndex', () => {
  it('按行高换算', () => {
    expect(scrollTopForIndex(10, 40)).toBe(400);
  });

  it('负数当下标 0（不产生负的 scrollTop）', () => {
    expect(scrollTopForIndex(-5, 40)).toBe(0);
  });

  it('行高非法时返回 0', () => {
    expect(scrollTopForIndex(10, 0)).toBe(0);
  });
});
