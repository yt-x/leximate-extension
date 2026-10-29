/**
 * 翻译 worker：把队列、降级链、缓存串起来（PLAN.md FR-D1 / FR-D2 / FR-D4 / FR-D5 / FR-D6）。
 *
 * 这是整条链上**唯一会真正发请求**的地方，而且它只跑在后台（内容脚本零网络，`PLAN.md` §4.2）。
 *
 * 一次 `runOnce` 的次序刻意是"先查缓存再花钱"：
 *   1. 未启用翻译 → 立刻返回（FR-D7：默认不联网）；
 *   2. 今日已用满 → 立刻返回，队列项**留在原处**（FR-D5：排队而非丢弃）；
 *   3. 逐个待办查缓存，命中就直接完成（FR-D4：重复句子零请求）；
 *   4. 剩下的才进降级链；成功写缓存 + 出队，失败记 `attempts`。
 *
 * 所有外部依赖都是注入的，因此"会不会发请求、发了几次"可在用例里逐次断言。
 */
import type { QueueItem, Settings, TranslationEngine } from '../db/types';
import {
  completeQueueItem,
  getCachedTranslation,
  putTranslation,
  queueStats,
  setQueueState,
  takePending,
} from '../db/translations';
import {
  DEFAULT_LIMITS,
  buildChain,
  canSpend,
  clampLimits,
  runChain,
  translationEnabled,
  type TranslateEngineImpl,
  type TranslateLimits,
} from './chain';

/** 连续失败到这个次数就不再自动重试（FR-D6，防止无限烧钱） */
export const MAX_ATTEMPTS = 3;

export interface WorkerDeps {
  /** 读设置（含翻译配置与上限） */
  getSettings(): Promise<Settings>;
  /**
   * FR-D7：用户是否已确认"句子会离开浏览器"的告知。
   *
   * **这是硬门禁**：未确认为真时一条请求都不发，哪怕配置完整。
   * 做成依赖而不是直接读 meta，是为了让"未确认"这条路径能在用例里直接驱动。
   */
  noticeAcknowledged?(): Promise<boolean>;
  /** 取 scene 的原文；找不到就跳过并出队（scene 可能已被用户删掉） */
  getSceneText(sceneId: string): Promise<string | undefined>;
  /** 三个引擎（缺哪个就少一级） */
  engines: Partial<Record<TranslationEngine, TranslateEngineImpl>>;
  /** 今日已用调用数（跨设备累计由调用方维护） */
  todayUsed(): Promise<number>;
  /** 记一次调用 */
  noteCall(count: number): Promise<void>;
  /** 写诊断日志（失败原因要能查） */
  log?(entry: { level: 'info' | 'warn'; message: string; detail?: unknown }): void;
  /** 覆盖上限（用例用） */
  limits?: Partial<TranslateLimits>;
  /** 覆盖重试上限（用例用） */
  maxAttempts?: number;
}

export interface RunSummary {
  /** 这次处理了几条 */
  handled: number;
  /** 其中命中缓存、没花请求的 */
  cached: number;
  /** 真正发出的引擎请求次数（一次队列项降级可计多次） */
  requested: number;
  /** 成功翻译的 */
  translated: number;
  /** 失败并留在队列的 */
  failed: number;
  /** 因为每日上限而没动的 */
  deferred: number;
  /** 是否因为"未启用翻译"整体跳过 */
  disabled: boolean;
}

const EMPTY: RunSummary = {
  handled: 0,
  cached: 0,
  requested: 0,
  translated: 0,
  failed: 0,
  deferred: 0,
  disabled: false,
};

/**
 * 跑一轮。`budget` 限制这次最多处理几条（后台按空闲时间片调它）。
 *
 * 返回值是**给诊断页看的统计**，不是给界面判断成功/失败用的——
 * "还有没有待办"一律以 `queueStats` 为准。
 */
