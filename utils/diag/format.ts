/**
 * 诊断日志的呈现与导出（PLAN.md FR-L4）。
 *
 * 纯函数：筛选、格式化、导出文本、文件名。
 * 界面只做"取值 → 渲染"，因此"导出出去的是什么"可以在 Node 里逐字断言。
 */
import type { LogEntry, LogLevel } from '../db/types';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};

export interface LogFilter {
  /** `'all'` 或不传表示不筛级别 */
  level?: LogLevel | 'all';
  /** 按 scope 精确匹配 */
  scope?: string | 'all';
  /** 子串匹配（大小写不敏感），同时看 message 与 detail */
  text?: string;
}

/** detail 折成一行文本（用于搜索与展示） */
export function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail) ?? '';
  } catch {
    return '(无法序列化)';
  }
}

/**
 * 筛选。级别与 scope 是**精确匹配**，文本是子串匹配（与 FR-F3 的搜索口径一致：
 * 大小写不敏感，不做拼音/编辑距离）。
 */
export function filterLogs(entries: readonly LogEntry[], filter: LogFilter = {}): LogEntry[] {
  const level = filter.level ?? 'all';
  const scope = filter.scope ?? 'all';
  const needle = (filter.text ?? '').trim().toLowerCase();

  return entries.filter((entry) => {
    if (level !== 'all' && entry.level !== level) return false;
    if (scope !== 'all' && entry.scope !== scope) return false;
    if (needle === '') return true;

    return (
      entry.message.toLowerCase().includes(needle) ||
      entry.scope.toLowerCase().includes(needle) ||
      detailText(entry.detail).toLowerCase().includes(needle)
    );
  });
}

/** 从数据里抽出可选的 scope（供界面渲染下拉框）；按字母序，`all` 除外 */
export function availableScopes(entries: readonly LogEntry[]): string[] {
  const scopes = new Set<string>();
  for (const entry of entries) {
    if (entry.scope !== '') scopes.add(entry.scope);
  }
  return [...scopes].sort((a, b) => a.localeCompare(b));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 一行文本（导出用）。
 *
 * ⚠️ 时间用**本地时间**并显式写出时区偏移：诊断日志是给人看的，
 * 用户对着"页面什么时候出问题"看的是自己的钟；但导出给别人看时，
 * 没有偏移量的时间会被误读（所以带上 `+08:00` 这类后缀）。
 */
export function formatLogLine(entry: LogEntry): string {
  const at = new Date(entry.at);
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;

  const detail = detailText(entry.detail);
  return `[${stamp}] ${entry.level.toUpperCase()} ${entry.scope}: ${entry.message}${detail ? ` ${detail}` : ''}`;
}

/** 导出成纯文本（给人看、可贴进 issue） */
export function logsToText(entries: readonly LogEntry[]): string {
  return entries.map(formatLogLine).join('\n');
}

export interface DiagnosticsPayload {
  app: 'leximate';
  kind: 'diagnostics';
  exportedAt: string;
  appVersion: string;
  counts: { entries: number };
  entries: LogEntry[];
}

/**
 * 导出成 JSON（给机器看）。
 *
 * **只包含日志本身**：不带设置、不带凭据、不带词库内容——日志里本来就不该有这些，
 * 这里再确认一次（字段是白名单式的：直接放 `LogEntry`，不 spread 别的东西）。
 */
export function logsToJson(
  entries: readonly LogEntry[],
  options: { appVersion: string; at?: Date },
): string {
  const at = options.at ?? new Date();
  const payload: DiagnosticsPayload = {
    app: 'leximate',
    kind: 'diagnostics',
    exportedAt: at.toISOString(),
    appVersion: options.appVersion,
    counts: { entries: entries.length },
    entries: entries.map((entry) => ({ ...entry })),
  };
  return JSON.stringify(payload, null, 2);
}

/** 文件名沿用 §3.2.5 的约定：`leximate-<target>-<YYYYMMDD-HHmm>.<ext>` */
export function diagnosticsFilename(at: Date = new Date()): string {
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `leximate-diag-${stamp}.json`;
}
