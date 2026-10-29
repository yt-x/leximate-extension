/**
 * 导出记录的列结构与取值（PLAN.md §3.1）。
 *
 * 这一层是**纯函数**：`Word` + 若干 `Scene` 进去，一个"每列都是字符串"的记录出来。
 * 为什么不直接把 `Word` 交给格式化层：那样每种格式都要自己决定
 * "释义用什么分隔""没音标时填什么"，三条路径会各自漂移；
 * 这里定死一次，五种格式共用同一份取值口径。
 *
 * ⚠️ **多行内容一律用真实换行**，不用 `<br>`（`decisions/0018`）：
 * Anki 的文件头写了 `#html:false`，`<br>` 在那里是字面量而不是换行；
 * 通用 CSV 本来就用引号包裹换行（RFC 4180 第 6 条）。
 */
import type { Scene, Word } from '../db/types';

export type ExportColumnKey =
  | 'word'
  | 'phonetic'
  | 'definition'
  | 'examples'
  | 'exampleTranslations'
  | 'source'
  | 'examTags'
  | 'frequency'
  | 'meetCount'
  | 'status'
  | 'unlisted'
  | 'createdAt';

export interface ExportColumn {
  key: ExportColumnKey;
  /** CSV 表头：与 §3.1 的列名字面一致 */
  csvHeader: string;
  /** Anki `#columns:` 里的中文名（§3.2.1 逐字） */
  ankiHeader: string;
  /** Anki 文件头是否登记这一列（§3.2.1 是 11 列，不含 `unlisted`） */
  inAnki: boolean;
  /** CSV 里默认是否勾选（FR-G3 + OQ13：`unlisted` 默认不占列） */
  csvDefault: boolean;
}

/**
 * 列顺序 = §3.1 表格顺序，也是 Anki `#columns:` 的顺序。
 *
 * `unlisted` 夹在 `status` 与 `createdAt` 之间（§3.1 的原顺序），
 * 它默认不出现在任何格式里，只在用户勾选后进 CSV。
 */
export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: 'word', csvHeader: 'word', ankiHeader: '单词', inAnki: true, csvDefault: true },
  { key: 'phonetic', csvHeader: 'phonetic', ankiHeader: '美音音标', inAnki: true, csvDefault: true },
  { key: 'definition', csvHeader: 'definition', ankiHeader: '释义', inAnki: true, csvDefault: true },
  { key: 'examples', csvHeader: 'examples', ankiHeader: '例句', inAnki: true, csvDefault: true },
  {
    key: 'exampleTranslations',
    csvHeader: 'example_translations',
    ankiHeader: '例句翻译',
    inAnki: true,
    csvDefault: true,
  },
  { key: 'source', csvHeader: 'source', ankiHeader: '来源URL', inAnki: true, csvDefault: true },
  { key: 'examTags', csvHeader: 'examTags', ankiHeader: '考试标签', inAnki: true, csvDefault: true },
  { key: 'frequency', csvHeader: 'frequency', ankiHeader: '词频', inAnki: true, csvDefault: true },
  { key: 'meetCount', csvHeader: 'meetCount', ankiHeader: '遇见次数', inAnki: true, csvDefault: true },
  { key: 'status', csvHeader: 'status', ankiHeader: '状态', inAnki: true, csvDefault: true },
  { key: 'unlisted', csvHeader: 'unlisted', ankiHeader: '词库未收录', inAnki: false, csvDefault: false },
  { key: 'createdAt', csvHeader: 'createdAt', ankiHeader: '创建时间', inAnki: true, csvDefault: true },
];

/** 一行导出记录：每列都是**已清洗**的字符串 */
export type ExportRecord = Record<ExportColumnKey, string>;

export interface RecordInput {
  word: Word;
  /** 该词的全部例句（无需预排序，`buildRecord` 内部会排） */
  scenes: readonly Scene[];
}

/**
 * §3.2.5：导出前对字段做换行归一化，并清洗控制字符。
 *
 * 具体口径：
 * - CRLF / CR → LF（同一句话在不同来源里行尾不同，不归一化就会在字段里留下 `\r`）；
 * - 去掉 C0 / DEL / C1 控制字符（**保留 `\n`**）——它们在背单词 App 里不可见，
 *   却会让"记录数 = 词数"这类逐字节断言出现无法解释的差异；
 * - 制表符 → 空格：TSV 的字段虽然被引号包裹，含制表符的字段在那个文件里没法人工核对；
 * - 每行 trim、丢掉空行。
 */
