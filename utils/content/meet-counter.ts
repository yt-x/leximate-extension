/**
 * 遇见次数去抖（PLAN.md FR-A17，OQ11 已决）。
 *
 * 规格原文：**每次用户主动划词查询该词 `+1`；同一标签页内 30 秒内对同一词
 * 重复触发只计一次，防误触抖动。** 验收：规则在设置页可查；30 秒去重有单元测试。
 *
 * 三个要点都落在这里：
 * 1. 去抖是**按词**的，不是全局的——查完 `run` 立刻查 `go` 要各自计数
 * 2. 去抖窗口是**同一标签页内**——状态放模块内存而非 storage，标签页关掉即清空
 * 3. **"主动划词"才算**——自动标注扫到的词不计数，所以这个函数只在划词路径上调用
 *
 * 时间是注入的（`now`），不读 `Date.now()`，这样单测能精确控制窗口边界。
 */

/** FR-A17：去抖窗口，30 秒 */
export const MEET_DEBOUNCE_MS = 30_000;

export interface MeetCounter {
  /**
   * 记录一次遇见。返回**是否真的该 +1**：
   * - `true`  → 距上次超过窗口（或首次），调用方应累加 `meetCount`
   * - `false` → 落在 30 秒窗口内，本次不计数
   */
  hit(word: string, now: number): boolean;
  /** 该词上次计数的时间戳；从未计过返回 undefined */
  lastSeen(word: string): number | undefined;
  /** 当前跟踪的词数，用于诊断（不该无限增长） */
  size(): number;
  /** 清空。切标签页/换词库时用 */
  clear(): void;
}

/**
 * 造一个去抖计数器。
 *
 * `windowMs` 可注入是为了**单测能缩短窗口**，不是为了做成可配置项——
 * FR-A17 定的是 30 秒，设置页不暴露它。
 */
export function createMeetCounter(windowMs: number = MEET_DEBOUNCE_MS): MeetCounter {
  const last = new Map<string, number>();

  return {
    hit(word, now) {
      const key = word.trim().toLowerCase();
      if (key === '') return false;

      const previous = last.get(key);
      if (previous !== undefined && now - previous < windowMs) {
        // 窗口内：不计数，但也**不刷新**上次时间。
        // 否则连续误触会把窗口一直往后推，用户永远等不到下一次计数。
        return false;
      }

      last.set(key, now);
      return true;
    },

    lastSeen(word) {
      return last.get(word.trim().toLowerCase());
    },

    size: () => last.size,

    clear() {
      last.clear();
    },
  };
}
