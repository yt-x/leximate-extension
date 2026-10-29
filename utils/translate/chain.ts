/**
 * 翻译降级链（PLAN.md FR-D3 / FR-D5 / FR-D7）。
 *
 * 这一层是**纯逻辑**：不联网、不碰 IndexedDB，只做三件事——
 *   1. 按 `llm → chrome-builtin → api` 的次序尝试，上一级失败自动降级（FR-D3）；
 *   2. 判定"该不该发请求"（未开启翻译时一律不发，FR-D7）；
 *   3. 把待翻译项按并发与单批上限切批（FR-D5）。
 *
 * 为什么把这三件事单独拎出来：它们是这条功能里**唯一能用单测钉死的行为**。
 * 真正的网络调用各自实现 `TranslateEngine`，由用例注入假 fetch 断言请求形状；
 * "到底有没有把句子送出去"这种隐私判定，也就成了可断言的。
 */
import type { TranslationEngine } from '../db/types';

/** 一句待翻译的文本 */
export interface TranslateInput {
  readonly text: string;
  readonly targetLang: string;
}

/**
 * 一次成功的翻译结果。
 *
 * `engine` 记的是**实际成功的那一级**——降级之后必须能看出是谁翻的（FR-D3 的验收原话）。
 */
export interface TranslateResult {
  readonly text: string;
  readonly engine: TranslationEngine;
  /** 这一级用的模型名；`chrome-builtin` 与 `api` 没有模型概念，记空串 */
  readonly model: string;
}

/** 一个引擎。失败时抛错，由降级链负责换下一个 */
export interface TranslateEngineImpl {
  readonly engine: TranslationEngine;
  /** 能不能用（Chrome 内置翻译在多数版本上不可用，探测在器外做） */
  available?(): boolean | Promise<boolean>;
  translate(input: TranslateInput): Promise<{ text: string; model?: string }>;
}

/**
 * 翻译是否启用。
 *
 * FR-D7：**默认不联网**。只有用户把引擎显式配好才算开启：
 *  - `llm`：必须有 `baseUrl` 与 `model`（没有 Key 的本地模型是合法的，不强制）；
 *  - `api`：必须有 `url`；
 *  - `chrome-builtin`：本机能力，不需要凭据。
 *
 * 注意：这里只判"配置是否完整"，不看 `engine` 之外的东西——
 * 是否真的发请求还要过 `todayUsed < dailyLimit` 这一关（见 `canSpend`）。
 */
export function translationEnabled(
  translation: {
    readonly engine: TranslationEngine;
    readonly llm: { readonly baseUrl: string; readonly model: string } | null;
    readonly api: { readonly url: string } | null;
  } | null,
): boolean {
  if (!translation) return false;
  switch (translation.engine) {
    case 'llm':
      return (translation.llm?.baseUrl.trim() ?? '') !== '' && (translation.llm?.model.trim() ?? '') !== '';
    case 'api':
      return (translation.api?.url.trim() ?? '') !== '';
    case 'chrome-builtin':
      return true;
  }
}

/** FR-D5 的三个上限，全部可配 */
export interface TranslateLimits {
  /** 单次最多送多少句 */
  readonly batchSize: number;
  /** 同时最多几个请求 */
  readonly concurrency: number;
  /** 每日调用上限（发一次请求算一次调用） */
  readonly dailyLimit: number;
}

export const DEFAULT_LIMITS: TranslateLimits = {
  batchSize: 20,
  concurrency: 2,
  dailyLimit: 2000,
};

/**
 * 三项的可选范围。设置页的 `min`/`max` 与校验都读它，
 * `clampLimits` 也用同一组数——三处各写一份必然会漂。
 */
export const LIMIT_MIN = { batchSize: 1, concurrency: 1, dailyLimit: 0 } as const;
export const LIMIT_MAX = { batchSize: 100, concurrency: 8, dailyLimit: 100_000 } as const;

