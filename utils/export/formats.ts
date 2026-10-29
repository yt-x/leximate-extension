/**
 * 五种导出格式的序列化（PLAN.md §3.2.1 ~ §3.2.5）。
 *
 * 全是纯函数：字符串进、字符串出，不碰文件系统、不碰浏览器 API。
 * 这样"格式对不对"可以在无浏览器环境逐字节断言——而格式正是这一节点的验收对象。
 *
 * 每条约定旁边的理由都指向 `docs/reference/export-formats.md`
 * （那份文档记的是官方文档原文与实测，这里只负责执行）。
 */
import type { Scene, Word } from '../db/types';
import { EXPORT_COLUMNS, type ExportColumnKey, type ExportRecord } from './record';

export type ExportTarget = 'anki' | 'csv' | 'bbdc' | 'maimemo' | 'json';

export interface TargetMeta {
  value: ExportTarget;
  label: string;
  extension: string;
  mime: string;
  /** 是否带 UTF-8 BOM（§3.2.5：**仅 CSV**） */
  bom: boolean;
  /** 导出成功后给用户看的下继操作 */
  hint: string;
}

/**
 * §3.2 的五个目标。
 *
 * `hint` 不是装饰：不背单词与墨墨的文件里**只有单词**，
 * 用户看到"导出的文件里没有释义"会以为导出坏了——必须当场说明
 * "释义由那个 App 自己匹配"，并给出下一步。
 */
export const EXPORT_TARGETS: readonly TargetMeta[] = [
  {
    value: 'anki',
    label: 'Anki（TSV，含例句与释义）',
    extension: 'tsv',
    mime: 'text/tab-separated-values',
    bom: false,
    hint:
      'Anki → 文件 → 导入 → 选本文件。文件头已钉死 #separator:tab 与 #html:false，' +
      '不需要在导入对话框改分隔符，也不需要勾「允许 HTML」。',
  },
  {
    value: 'csv',
    label: '通用 CSV（含例句与释义，列可勾选）',
    extension: 'csv',
    mime: 'text/csv',
    bom: true,
    hint: '带 BOM 的 UTF-8，Excel 直接双击打开不乱码；也可被其它工具当标准 CSV 读。',
  },
  {
    value: 'bbdc',
    label: '不背单词（TXT，纯单词表）',
    extension: 'txt',
    mime: 'text/plain',
    bom: false,
    hint:
      '登录 bbdc.cn → 自制词书 → 上传本文件 → 点「识别」→ 填词书名（上限 15 字）→ 选标签 → 提交。' +
      '文件里只有单词：释义、音标、例句由不背单词自己匹配。',
  },
  {
    value: 'maimemo',
    label: '墨墨背单词（TXT，纯单词表 / 可选章节）',
    extension: 'txt',
    mime: 'text/plain',
    bom: false,
    hint:
      '墨墨 → 选词 → 云词库 → +（或官网「我的编辑 → 云词库 → 新建」；网站端建的词库会自动同步到手机）。' +
      '文件里只有单词：中文释义会被它当成词条提取，因此不写入。',
  },
  {
    value: 'json',
    label: 'JSON 备份（全量，可回灌）',
    extension: 'json',
    mime: 'application/json',
    bom: false,
    hint: '原始数据备份，供换机与回灌使用；不含任何凭据。',
  },
];

export function targetMeta(target: ExportTarget): TargetMeta {
  const meta = EXPORT_TARGETS.find((item) => item.value === target);
  if (!meta) throw new Error(`未知的导出目标：${target}`);
  return meta;
}

/** 勾选的列 key → 列定义，**按 §3.1 的固定顺序**排列（不随勾选顺序变） */
export function columnsFromKeys(keys: readonly ExportColumnKey[]): typeof EXPORT_COLUMNS {
  const wanted = new Set(keys);
  return EXPORT_COLUMNS.filter((column) => wanted.has(column.key));
}

