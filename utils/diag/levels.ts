/**
 * 诊断日志的**纯逻辑**（级别、输入清洗）。
 *
 * ## 为什么与 `log.ts` 分开
 *
 * 内容脚本也要给日志定级别（`controller.ts` 的 `env.log`），而
 * `log.ts` 要读写 IndexedDB——如果级别映射住在 `log.ts` 里，
 * 内容脚本就会为了一个纯函数把存储层拉进依赖图。
 *
 * 这与 `utils/db/defaults.ts` 从 `kv.ts` 拆出来是**同一件事**
 * （见那个文件的说明）：`scripts/check-content-boundary.ts` 会把这条边
 * 报成 `treeShakenReliance`——它不判失败，因为打包器确实把存储层摇掉了，
 * **但那是巧合不是保证**：给 `schema.ts` 加一句顶层副作用就会让
 * `indexedDB` 静默回到内容脚本里（`CONSTRAINTS.md` 第 12 条）。
 *
 * 因此本文件**必须保持纯**：不 import 任何东西，不产生副作用。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 单条日志的字段上限：这些值来自内容脚本，属于**不可信输入** */
export const MAX_SCOPE_LENGTH = 40;
export const MAX_MESSAGE_LENGTH = 200;
export const MAX_DETAIL_LENGTH = 2000;

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/**
 * 把内容脚本报上来的级别映射成日志级别。
 *
 * 内容脚本只报事件名（`content-started` / `word-collected` …），
 * 级别由这里定：**"这个页面干了什么"是信息，"某个操作失败了"才是警告**。
 * 映射放在模块里（而不是散在调用点）是为了让它可测、且一处可改。
 */
export function contentLogLevel(event: string): LogLevel {
  switch (event) {
    case 'content-started':
    case 'content-skipped':
    case 'word-collected':
    case 'status-changed':
      return 'info';
    default:
      return 'debug';
  }
}

/**
 * 清洗 `detail`。
 *
 * 它可能是任何东西（错误对象、DOM 节点、函数、循环引用）。规则：
 * - 序列化不了（循环引用）→ 用一个说明字符串顶替，**不丢这条日志**；
 * - 太长 → 截断（保留开头，够定位问题）；
 * - `undefined` / `null` → `null`。
 *
 * ⚠️ **返回的是 JSON 解析回来的值，不是原对象**。这不是洁癖：
 * IndexedDB 用结构化克隆存值，而**函数不可克隆**——把原对象存进去会直接
 * 抛 `DataCloneError`，于是"记一条带回调的日志"会让整条写入失败。
 * 走一遍 JSON 之后，存进去的一定是可克隆、可导出、可比较的形态。
 */
export function sanitizeDetail(detail: unknown): unknown {
  if (detail === undefined || detail === null) return null;

  let json: string | undefined;
  try {
    json = JSON.stringify(detail, (_key, value: unknown) => {
      if (typeof value === 'function' || typeof value === 'symbol') return undefined;
      if (typeof value === 'bigint') return String(value);
      return value;
    });
  } catch {
    return '(detail 无法序列化)';
  }

  if (json === undefined) return null;
  if (json.length > MAX_DETAIL_LENGTH) return `${json.slice(0, MAX_DETAIL_LENGTH)}…`;

  try {
    return JSON.parse(json) as unknown;
  } catch {
    return '(detail 无法序列化)';
  }
}

/** 文本字段的统一切法：非字符串/空白给兜底值，过长截断 */
export function cleanText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (text === '') return fallback;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
