/**
 * 弹窗定位的单测（PLAN.md FR-A1、FR-A7）。
 *
 * 两条硬约束在这里逐条验收：
 * - 「弹窗须完全落在视口内」——所有用例都断言不溢出
 * - 「不遮挡被划的词」——默认放下方，下方不够翻上方，且两矩形不相交
 */
import { describe, expect, it } from 'vitest';
import {
  clampPopupSize,
  GAP,
  MARGIN,
  popupRect,
  positionPopup,
  rectsOverlap,
  SCROLL_CLOSE_THRESHOLD,
  scrolledTooFar,
  type PopupPosition,
  type Rect,
} from './position';

const viewport = { width: 1000, height: 800 };
const popup = { width: 320, height: 200 };

/** 断言弹窗完全落在视口内（FR-A1 的硬约束），用实际生效的尺寸 */
function expectInsideViewport(pos: PopupPosition, vp = viewport) {
  expect(pos.left).toBeGreaterThanOrEqual(MARGIN - 0.001);
  expect(pos.top).toBeGreaterThanOrEqual(MARGIN - 0.001);
  expect(pos.left + pos.size.width).toBeLessThanOrEqual(vp.width - MARGIN + 0.001);
  expect(pos.top + pos.size.height).toBeLessThanOrEqual(vp.height - MARGIN + 0.001);
}

describe('FR-A1：默认放在选区下方', () => {
  it('空间充足时在下方且水平居中', () => {
    const anchor: Rect = { top: 100, left: 400, width: 60, height: 20 };
    const pos = positionPopup(anchor, popup, viewport);
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(100 + 20 + GAP);
    expect(pos.left).toBe(400 + 30 - 160); // 选区中心 430，减去半个弹窗宽
  });

  it('不遮挡被划的词', () => {
    const anchor: Rect = { top: 100, left: 400, width: 60, height: 20 };
    const pos = positionPopup(anchor, popup, viewport);
    expect(rectsOverlap(popupRect(pos), anchor)).toBe(false);
  });
});

describe('FR-A1：下方不够就翻到上方', () => {
  it('靠近视口底部时翻到上方', () => {
    const anchor: Rect = { top: 700, left: 400, width: 60, height: 20 };
    const pos = positionPopup(anchor, popup, viewport);
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(700 - 200 - GAP);
    expectInsideViewport(pos);
  });

  it('翻到上方后仍不遮挡被划的词', () => {
    const anchor: Rect = { top: 700, left: 400, width: 60, height: 20 };
    const pos = positionPopup(anchor, popup, viewport);
    expect(rectsOverlap(popupRect(pos), anchor)).toBe(false);
  });

  it('贴着底边时也不溢出', () => {
    const anchor: Rect = { top: 790, left: 400, width: 60, height: 10 };
    expectInsideViewport(positionPopup(anchor, popup, viewport));
  });
});

describe('FR-A1：上下都不够时选空间大的一侧并夹进视口', () => {
  it('视口比弹窗还矮时被压缩后仍不溢出', () => {
    const tiny = { width: 400, height: 150 };
    const anchor: Rect = { top: 70, left: 100, width: 40, height: 10 };
    const pos = positionPopup(anchor, popup, tiny);
    // 弹窗被压到视口能容纳的高度
    expect(pos.size.height).toBe(150 - MARGIN * 2);
    expectInsideViewport(pos, tiny);
  });

  it('弹窗比视口还高时退化为贴住上边距（不崩）', () => {
    const tiny = { width: 400, height: 100 };
    const pos = positionPopup({ top: 50, left: 10, width: 10, height: 10 }, popup, tiny);
    expect(pos.top).toBe(MARGIN);
  });
});

describe('FR-A1：弹窗尺寸的先决约束', () => {
  it('能容纳时不改尺寸', () => {
    expect(clampPopupSize(popup, viewport)).toEqual(popup);
  });

  it('超出视口时被压到能容纳的范围', () => {
    const small = { width: 300, height: 400 };
    expect(clampPopupSize({ width: 500, height: 900 }, small)).toEqual({
      width: 300 - MARGIN * 2,
      height: 400 - MARGIN * 2,
    });
  });

  it('视口小到连边距都放不下时不会给出负数', () => {
    expect(clampPopupSize({ width: 500, height: 500 }, { width: 10, height: 10 })).toEqual({
      width: 0,
      height: 0,
    });
  });
});