/** 把 limits 里的值钳到合法范围（设置可能被手改或被旧版本写坏） */
export function clampLimits(limits: Partial<TranslateLimits> | null | undefined): TranslateLimits {
  const pick = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
  };
  return {
    batchSize: pick(limits?.batchSize, DEFAULT_LIMITS.batchSize, LIMIT_MIN.batchSize, LIMIT_MAX.batchSize),
    concurrency: pick(
      limits?.concurrency,
      DEFAULT_LIMITS.concurrency,
      LIMIT_MIN.concurrency,
      LIMIT_MAX.concurrency,
    ),
    dailyLimit: pick(limits?.dailyLimit, DEFAULT_LIMITS.dailyLimit, LIMIT_MIN.dailyLimit, LIMIT_MAX.dailyLimit),
  };
}

/**
 * 今天还能不能发请求（FR-D5：超限时**排队而非丢弃**）。
 *
 * 返回 `false` 不代表失败——队列项留在 `pending` 里，明天再跑。
 */
export function canSpend(todayUsed: number, limits: TranslateLimits): boolean {
  return todayUsed < limits.dailyLimit;
}

/** 把待翻译项切成若干批（每批不超过 `batchSize`），并发上限由调用方用 `concurrency` 控制 */
export function planBatches<T>(items: readonly T[], limits: TranslateLimits): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += limits.batchSize) {
    out.push(items.slice(i, i + limits.batchSize));
  }
  return out;
}

/** 降级链的一次尝试记录，用于诊断日志（"谁失败了、为什么"） */
export interface ChainAttempt {
  readonly engine: TranslationEngine;
  readonly ok: boolean;
  readonly error?: string;
}

export interface ChainOutcome {
  readonly result: TranslateResult | null;
  readonly attempts: readonly ChainAttempt[];
  /** 是否因每日额度耗尽而停止后续降级；调用方应保留待办而非记失败。 */
  readonly limited: boolean;
}

/**
 * 按顺序尝试各引擎，第一个成功的胜出（FR-D3）。
 *
 * 语义细节：
 * - `available()` 返回 false 的引擎**直接跳过**，不计入失败（那是"本机没有"不是"出错"）；
 * - 全部失败时 `result` 为 null，并把每一级的错误留在 `attempts` 里——诊断页据此能看出
 *   "是 Key 错了还是网络不通"；
 * - 空链返回 null，不抛错（调用方照常把队列项留在待办里）。
 */
export async function runChain(
  engines: readonly TranslateEngineImpl[],
  input: TranslateInput,
  spend?: () => Promise<boolean>,
): Promise<ChainOutcome> {
  const attempts: ChainAttempt[] = [];

  for (const impl of engines) {
    if (impl.available) {
      const ok = await impl.available();
      if (!ok) {
        attempts.push({ engine: impl.engine, ok: false, error: '不可用' });
        continue;
      }
    }
    // 可用性探测不是翻译请求；只有真正调用 translate 前才占用一次每日额度。
    if (spend && !(await spend())) {
      return { result: null, attempts, limited: true };
    }
    try {
      const out = await impl.translate(input);
      const text = out.text.trim();
      if (text === '') {
        // 空结果当失败处理：缓存里存空串等于"这句永远翻不出来"
        attempts.push({ engine: impl.engine, ok: false, error: '返回空结果' });
        continue;
      }
      attempts.push({ engine: impl.engine, ok: true });
      return {
        result: { text, engine: impl.engine, model: out.model ?? '' },
        attempts,
        limited: false,
      };
    } catch (error) {
      attempts.push({
        engine: impl.engine,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { result: null, attempts, limited: false };
}

/** 按设置把降级链装配起来；只用配置里指定的那一级打头，其余按固定次序补齐 */
export function buildChain(
  preferred: TranslationEngine,
  impls: Partial<Record<TranslationEngine, TranslateEngineImpl>>,
): TranslateEngineImpl[] {
  const order: TranslationEngine[] = ['llm', 'chrome-builtin', 'api'];
  const start = order.indexOf(preferred);
  const ordered = start <= 0 ? order : [order[start]!, ...order.filter((e) => e !== preferred)];
  return ordered
    .map((engine) => impls[engine])
    .filter((impl): impl is TranslateEngineImpl => impl !== undefined);
}
