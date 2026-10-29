/**
 * 后台侧的翻译装配（PLAN.md FR-D3 / FR-D5 / FR-D7）。
 *
 * 这一层只做"接线"：把设置、meta、三个引擎、每日计数拼成 `runOnce` 需要的依赖。
 * 之所以单独成文件而不是塞进 `entrypoints/background.ts`：
 * 装配里的两个判断（**告知是否确认**、**今天还剩多少额度**）都是隐私与成本约束的落点，
 * 把它们放在可注入的纯模块里，用例才能直接驱动"没告知 → 不发"这条路径。
 */
import { getMeta, setMeta } from '../db/kv';
import type { Settings } from '../db/types';
import { createApiEngine, createChromeBuiltinEngine, createLlmEngine } from './engines';
import { runOnce, type RunSummary, type WorkerDeps } from './worker';

/** 每日计数：日期用本地日历日（用户看到的"今天"就是本地今天） */
export interface DailyCalls {
  date: string;
  count: number;
}

/** 本地日历日字符串 `YYYY-MM-DD` */
export function localDateKey(now: number): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * 从持久化的计数里取"今天用了多少"。
 *
 * 跨天自动归零——**不写回**，读的一侧只做判定（写回发生在真的要发请求时）。
 */
export function callsToday(stored: DailyCalls | null, now: number): number {
  if (!stored) return 0;
  return stored.date === localDateKey(now) ? Math.max(0, stored.count) : 0;
}

/** 把一次调用累加进计数（跨天从 1 重新开始） */
export function addCalls(stored: DailyCalls | null, now: number, delta: number): DailyCalls {
  const today = localDateKey(now);
  const base = stored && stored.date === today ? Math.max(0, stored.count) : 0;
  return { date: today, count: base + delta };
}

export interface TranslateAssemblyDeps {
  /** 读当前设置 */
  getSettings(): Promise<Settings>;
  /** 读/写 meta（告知标记与每日计数都住在这里） */
  getMeta(): Promise<{ translationNoticeAt: number | null; translateCalls?: DailyCalls | null }>;
  setMeta(patch: {
    translationNoticeAt?: number;
    translateCalls?: DailyCalls;
  }): Promise<unknown>;
  /** 取例句原文 */
  getSceneText(sceneId: string): Promise<string | undefined>;
  /** 本机是否有 Chrome 内置翻译（默认探测全局 Translator） */
  getTranslator?: () => unknown;
  log?(entry: { level: 'info' | 'warn'; message: string; detail?: unknown }): void;
  /** 当前时间（用例可注入固定值） */
  now?: () => number;
}

/**
 * 装配并跑一轮翻译。
 *
 * 返回值直接给诊断日志用；`null` 表示"没跑"（未告知 / 未启用 / 额度用尽）。
 */
let metaWriteTail: Promise<void> = Promise.resolve();

export async function runTranslatePass(
  deps: TranslateAssemblyDeps,
  budget = 20,
): Promise<RunSummary> {
  const now = deps.now ?? Date.now;
  const settings = await deps.getSettings();
  const meta = await deps.getMeta();

  const translation = settings.translation;
  const workerDeps: WorkerDeps = {
    // 告知门禁由 runOnce 统一处理，这里只提供事实
    noticeAcknowledged: async () => meta.translationNoticeAt !== null,
    getSettings: async () => settings,
    getSceneText: deps.getSceneText,
    engines: {
      llm: translation.llm
        ? createLlmEngine({ ...translation.llm })
        : undefined,
      'chrome-builtin': createChromeBuiltinEngine({
        getTranslator: () => deps.getTranslator?.() as never,
      }),
      api: translation.api ? createApiEngine({ ...translation.api }) : undefined,
    },
    todayUsed: async () => callsToday(meta.translateCalls ?? null, now()),
    noteCall: (count) => {
      // 并发请求不能各自拿轮次开始时的 meta 快照写回；串行重读再累加，避免丢失更新。
      const write = metaWriteTail.then(async () => {
        const latest = await deps.getMeta();
        await deps.setMeta({ translateCalls: addCalls(latest.translateCalls ?? null, now(), count) });
      });
      metaWriteTail = write.catch(() => undefined);
      return write;
    },
    log: deps.log,
    limits: translation.limits,
  };

  const summary = await runOnce(workerDeps, budget);
  if (summary.disabled) {
    deps.log?.({ level: 'info', message: '翻译未启用或告知未确认，跳过本轮' });
  }
  return summary;
}

/** 记录"用户已看过多语言/翻译告知"（FR-D7） */
export async function acknowledgeTranslationNotice(): Promise<void> {
  await setMeta({ translationNoticeAt: Date.now() });
}

export { getMeta };
