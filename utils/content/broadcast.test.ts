/**
 * 后台 → 内容脚本投递的单测（FR-A14）。
 *
 * 这个模块存在的理由就是一个 API 事实：`runtime.sendMessage` **不能**
 * 投递给内容脚本，必须 `tabs.sendMessage` 逐个标签页
 * （`docs/reference/extension-storage-and-messaging.md` §2）。
 */
import { describe, expect, it } from 'vitest';
import { broadcastToTabs, planBroadcast, type BroadcastEnv } from './broadcast';
import { MSG, type SettingsChangedNotice } from './messages';
import type { TabNotice } from './broadcast';

const notice: SettingsChangedNotice = { type: MSG.settingsChanged, settings: { enabled: false } };

function makeEnv(tabIds: number[], failFor: number[] = []): BroadcastEnv & { sent: number[] } {
  const sent: number[] = [];
  return {
    sent,
    listTabIds: async () => tabIds,
    sendToTab: async (tabId) => {
      sent.push(tabId);
      return !failFor.includes(tabId);
    },
  };
}

describe('planBroadcast', () => {
  it('去重并保持顺序', () => {
    expect(planBroadcast([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });

  it('滤掉非法 id', () => {
    expect(planBroadcast([1, -1, 1.5, NaN, 2])).toEqual([1, 2]);
  });

  it('空输入返回空', () => {
    expect(planBroadcast([])).toEqual([]);
  });
});

describe('broadcastToTabs', () => {
  it('逐页投递并统计成功数', async () => {
    const env = makeEnv([1, 2, 3]);
    const result = await broadcastToTabs(notice, env);

    expect(env.sent).toEqual([1, 2, 3]);
    expect(result).toEqual({ attempted: 3, delivered: 3, failed: [] });
  });

  it('一个页面投递失败不影响其它页面', async () => {
    // 场景很常见：某个标签页没有内容脚本（chrome:// 或未匹配的页面）
    const env = makeEnv([1, 2, 3], [2]);
    const result = await broadcastToTabs(notice, env);

    expect(env.sent).toEqual([1, 2, 3]); // 仍然尝试了全部
    expect(result.delivered).toBe(2);
    expect(result.failed).toEqual([2]);
  });

  it('sendToTab 抛错被吞掉并记为失败', async () => {
    const env: BroadcastEnv = {
      listTabIds: async () => [7],
      sendToTab: async () => {
        throw new Error('Could not establish connection');
      },
    };

    const result = await broadcastToTabs(notice, env);
    expect(result).toEqual({ attempted: 1, delivered: 0, failed: [7] });
  });

  it('没有标签页时投递数为 0，不抛错', async () => {
    const env = makeEnv([]);
    const result = await broadcastToTabs(notice, env);
    expect(result).toEqual({ attempted: 0, delivered: 0, failed: [] });
  });

  it('listTabIds 抛错时上抛（枚举失败是异常，不该伪装成"没有标签页"）', async () => {
    const env: BroadcastEnv = {
      listTabIds: async () => {
        throw new Error('tabs API unavailable');
      },
      sendToTab: async () => true,
    };

    await expect(broadcastToTabs(notice, env)).rejects.toThrow('tabs API unavailable');
  });

  it('通知里带上设置内容，收方不必再问一次', async () => {
    const seen: TabNotice[] = [];
    const env: BroadcastEnv = {
      listTabIds: async () => [1],
      sendToTab: async (_id, n) => {
        seen.push(n);
        return true;
      },
    };

    await broadcastToTabs(notice, env);
    expect(seen).toEqual([notice]);
  });
});
