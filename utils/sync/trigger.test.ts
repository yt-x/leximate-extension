/**
 * 同步触发的判定与合并窗口（PLAN.md FR-H4）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHANGE_DELAY_MS,
  createChangeWindow,
  shouldRunSync,
  type SyncTriggerState,
} from './trigger';

const state = (over: Partial<SyncTriggerState> = {}): SyncTriggerState => ({
  lastRunAt: 0,
  minIntervalMs: 60_000,
  ...over,
});

const base = { now: 1000, state: state(), configured: true, running: false } as const;

describe('shouldRunSync', () => {
  it('没配置 WebDAV → 三种触发都不跑', () => {
    for (const kind of ['manual', 'alarm', 'change'] as const) {
      expect(shouldRunSync({ ...base, kind, configured: false })).toEqual({
        run: false,
        reason: 'not-configured',
      });
    }
  });

  it('正在跑 → 不重入', () => {
    expect(shouldRunSync({ ...base, kind: 'manual', running: true })).toEqual({ run: false, reason: 'running' });
  });

  it('手动触发不受最短间隔限制（否则用户会以为按钮坏了）', () => {
    expect(shouldRunSync({ ...base, kind: 'manual', state: state({ lastRunAt: 999 }) })).toEqual({ run: true });
  });

  it('定时与变更：距上次不足间隔就等，并给出最早时刻', () => {
    const s = state({ lastRunAt: 100_000, minIntervalMs: 60_000 });
    for (const kind of ['alarm', 'change'] as const) {
      expect(shouldRunSync({ ...base, kind, now: 120_000, state: s })).toEqual({
        run: false,
        reason: 'too-soon',
        nextAllowedAt: 160_000,
      });
    }
  });

  it('超过间隔就允许', () => {
    const s = state({ lastRunAt: 100_000, minIntervalMs: 60_000 });
    expect(shouldRunSync({ ...base, kind: 'alarm', now: 160_000, state: s })).toEqual({ run: true });
  });
});

describe('createChangeWindow：连续变更合并成一次', () => {
  it('第一次排窗口，之后同一窗口内再来的变更不再推后', () => {
    const window = createChangeWindow();

    const first = window.schedule(1000, DEFAULT_CHANGE_DELAY_MS);
    const second = window.schedule(2000, DEFAULT_CHANGE_DELAY_MS);
    const third = window.schedule(5000, DEFAULT_CHANGE_DELAY_MS);

    expect(first).toEqual({ dueAt: 1000 + DEFAULT_CHANGE_DELAY_MS, alreadyScheduled: false });
    // 关键：不因为后来的变更而顺延，否则连续划词会让同步永远推迟
    expect(second).toEqual({ dueAt: first.dueAt, alreadyScheduled: true });
    expect(third).toEqual({ dueAt: first.dueAt, alreadyScheduled: true });
    expect(window.pendingAt).toBe(first.dueAt);
  });

  it('到点判断', () => {
    const window = createChangeWindow();
    const { dueAt } = window.schedule(1000, 30_000);

    expect(window.isDue(dueAt - 1)).toBe(false);
    expect(window.isDue(dueAt)).toBe(true);
  });

  it('跑完清空之后可以再排新窗口', () => {
    const window = createChangeWindow();
    window.schedule(1000, 30_000);
    window.clear();

    expect(window.pendingAt).toBeNull();
    expect(window.isDue(999_999)).toBe(false);

    const again = window.schedule(50_000, 30_000);
    expect(again.alreadyScheduled).toBe(false);
    expect(again.dueAt).toBe(80_000);
  });

  it('没有待跑时 isDue 恒为 false（不会因为 now 很大就误触发）', () => {
    expect(createChangeWindow().isDue(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
