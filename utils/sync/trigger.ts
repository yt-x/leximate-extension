/**
 * 同步触发（PLAN.md FR-H4）。
 *
 * 三种触发，共用一条"要不要真的跑"的判定：
 *  - **手动**：一定跑（用户点的就是它）；
 *  - **定时**（`chrome.alarms`）：按周期跑；
 *  - **变更后延迟**：连续划词要**合并**成一次上传，否则一次拖选会连着传五份。
 *
 * 这一层是纯逻辑（不碰 chrome API、不碰计时器）：延迟窗口由调用方用 `setTimeout` 驱动，
 * 这里只回答"现在该不该跑、下次最早什么时候能跑"。
 */

export interface SyncTriggerState {
  /** 上次真正开始同步的时刻 */
  lastRunAt: number;
  /** 上次结束后到下次允许的最短间隔（毫秒） */
  minIntervalMs: number;
}

/** 默认最短间隔：60 秒。坚果云对同一文件连写有频率限制，这个值同时也是它的保护 */
export const DEFAULT_MIN_INTERVAL_MS = 60_000;

export type SyncTriggerKind = 'manual' | 'alarm' | 'change';

export interface ShouldRunInput {
  kind: SyncTriggerKind;
  now: number;
  state: SyncTriggerState;
  /** 同步是否已配置（没有 WebDAV 配置时三种触发都不该跑） */
  configured: boolean;
  /** 是否正在跑（上一次还没结束） */
  running: boolean;
}

export interface ShouldRunResult {
  run: boolean;
  /** 不跑的原因，写进诊断日志便于回答"为什么没同步" */
  reason?: 'not-configured' | 'running' | 'too-soon';
  /** 如果因为太近而没跑，最早可跑的时刻 */
  nextAllowedAt?: number;
}

export function shouldRunSync(input: ShouldRunInput): ShouldRunResult {
  if (!input.configured) return { run: false, reason: 'not-configured' };
  if (input.running) return { run: false, reason: 'running' };

  // 手动触发不受最短间隔限制——用户明确要求了，等一分钟会让人以为按钮没反应
  if (input.kind === 'manual') return { run: true };

  const earliest = input.state.lastRunAt + input.state.minIntervalMs;
  if (input.now < earliest) {
    return { run: false, reason: 'too-soon', nextAllowedAt: earliest };
  }
  return { run: true };
}

/**
 * 变更触发的合并窗口。
 *
 * 连续来的变更只保留**最后一次**的等待，因此"划五下"等于"划一下之后再等 `delayMs`"，
 * 而不是五次独立上传。
 */
export interface ChangeWindow {
  /** 记一次变更；返回该在多少毫秒后跑（同一个窗口里永远是同一个数） */
  schedule(now: number, delayMs: number): { dueAt: number; alreadyScheduled: boolean };
  /** 清空（真的跑过了） */
  clear(): void;
  /** 是否已有待跑的窗口 */
  get pendingAt(): number | null;
  /** 当前时刻是否已到 */
  isDue(now: number): boolean;
}

export function createChangeWindow(): ChangeWindow {
  let dueAt: number | null = null;

  return {
    schedule(now, delayMs) {
      if (dueAt !== null) return { dueAt, alreadyScheduled: true };
      dueAt = now + delayMs;
      return { dueAt, alreadyScheduled: false };
    },
    clear() {
      dueAt = null;
    },
    get pendingAt() {
      return dueAt;
    },
    isDue(now) {
      return dueAt !== null && now >= dueAt;
    },
  };
}

/** 默认变更延迟：30 秒。足够把一次连续划词合并成一次，又不至于让人觉得"不同步" */
export const DEFAULT_CHANGE_DELAY_MS = 30_000;

/** 默认定时周期：15 分钟。MV3 的 alarms 最小粒度是分钟级，这个值在各浏览器上都被接受 */
export const DEFAULT_ALARM_MINUTES = 15;
