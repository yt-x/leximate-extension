/**
 * 角标刷新的单测（FR-A14）。
 *
 * 重点验两件事：
 * 1. 关闭态下**不读词数也能正确**——关掉扩展时角标必须是 `OFF`，
 *    不能因为词库读取失败就变成"没有角标"。
 * 2. `sync()` 每次都是**重新读**，不复用缓存——MV3 worker 会被回收，
 *    靠缓存会在重启后显示过期数字。
 */
import { describe, expect, it, vi } from 'vitest';
import { createBadgeSync, type BadgeEnv } from './sync';

function makeEnv(
  overrides: Partial<BadgeEnv> & { enabled?: boolean; wordCount?: number } = {},
): BadgeEnv & { written: (string | null)[] } {
  const written: (string | null)[] = [];
  const { enabled = true, wordCount = 0, ...rest } = overrides;

  return {
    written,
    getSettings: async () => ({ enabled }),
    countWords: async () => wordCount,
    setBadge: (text) => {
      written.push(text);
    },
    ...rest,
  };
}

describe('createBadgeSync', () => {
  it('开启且有词时写入数字文案', async () => {
    const env = makeEnv({ enabled: true, wordCount: 42 });
    expect(await createBadgeSync(env).sync()).toBe('42');
    expect(env.written).toEqual(['42']);
  });

  it('关闭时写入 OFF，词数为 0 也仍是 OFF', async () => {
    const env = makeEnv({ enabled: false, wordCount: 0 });
    expect(await createBadgeSync(env).sync()).toBe('OFF');
    expect(env.written).toEqual(['OFF']);
  });

  it('开启且词数为 0 时清除角标（写 null）', async () => {
    const env = makeEnv({ enabled: true, wordCount: 0 });
    expect(await createBadgeSync(env).sync()).toBeNull();
    // 关键：清除要显式调用 setBadge(null)，不能不写。
    // 不写的话上一轮的旧数字会一直留在工具栏上。
    expect(env.written).toEqual([null]);
  });

  it('每次 sync 都重新读设置与词数，不复用上一次的结果', async () => {
    let wordCount = 1;
    const getSettings = vi.fn(async () => ({ enabled: true }));
    let calls = 0;
    const env: BadgeEnv = {
      getSettings,
      countWords: async () => {
        calls += 1;
        return wordCount;
      },
      setBadge: () => {},
    };

    const sync = createBadgeSync(env);
    expect(await sync.sync()).toBe('1');

    wordCount = 7;
    expect(await sync.sync()).toBe('7');

    expect(calls).toBe(2);
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('开关在两次 sync 之间翻转时角标跟着变', async () => {
    let enabled = true;
    const written: (string | null)[] = [];
    const sync = createBadgeSync({
      getSettings: async () => ({ enabled }),
      countWords: async () => 15,
      setBadge: (t) => {
        written.push(t);
      },
    });

    await sync.sync();
    enabled = false;
    await sync.sync();
    enabled = true;
    await sync.sync();

    expect(written).toEqual(['15', 'OFF', '15']);
  });

  it('并发调用不互相覆盖（每次都独立读写）', async () => {
    const written: (string | null)[] = [];
    const sync = createBadgeSync({
      getSettings: async () => ({ enabled: true }),
      countWords: async () => 3,
      setBadge: (t) => {
        written.push(t);
      },
    });

    await Promise.all([sync.sync(), sync.sync()]);
    expect(written).toEqual(['3', '3']);
  });

  it('词数读取失败时向上抛，不静默写成错误角标', async () => {
    const env = makeEnv({
      enabled: true,
      countWords: async () => {
        throw new Error('IndexedDB 不可用');
      },
    });

    // 抛出去由入口统一 catch 并记诊断日志（FR-L4），
    // 而不是在这里假装词数是 0（那会错误地清掉角标）
    await expect(createBadgeSync(env).sync()).rejects.toThrow('IndexedDB 不可用');
    expect(env.written).toEqual([]);
  });
});
