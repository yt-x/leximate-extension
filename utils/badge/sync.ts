/**
 * 角标的**刷新编排**（PLAN.md FR-A14）。
 *
 * `badge.ts` 算出文案，这里决定"什么时候重算"和"怎么落到浏览器"。
 * 浏览器能力全部走 `BadgeEnv` 注入，于是本模块在单测里可以完整跑通——
 * 这正是 M1-5 定的做法（见 `changes/M1-mvp-loop.md` §15）：把难验的判定
 * 抽成纯的，浏览器接口收在接口后面。
 *
 * ⚠️ MV3 的关键约束：后台是**随时会被回收的 Service Worker**。
 * 因此角标不能只在"词数变化"时更新一次——worker 重启后那条路径不会再走。
 * 所以每次 `syncBadge()` 都要**从存储重新读一次真实状态**再写角标，
 * 而不是依赖内存里缓存的计数。
 */
import type { Settings } from '../db/types';
import { badgeText } from './badge';

/** 角标刷新需要的最小浏览器能力 */
export interface BadgeEnv {
  /** 读当前设置（含 FR-A14 的 `enabled`） */
  getSettings(): Promise<Pick<Settings, 'enabled'>>;
  /** 读当前遇见词数（词库 `words` 总数） */
  countWords(): Promise<number>;
  /**
   * 写角标。`text` 为 `null` 表示清除。
   *
   * 由实现方负责把 `null` 翻成该浏览器 API 的"清除"写法
   * （Chrome/Firefox 都是空字符串），编排层不关心这个差异。
   */
  setBadge(text: string | null): Promise<void> | void;
}

export interface BadgeSync {
  /** 重新读状态并更新角标；返回最终写入的文案（清除时为 null），便于测试与诊断 */
  sync(): Promise<string | null>;
}

export function createBadgeSync(env: BadgeEnv): BadgeSync {
  return {
    async sync() {
      // 两个读并行：角标刷新在 worker 冷启动路径上，能省一次往返就省一次
      const [settings, wordCount] = await Promise.all([
        env.getSettings(),
        env.countWords(),
      ]);

      const text = badgeText({
        enabled: settings.enabled === true,
        wordCount,
      });

      await env.setBadge(text);
      return text;
    },
  };
}
