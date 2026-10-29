/**
 * 弹窗定位（PLAN.md FR-A1、FR-A7）。
 *
 * 规格的硬性约束（§1.A）：
 * - 弹窗须**完全落在视口内**（任一边都不许溢出）
 * - **不遮挡被划的词**
 *
 * 这是纯几何计算，不碰 DOM——因此可以在 Node 里把所有边界情况逐条测掉。
 * 真实 DOM 只负责提供数字（视口尺寸、选区矩形、弹窗尺寸）。
 *
 * 关于选区矩形：用 `range.getClientRects()` 的**首个**矩形而不是
 * `getBoundingClientRect()`。后者跨多行时会返回横跨两行的包围盒，
 * 用它定位会让弹窗跑到两行中间而不是贴着被划的词
 * （见 `docs/reference/selection-and-range.md` §5.2）。
 */

/** 矩形，语义同 `DOMRect` 里我们用到的部分 */
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PopupSize {
  width: number;
  height: number;
}

export interface PopupPosition {
  top: number;
  left: number;
  /** 弹窗在上面还是下面，供渲染层决定箭头方向 */
  placement: 'above' | 'below';
  /** 实际应当使用的尺寸（可能已被压缩到视口能容纳的范围） */
  size: PopupSize;
}

/** 弹窗矩形，用于判断"是否遮挡被划的词"（测试与诊断用） */
export function popupRect(position: PopupPosition): Rect {
  return {
    top: position.top,
    left: position.left,
    width: position.size.width,
    height: position.size.height,
  };
}

/** 弹窗与选区之间的间距，避免紧贴 */
export const GAP = 6;
/** 与视口边缘的最小留白 */
export const MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 弹窗在某一维上的可用上限。
 *
 * **为什么需要它**：弹窗比视口还大时，"完全落在视口内"在几何上**不可能**成立。
 * 硬判据总会有一个反例，所以规格的那条硬约束必须补一个前置条件——
 * 弹窗尺寸要**先被约束到视口能容纳的范围**。这个函数就是那个约束。
 *
 * 真实情况下这只在很小的视口（或用户把线宽/字号调得极大）才会触发；
 * 触发时的行为是"贴着视口边距、尺寸被压缩到能放下"，而不是溢出到看不见。
 */
export function clampPopupSize(
  popup: PopupSize,
  viewport: Viewport,
  margin = MARGIN,
): PopupSize {
  return {
    width: Math.max(0, Math.min(popup.width, viewport.width - margin * 2)),
    height: Math.max(0, Math.min(popup.height, viewport.height - margin * 2)),
  };
}

/**
 * 算出弹窗位置。
 *
 * 策略：**默认放在选区下方**；下方空间不够就翻到上方；上下都不够就选空间大的那一侧，
 * 并把弹窗夹进视口内。没有一种情况会让弹窗溢出视口——"完全落在视口内"是硬约束，
 * 因此最后一定会 clamp。
 *
 * **若弹窗本身比视口大**，先按 `clampPopupSize` 压到能容纳的尺寸。
 * 调用方应当把返回的位置与压缩后的尺寸一起用（`positionPopup` 的返回值里带了 `size`）。
 */
export function positionPopup(
  anchor: Rect,
  popupInput: PopupSize,
  viewport: Viewport,
): PopupPosition {
  const popup = clampPopupSize(popupInput, viewport);
  const spaceBelow = viewport.height - (anchor.top + anchor.height);
  const spaceAbove = anchor.top;

  // 下方放得下就放下方，否则翻到上方（规格里"不遮挡被划的词"的直接体现）
  const needed = popup.height + GAP + MARGIN;
  let placement: 'above' | 'below';
  if (spaceBelow >= needed) {
    placement = 'below';
  } else if (spaceAbove >= needed) {
    placement = 'above';
  } else {
    // 两侧都不够：选空间大的一侧，靠 clamp 保证不溢出
    placement = spaceBelow >= spaceAbove ? 'below' : 'above';
  }

  const rawTop =
    placement === 'below' ? anchor.top + anchor.height + GAP : anchor.top - popup.height - GAP;
  const top = clamp(rawTop, MARGIN, viewport.height - popup.height - MARGIN);

  // 水平方向：与被划的词左对齐，超出视口就夹回来
  const centered = anchor.left + anchor.width / 2 - popup.width / 2;
  const left = clamp(centered, MARGIN, viewport.width - popup.width - MARGIN);

  return { top, left, placement, size: popup };
}

/** 两个矩形是否相交 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  );
}

/**
 * 滚动阈值判定（FR-A7）。
 *
 * 规格口径：页面滚动超过 **80px**（相对弹窗出现时的位置）就关闭弹窗。
 * 用相对位移而不是绝对 `scrollY`，因为弹窗可能在页面已滚到中途时出现。
 */
export const SCROLL_CLOSE_THRESHOLD = 80;

export function scrolledTooFar(startX: number, startY: number, nowX: number, nowY: number): boolean {
  const dx = Math.abs(nowX - startX);
  const dy = Math.abs(nowY - startY);
  // 取两轴中较大的位移：横向滚动同样应当关闭
  return Math.max(dx, dy) > SCROLL_CLOSE_THRESHOLD;
}
