/**
 * 虚拟滚动的切片计算（PLAN.md FR-F2）。
 *
 * 纯函数：给定总行数、行高、滚动位置与视口高度，算出该渲染哪一段。
 * 不碰 DOM——因此 §1.F 的口径「渲染行数 ≤ 可视行数 + 2 屏缓冲」
 * 可以在无浏览器环境直接断言。
 *
 * **为什么自己写而不引 `react-window`**：行高固定、数据已在内存，
 * 核心就是一次 `slice`。引库要为一个 40 行的函数增加依赖、包体积与供应链面。
 */
import type { ListRow } from './filter';

/** 视口外多渲染几屏，避免快速滚动时露白 */
export const OVERSCAN_SCREENS = 2;

export interface VirtualWindow {
  /** 起始行下标（含） */
  start: number;
  /** 结束行下标（不含） */
  end: number;
  /** 上方占位高度，撑出滚动条 */
  paddingTop: number;
  /** 下方占位高度 */
  paddingBottom: number;
  /** 渲染出来的行 */
  rows: ListRow[];
}

/**
 * 计算当前应渲染的窗口。
 *
 * 边界处理是这里最容易错的地方，所以都显式兜住：
 * - 空列表 → 全部为 0，不产生负数高度
 * - 滚动位置为负（部分浏览器在回弹时会给负值）→ 当 0
 * - 滚动到底 → `end` 不越过总数
 */
export function computeWindow(
  rows: readonly ListRow[],
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): VirtualWindow {
  const total = rows.length;

  // 行高为 0 或负数会让下面的除法失去意义；退回"全渲染"而不是抛错，
  // 因为这是界面参数而非数据错误，界面不该因此白屏
  if (rowHeight <= 0 || total === 0 || viewportHeight <= 0) {
    return { start: 0, end: total, paddingTop: 0, paddingBottom: 0, rows: [...rows] };
  }

  const safeScrollTop = Math.max(0, scrollTop);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const overscan = visibleCount * OVERSCAN_SCREENS;

  const rawStart = Math.floor(safeScrollTop / rowHeight) - overscan;
  const rawEnd = Math.floor(safeScrollTop / rowHeight) + visibleCount + overscan;

  const start = Math.max(0, Math.min(rawStart, total));
  const end = Math.max(start, Math.min(rawEnd, total));

  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: (total - end) * rowHeight,
    rows: rows.slice(start, end),
  };
}

/** 滚动到指定行时的 `scrollTop`（FR-F7 打开详情后要能定位回来） */
export function scrollTopForIndex(index: number, rowHeight: number): number {
  if (rowHeight <= 0) return 0;
  return Math.max(0, index) * rowHeight;
}
