/**
 * 首次安装引导：判定与文案（PLAN.md FR-E6 / FR-F10 / FR-F11）。
 *
 * 纯函数层，**不碰 DOM、不读库**——"该不该显示""四块内容齐不齐""词库状态怎么说"
 * 都是可断言的规则；渲染在 `entrypoints/manager/Onboarding.tsx`。
 */
import type { LogEntry, Meta } from '../db/types';
import { t } from '../i18n';

/**
 * 引导必须齐备的四块。
 *
 * 验收原文（FR-F10）：**词库初始化进度、卸载风险提示、核心开关说明、隐私说明**。
 * 把这份清单放在这里而不是散在 JSX 里，是为了让"四块齐备"成为一条**可断言**的判据
 * （组件按 `data-block` 渲染，用例按这个数组逐个查）。
 */
export const ONBOARDING_BLOCKS = [
  'dict-status',
  'uninstall-risk',
  'core-switches',
  'privacy',
] as const;

export type OnboardingBlock = (typeof ONBOARDING_BLOCKS)[number];

/**
 * 该不该显示引导。
 *
 * 口径（`changes/M2-onboarding.md`）：`onboardingDoneAt === null` 就显示。
 * 老库没有这个字段，`getMeta()` 合并默认值后同样是 `null` → **老用户也会看到一次**，
 * 这是有意的：他们同样没被提醒过"卸载会丢数据"（FR-E6）。
 */
export function shouldShowOnboarding(
  meta: Pick<Meta, 'onboardingDoneAt'> | null | undefined,
): boolean {
  return (meta?.onboardingDoneAt ?? null) === null;
}

/** 从诊断日志里挑出最近一条"词库"记录（内容脚本首次载入后写的） */
export function pickLatestDictLog(entries: readonly LogEntry[]): LogEntry | undefined {
  let latest: LogEntry | undefined;
  for (const entry of entries) {
    if (entry.scope !== 'dict') continue;
    if (latest === undefined || entry.at >= latest.at) latest = entry;
  }
  return latest;
}

/**
 * 词库状态文案（FR-F11：进度与耗时可见）。
 *
 * 三种情况都要说得清楚，不许含糊：
 * - 没有记录 → 说明"还没载入、什么时候会载入、数据不出网"（这也顺带回答了隐私疑问）；
 * - 有记录但字段缺失（旧日志没有 `elapsedMs`）→ 只说拿得到的部分，不编数字；
 * - 正常记录 → 分片数 / 版本 / 载入耗时。
 */
export function dictStatusText(entry: LogEntry | undefined): string {
  if (!entry) {
    return t('dict.notLoaded');
  }

  const detail = (entry.detail ?? {}) as {
    version?: unknown;
    entries?: unknown;
    shards?: unknown;
    elapsedMs?: unknown;
  };

  const shards = Array.isArray(detail.shards) ? detail.shards.length : null;
  const entries =
    typeof detail.entries === 'number' && Number.isFinite(detail.entries) ? detail.entries : null;
  const version =
    typeof detail.version === 'string' && detail.version !== '' ? detail.version : null;
  const elapsedMs =
    typeof detail.elapsedMs === 'number' && Number.isFinite(detail.elapsedMs)
      ? detail.elapsedMs
      : null;

  const parts = [t('dict.ready')];
  if (shards !== null) parts.push(t('dict.shards', { count: shards }));
  if (entries !== null) parts.push(t('dict.words', { count: entries }));
  if (version !== null) parts.push(t('dict.version', { version }));
  if (elapsedMs !== null) parts.push(t('dict.elapsed', { ms: Math.max(0, Math.round(elapsedMs)) }));

  return parts.join(' · ');
}