/**
 * RFC 4180 的字段转义（§3.2.2）。
 *
 * 第 6 条：含 CRLF、双引号或逗号的字段要用双引号包裹；
 * 第 7 条：包裹后字段内部的双引号要双写。
 * **不做"能省则省"以外的加工**——尤其不要把换行"优化"成分号拼接。
 */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Anki 的字段：**一律**双引号包裹（§3.2.1）。
 *
 * 为什么不像 CSV 那样"需要才包"：Anki 的列数按**首个非注释行**判定，
 * 而我们的字段里既有换行又有制表符，统一包裹能让"每条记录一行、列数一致"
 * 这条约定在人工核对时也一眼可见。
 */
export function ankiField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** §3.2.1 的文件头，逐字 */
export const ANKI_DECK = 'Leximate';
export const ANKI_HEADER_SEPARATOR = '#separator:tab';
export const ANKI_HEADER_HTML = '#html:false';

export function ankiColumnsHeader(): string {
  const names = EXPORT_COLUMNS.filter((column) => column.inAnki).map((column) => column.ankiHeader);
  // 分隔符由 #separator: 决定，因此这里用**制表符**（§3.2.1）
  return `#columns:${names.join('\t')}`;
}

/**
 * Anki TSV（§3.2.1）。
 *
 * 四条硬约定都体现在这里：文件头钉死分隔符与 HTML、每条记录一行、各行列数完全一致、
 * **末尾不加换行**（空行会被 Anki 当成一条记录）。
 */
export function toAnkiTsv(records: readonly ExportRecord[]): string {
  const columns = EXPORT_COLUMNS.filter((column) => column.inAnki);
  const lines = [
    ANKI_HEADER_SEPARATOR,
    ANKI_HEADER_HTML,
    ankiColumnsHeader(),
    `#deck:${ANKI_DECK}`,
    ...records.map((record) => columns.map((column) => ankiField(record[column.key])).join('\t')),
  ];
  return lines.join('\n');
}

/** §3.1 的默认列（CSV 不勾选时的取值） */
export const DEFAULT_CSV_COLUMNS: readonly ExportColumnKey[] = EXPORT_COLUMNS.filter(
  (column) => column.csvDefault,
).map((column) => column.key);

/**
 * 通用 CSV（§3.2.2）。
 *
 * 写表头（与 Anki 相反）、记录间用 **CRLF**、字段按 RFC 4180 转义。
 * BOM 不在这里拼：那是**字节层**的事，由 `download.ts` 写进 Blob，
 * 好让"CSV 文本"这个纯函数保持可逐字符断言。
 */
export function toCsv(
  records: readonly ExportRecord[],
  columns: readonly ExportColumnKey[] = DEFAULT_CSV_COLUMNS,
): string {
  const selected = columnsFromKeys(columns);
  const head = selected.map((column) => csvEscape(column.csvHeader)).join(',');
  const rows = records.map((record) =>
    selected.map((column) => csvEscape(record[column.key])).join(','),
  );
  return [head, ...rows].join('\r\n');
}

/**
 * 纯单词表（§3.2.3 不背单词 / §3.2.4 墨墨）。
 *
 * 去重、去空行、首尾 trim；**不写任何释义、音标、例句**——
 * 两个 App 的 TXT 通路都只吃词表，写进去的中文串会被当成词条（污染词表）。
 */
export function toWordList(
  records: readonly ExportRecord[],
  options: { chapter?: string } = {},
): string {
  const words = uniqueWords(records);
  const chapter = normalizeChapter(options.chapter ?? '');
  const lines = chapter ? [`#${chapter}`, ...words] : words;
  return lines.join('\n');
}