export function cleanText(raw: string): string {
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\t/g, ' ');

  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** 单行字段（单词、音标、URL、标签……）：换行折成空格 */
export function cleanSingleLine(raw: string): string {
  return cleanText(raw).replace(/\n+/g, ' ').trim();
}

/** 多个值各占一行 */
export function joinLines(values: readonly string[]): string {
  return values.map(cleanText).filter((line) => line !== '').join('\n');
}

/**
 * 例句与译文**按行对齐**（`decisions/0018`）。
 *
 * 第 n 行的译文对应第 n 条例句；没翻译的位置留**空行**，因此两个字段的行号永远对得上。
 * 末尾的空行裁掉（裁掉不丢信息），中间的空行必须保留——那正是"这一句没翻译"的表达。
 */
export function joinAligned(values: readonly (string | null | undefined)[]): string {
  const cleaned = values.map((value) => cleanText(value ?? ''));

  let end = cleaned.length;
  while (end > 0 && cleaned[end - 1] === '') end -= 1;

  return cleaned.slice(0, end).join('\n');
}

/**
 * 例句顺序：按采集时间升序，同一时刻再按 id 兜底。
 *
 * 必须有确定的顺序：导出的 `source`（首条例句来源）与"例句/译文按行对齐"
 * 都依赖它，顺序不确定就会让同一份数据两次导出得到不同文件。
 */
export function sortScenes(scenes: readonly Scene[]): Scene[] {
  return [...scenes].sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
}

/**
 * 词频列（§3.1 的 "BNC / COCA"）。
 *
 * 0 表示**没有这个来源的数据**，因此不出现（而不是显示 `BNC 0`——那会被误读成"词频是 0"）。
 * 两个都为 0 时该列为空串。
 */
export function formatFrequency(word: Word): string {
  const parts: string[] = [];
  if (word.freqBnc > 0) parts.push(`BNC ${word.freqBnc}`);
  if (word.freqCoca > 0) parts.push(`COCA ${word.freqCoca}`);
  return parts.join(' / ');
}

/**
 * 释义列：`defZh` 为空时退回 `fallbackDef`。
 *
 * 为什么需要兜底：迁移来的、词库未收录的词（FR-J5）释义只存在 `fallbackDef` 里，
 * 只看 `defZh` 会让这些词导出一片空白——那正是用户最想带走的东西。
 */
export function definitionOf(word: Word): string {
  return joinLines(word.defZh.length > 0 ? word.defZh : word.fallbackDef);
}

export function buildRecord({ word, scenes }: RecordInput): ExportRecord {
  const ordered = sortScenes(scenes);

  return {
    word: cleanSingleLine(word.lemma),
    // §3.1：形如 `/rʌn/`；没有美音音标就留空（英音不在范围内，见 §1 范围排除）
    phonetic: word.phoneticUs ? `/${cleanSingleLine(word.phoneticUs)}/` : '',
    definition: definitionOf(word),
    examples: joinAligned(ordered.map((scene) => scene.text)),
    exampleTranslations: joinAligned(ordered.map((scene) => scene.translation)),
    // §3.1：**首条例句**的来源 URL
    source: cleanSingleLine(ordered[0]?.sourceUrl ?? ''),
    examTags: cleanSingleLine(word.examTags.join(',')),
    frequency: formatFrequency(word),
    meetCount: String(word.meetCount),
    status: word.status,
    unlisted: word.isUnlisted ? 'true' : 'false',
    createdAt: new Date(word.createdAt).toISOString(),
  };
}

/**
 * 批量构建。
 *
 * **不改入参顺序**：记录顺序就是列表里的顺序（管理台已按用户选的排序排好），
 * 导出的文件顺序因此与用户在界面上看到的一致。
 */
export function buildRecords(inputs: readonly RecordInput[]): ExportRecord[] {
  return inputs.map(buildRecord);
}

/** CSV 默认勾选的列（FR-G3） */
export function defaultCsvColumns(): ExportColumnKey[] {
  return EXPORT_COLUMNS.filter((column) => column.csvDefault).map((column) => column.key);
}
