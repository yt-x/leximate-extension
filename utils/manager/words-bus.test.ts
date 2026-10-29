/**
 * "词库变了"的进程内通知（FR-E7 的界面联动）。
 *
 * 为什么需要：管理台的两个页面**同时挂载**（`App.tsx` 用 `hidden` 切换，
 * 为的是切换时保住列表的滚动位置与筛选，见 FR-F7）。于是设置页清空数据之后，
 * 一直挂着的 `WordList` 手里还是旧行——切回"生词"会看到已经删掉的词。
 *
 * 与 `settings-bus.ts` 是同一手法：**只做本上下文内的通知**，不碰任何浏览器 API。
 */
import { describe, expect, it, vi } from 'vitest';
import { notifyWordsChanged, onWordsChanged, resetWordsListeners } from './words-bus';

describe('onWordsChanged / notifyWordsChanged', () => {
  it('通知到所有订阅者', () => {
    resetWordsListeners();
    const a = vi.fn();
    const b = vi.fn();
    onWordsChanged(a);
    onWordsChanged(b);

    notifyWordsChanged();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('取消订阅后不再收到', () => {
    resetWordsListeners();
    const handler = vi.fn();
    const off = onWordsChanged(handler);

    off();
    notifyWordsChanged();

    expect(handler).not.toHaveBeenCalled();
  });

  it('一个订阅者抛错不影响其它订阅者，也不上抛', () => {
    resetWordsListeners();
    const good = vi.fn();
    onWordsChanged(() => {
      throw new Error('boom');
    });
    onWordsChanged(good);

    expect(() => notifyWordsChanged()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('没有订阅者时通知是空操作', () => {
    resetWordsListeners();
    expect(() => notifyWordsChanged()).not.toThrow();
  });
});