/** 词表去重（保持顺序）。`lemma` 在写入时已归一为小写，所以按字面比较即可 */
export function uniqueWords(records: readonly ExportRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const record of records) {
    const word = record.word.trim();
    if (word === '' || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * 墨墨的章节名（§3.2.4）。
 *
 * `#` 必须是**半角**且只占一行。用户输入里常自带 `#`，这里统一归一，
 * 免得出现 `##章节`；纯空白等于"不用章节模式"。
 */
export function normalizeChapter(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim();
}

/** §3.2.5 的备份结构版本。结构一变就 +1，回灌端据此决定怎么读 */
export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupPayload {
  app: 'leximate';
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  dictVersion: string;
  counts: { words: number; scenes: number };
  words: Word[];
  scenes: Scene[];
}

export interface BackupInput {
  words: readonly Word[];
  scenes: readonly Scene[];
  appVersion: string;
  dictVersion: string;
  /** OQ8：导出的 JSON 是否包含例句翻译（默认包含） */
  includeTranslations?: boolean;
  at?: Date;
}

/**
 * JSON 备份载荷（§3.2「全量 + schemaVersion」）。
 *
 * **只含词与例句**：`settings`（含 WebDAV / LLM 凭据，FR-H7 禁止外流）、
 * `translations` 缓存、`queue`、以及墓碑（`deletedAt`）都不进文件。
 * 取舍与被放弃的方案见 `decisions/0019-backup-payload-scope.md`。
 */
export function buildBackupPayload(input: BackupInput): BackupPayload {
  const { words, scenes, appVersion, dictVersion } = input;
  const includeTranslations = input.includeTranslations ?? true;
  const at = input.at ?? new Date();

  return {
    app: 'leximate',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: at.toISOString(),
    appVersion,
    dictVersion,
    counts: { words: words.length, scenes: scenes.length },
    // 浅拷贝：这些是纯数据，序列化时不会再被改动；拷贝是为了不让调用方
    // 事后修改引用影响到已经生成的文件内容
    words: words.map((word) => ({ ...word })),
    scenes: scenes.map((scene) => ({
      ...scene,
      translation: includeTranslations ? scene.translation : null,
    })),
  };
}

/**
 * 文件名（§3.2.5）：`leximate-<target>-<YYYYMMDD-HHmm>.<ext>`。
 *
 * 带 `-HHmm` 是因为同一分钟内可能连导多种格式，只到日期会互相覆盖；
 * 一律 ASCII slug，中文词库名写进文件内容或 App 的表单字段
 * （不背单词的词书名上限 15 字，墨墨的是独立字段）。
 */
export function exportFilename(target: ExportTarget, at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `leximate-${target}-${stamp}.${targetMeta(target).extension}`;
}

/** 待下载的文件：文本 + 元信息（字节层的事留给 `download.ts`） */
export interface ExportFile {
  filename: string;
  text: string;
  mime: string;
  bom: boolean;
  hint: string;
}

export interface ExportFileInput {
  target: ExportTarget;
  records: readonly ExportRecord[];
  /** CSV：要哪些列（§3.2.2 / FR-G3）；缺省用 §3.1 的默认列 */
  csvColumns?: readonly ExportColumnKey[];
  /** 墨墨：可选章节名 */
  chapter?: string;
  /** JSON：备份载荷；`target === 'json'` 时必填 */
  backup?: BackupPayload;
  at?: Date;
}

/** 把记录渲染成"要下载的那个文件" */
export function buildExportFile(input: ExportFileInput): ExportFile {
  const at = input.at ?? new Date();
  const meta = targetMeta(input.target);
  const base = { filename: exportFilename(input.target, at), mime: meta.mime, bom: meta.bom, hint: meta.hint };

  switch (input.target) {
    case 'anki':
      return { ...base, text: toAnkiTsv(input.records) };
    case 'csv':
      return { ...base, text: toCsv(input.records, input.csvColumns) };
    case 'bbdc':
      return { ...base, text: toWordList(input.records) };
    case 'maimemo':
      return { ...base, text: toWordList(input.records, { chapter: input.chapter }) };
    case 'json': {
      if (!input.backup) throw new Error('JSON 导出缺备份载荷');
      return { ...base, text: JSON.stringify(input.backup, null, 2) };
    }
  }
}