describe('FR-A1：水平方向不出视口', () => {
  it('紧贴左边时被夹回来', () => {
    const anchor: Rect = { top: 100, left: 0, width: 20, height: 20 };
    const pos = positionPopup(anchor, popup, viewport);
    expect(pos.left).toBe(MARGIN);
    expectInsideViewport(pos);
  });

  it('紧贴右边时被夹回来', () => {
    const anchor: Rect = { top: 100, left: 980, width: 20, height: 20 };
    const pos = positionPopup(anchor, popup, viewport);
    expect(pos.left).toBe(viewport.width - popup.width - MARGIN);
    expectInsideViewport(pos);
  });

  it('窄视口里也不溢出', () => {
    const narrow = { width: 300, height: 800 };
    expectInsideViewport(positionPopup({ top: 100, left: 150, width: 20, height: 20 }, popup, narrow), narrow);
  });
});

describe('FR-A1：作为硬约束——遍历一批位置断言永不溢出', () => {
  it('网格遍历锚点，全部落在视口内', () => {
    const sizes = [
      { width: 320, height: 200 },
      { width: 200, height: 400 },
      { width: 460, height: 120 },
    ];
    for (let top = -20; top <= 820; top += 80) {
      for (let left = -20; left <= 1020; left += 100) {
        for (const size of sizes) {
          const pos = positionPopup({ top, left, width: 50, height: 18 }, size, viewport);
          expect(pos.left).toBeGreaterThanOrEqual(MARGIN - 0.001);
          expect(pos.left + pos.size.width).toBeLessThanOrEqual(viewport.width - MARGIN + 0.001);
          expect(pos.top + pos.size.height).toBeLessThanOrEqual(viewport.height - MARGIN + 0.001);
        }
      }
    }
  });

  it('遍历一批视口尺寸（含极小视口），全部不溢出', () => {
    const viewports = [
      { width: 320, height: 240 },
      { width: 400, height: 150 },
      { width: 200, height: 900 },
      { width: 1920, height: 1080 },
    ];
    for (const vp of viewports) {
      for (const anchorTop of [-50, 0, 60, 140, 800]) {
        const pos = positionPopup({ top: anchorTop, left: 30, width: 40, height: 18 }, popup, vp);
        expect(pos.left).toBeGreaterThanOrEqual(MARGIN - 0.001);
        expect(pos.left + pos.size.width).toBeLessThanOrEqual(vp.width - MARGIN + 0.001);
        expect(pos.top + pos.size.height).toBeLessThanOrEqual(vp.height - MARGIN + 0.001);
      }
    }
  });
});

describe('FR-A7：滚动超过 80px 关闭', () => {
  it('阈值内不关', () => {
    expect(scrolledTooFar(0, 0, 0, 80)).toBe(false);
    expect(scrolledTooFar(0, 0, 0, 79)).toBe(false);
    expect(scrolledTooFar(100, 100, 180, 100)).toBe(false);
  });

  it('超过阈值关闭', () => {
    expect(scrolledTooFar(0, 0, 0, 81)).toBe(true);
    expect(scrolledTooFar(0, 0, 0, -81)).toBe(true);
    expect(scrolledTooFar(0, 0, 200, 0)).toBe(true); // 横向也算
  });

  it('取两轴中较大的位移', () => {
    expect(scrolledTooFar(0, 0, 50, 100)).toBe(true); // 纵向超了
    expect(scrolledTooFar(0, 0, 50, 50)).toBe(false); // 都没超
  });

  it('阈值是 80', () => {
    expect(SCROLL_CLOSE_THRESHOLD).toBe(80);
  });

  it('相对位移而非绝对坐标：起滚点不同结果相同', () => {
    expect(scrolledTooFar(500, 500, 500, 600)).toBe(scrolledTooFar(0, 0, 0, 100));
  });
});