export async function runOnce(deps: WorkerDeps, budget = 20): Promise<RunSummary> {
  const settings = await deps.getSettings();
  const translation = settings.translation;

  // ① FR-D7：没开启就一条请求都不发
  if (!translationEnabled(translation)) {
    return { ...EMPTY, disabled: true };
  }

  // ①' FR-D7：配置完整但用户没确认过告知，同样一条都不发。
  //     这一条与上一条分开写，是因为它们的"修法"不同：上一条要用户去填配置，
  //     这条要用户去看那份"什么会离开浏览器"的说明。
  if (deps.noticeAcknowledged) {
    const acknowledged = await deps.noticeAcknowledged();
    if (!acknowledged) {
      return { ...EMPTY, disabled: true };
    }
  }

  const limits = clampLimits({ ...DEFAULT_LIMITS, ...deps.limits });
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;

  // ② FR-D5：今日额度用满 → 排队等明天
  const used = await deps.todayUsed();
  if (!canSpend(used, limits)) {
    return { ...EMPTY, deferred: budget };
  }

  const chain = buildChain(translation.engine, deps.engines);
  if (chain.length === 0) {
    deps.log?.({ level: 'warn', message: '翻译队列有活，但没有任何可用引擎' });
    return { ...EMPTY, disabled: true };
  }

  const items = await takePending(Math.min(budget, limits.batchSize), maxAttempts);
  const summary: RunSummary = { ...EMPTY, handled: items.length };
  if (items.length === 0) return summary;

  let remaining = limits.dailyLimit - used;
  const inFlight = new Map<string, Promise<void>>();

  const processItem = async (item: QueueItem): Promise<void> => {
    if (remaining <= 0) {
      summary.deferred += 1;
      return;
    }

    const text = await deps.getSceneText(item.sceneId);
    if (text === undefined || text.trim() === '') {
      // scene 没了就不该继续占着队列：这不是失败，是对象消失了
      await completeQueueItem(item.id);
      deps.log?.({ level: 'info', message: '待翻译的例句已不存在，出队', detail: { id: item.id } });
      return;
    }

    // ③ FR-D4：缓存与同句 in-flight 合并（命中不花钱，并发也不重复请求）
    const flightKey = `${item.targetLang}\0${text}`;
    const execute = async (): Promise<void> => {
      await setQueueState(item.id, 'running');

      const outcome = await runChain(
        chain,
        { text, targetLang: item.targetLang },
        async () => {
          // 检查与扣减都在同一个同步区段：其它并发任务只能在本任务 await noteCall 后进入，
          // 因而不能把同一份额度预留两次。
          if (remaining <= 0) return false;
          remaining -= 1;
          summary.requested += 1;
          await deps.noteCall(1);
          return true;
        },
      );
      if (outcome.limited) {
        // 已发生的真实请求照常计费；未发生的降级不算失败，也不消耗重试次数。
        await setQueueState(item.id, 'pending');
        summary.deferred += 1;
        return;
      }
      if (outcome.result) {
        await putTranslation(
          {
            text,
            targetLang: item.targetLang,
            engine: outcome.result.engine,
            model: outcome.result.model || (outcome.result.engine === 'llm' ? translation.llm?.model ?? '' : ''),
          },
          outcome.result.text,
        );
        await completeQueueItem(item.id);
        summary.translated += 1;
        return;
      }

      const reason = outcome.attempts
        .filter((a) => a.error)
        .map((a) => `${a.engine}: ${a.error}`)
        .join('; ');
      await setQueueState(item.id, 'failed', { error: reason, bumpAttempts: true });
      summary.failed += 1;
      deps.log?.({
        level: 'warn',
        message: '翻译失败',
        detail: { id: item.id, attempts: item.attempts + 1, reason },
      });
    };

    while (true) {
      const pending = inFlight.get(flightKey);
      if (pending) {
        await pending;
        continue;
      }

      // 无 in-flight 时先查缓存；另一个同句任务可能已在本轮早些时候完成。
      const cachedNow = await findCached(item, text, chain, translation.llm?.model ?? '');
      if (cachedNow !== undefined) {
        summary.cached += 1;
        await completeQueueItem(item.id);
        return;
      }
      // 缓存 await 期间可能有别的同句任务先开始，优先等它而不是重复请求。
      if (inFlight.has(flightKey)) continue;

      const flight = execute();
      inFlight.set(flightKey, flight);
      try {
        await flight;
      } finally {
        if (inFlight.get(flightKey) === flight) inFlight.delete(flightKey);
      }
      return;
    }
  };

  let nextIndex = 0;
  const consume = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]!;
      nextIndex += 1;
      await processItem(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limits.concurrency, items.length) }, () => consume()),
  );

  return summary;
}

/**
 * 按链的次序找缓存。
 *
 * 为什么要遍历整条链而不是只查"配置的首选引擎"：上一轮可能降级用 `api` 翻过，
 * 那时缓存里存的是 `api` 的结果。只查首选引擎会重复花钱翻同一句。
 */
async function findCached(
  item: QueueItem,
  text: string,
  chain: readonly TranslateEngineImpl[],
  llmModel: string,
): Promise<string | undefined> {
  for (const impl of chain) {
    const model = impl.engine === 'llm' ? llmModel : '';
    const hit = await getCachedTranslation({
      text,
      targetLang: item.targetLang,
      engine: impl.engine,
      model,
    });
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 给管理台用：待翻译条数（FR-D6） */
export async function pendingCount(): Promise<number> {
  const stats = await queueStats(MAX_ATTEMPTS);
  return stats.waiting;
}
