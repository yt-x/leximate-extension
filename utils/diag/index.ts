/**
 * 本地诊断日志的对外入口（PLAN.md FR-L4）。
 *
 * | 文件 | 碰什么 | 谁能 import |
 * |---|---|---|
 * | `levels.ts` | 纯逻辑（级别、输入清洗） | 后台、管理台、**内容脚本**（`controller.ts` 只用它） |
 * | `log.ts` | IndexedDB 读写 | 后台、管理台（内容脚本不行：它读不到扩展源的存储） |
 * | `format.ts` | 纯函数（筛选、格式化、导出文本） | 管理台 |
 */
export type { LogLevel } from './levels';
export {
  cleanText,
  contentLogLevel,
  isLogLevel,
  MAX_DETAIL_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_SCOPE_LENGTH,
  sanitizeDetail,
} from './levels';

export type { ListLogsOptions, LogInput } from './log';
export { clearLogs, countLogs, listLogs, MAX_LOG_ENTRIES, writeLog } from './log';

export type { DiagnosticsPayload, LogFilter } from './format';
export {
  availableScopes,
  detailText,
  diagnosticsFilename,
  filterLogs,
  formatLogLine,
  LEVEL_LABEL,
  LOG_LEVELS,
  logsToJson,
  logsToText,
} from './format';
