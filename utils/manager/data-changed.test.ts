/**
 * 管理台侧"数据变了"的通知单测（PLAN.md FR-A14）。
 *
 * 为什么需要它：角标是**全局**的（`action.setBadgeText` 不带 tabId），
 * 只有后台调 `badge.sync()` 才会变。而管理台是另一个页面，
 * 它删词/改状态是**直接写扩展源的 IndexedDB**的——后台不知道，
 * 角标就一直停在旧数字上（用户看到的现象：清空生词、刷新页面，角标照旧）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createDataChangeNotifier } from './data-changed';
import { MSG } from '../content/messages';

describe('通知后台"数据变了"', () => {
  it('发出 data-changed 消息', async () => {
    const sendToBackground = vi.fn(async () => undefined);
    const notify = createDataChangeNotifier({ sendToBackground });

    await expect(notify()).resolves.toBe(true);

    expect(sendToBackground).toHaveBeenCalledWith({ type: MSG.dataChanged });
  });

  it('后台不可达时返回 false 而不抛（写库已经成功，通知失败不该让界面报错）', async () => {
    const notify = createDataChangeNotifier({
      sendToBackground: async () => {
        throw new Error('Receiving end does not exist');
      },
    });

    await expect(notify()).resolves.toBe(false);
  });
});
