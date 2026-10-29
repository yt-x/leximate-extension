/**
 * 导出的对外入口（PLAN.md §1.G / §3）。
 *
 * 按"纯逻辑 → 装载 → 下载"三层分组，界面只从这一个入口取东西：
 * 层与层的边界（谁能碰 IndexedDB、谁能碰浏览器 API）因此在 import 语句上就看得见。
 */
export type { ExportColumn, ExportColumnKey, ExportRecord, RecordInput } from './record';
export {
  EXPORT_COLUMNS,
  buildRecord,
  buildRecords,
  cleanSingleLine,
  cleanText,
  defaultCsvColumns,
  definitionOf,
  formatFrequency,
  joinAligned,
  joinLines,
  sortScenes,
} from './record';

export type { BackupPayload, ExportFile, ExportFileInput, ExportTarget, TargetMeta } from './formats';
export {
  ANKI_DECK,
  ANKI_HEADER_HTML,
  ANKI_HEADER_SEPARATOR,
  BACKUP_SCHEMA_VERSION,
  DEFAULT_CSV_COLUMNS,
  EXPORT_TARGETS,
  ankiColumnsHeader,
  ankiField,
  buildBackupPayload,
  buildExportFile,
  columnsFromKeys,
  csvEscape,
  exportFilename,
  normalizeChapter,
  targetMeta,
  toAnkiTsv,
  toCsv,
  toWordList,
  uniqueWords,
} from './formats';

export type { ExportScope, ScopeInput } from './scope';
export { EXPORT_SCOPES, pickRows, scopeCounts } from './scope';

export type { BackupData, CollectOptions } from './collect';
export { collectBackupData, loadAllWords, loadScenesByWord, toRecordInputs } from './collect';

export type { DownloadDeps, DownloadRequest } from './download';
export { REVOKE_DELAY_MS, browserDownloadDeps, downloadExportFile, fileBlob } from './download';
