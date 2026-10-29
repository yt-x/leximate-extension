/**
 * `ecdict.csv` 的解析与映射（PLAN.md FR-B7 / FR-B7a，`changes/M1M2-closeout.md` 切片 1）。
 *
 * 这一层是**纯函数**：文件文本 → 规范化行 → `Word` 草稿。不碰 IndexedDB、不做合并判断，
 * 与 `parse.ts` / `plan.ts` / `apply.ts` 的分层一致。
 *
 * 为什么要单开一个文件而不是塞进 `parse.ts`：ECDICT 与 MetWord/本项目 JSON 是两类东西——
 * 前者是**词库**（一条词条 = 一个词的全部静态信息，没有例句、没有遇见次数），
 * 后者是**用户数据**（词 + 例句 + 状态）。混在一起会让"导入"这个词有两套语义。
 *
 * 数据形态的实测依据见 `docs/reference/dictionary-data-sources.md` §7.11：
 * - 13 列带表头，UTF-8 无 BOM、CRLF；
 * - 引号内**零真实换行**，多词性用字面两字符 `\n` 分隔 → 按行切安全；
 * - 但 202,431 行字段内含半角逗号、1,519 行含双引号 → **必须 RFC4180 状态机**；
 * - `pos` 列全空 → 词性只能从 `translation` 前缀（`n.` / `vt.` / `a.`）识别。
 */
import type { DefinitionSource, PhoneticSource, DictEntry } from '../db/types';

/** 表头列序。**顺序即契约**：ECDICT 改了列序就等于换了格式，必须拒绝而不是猜 */
export const ECDICT_COLUMNS = [
  'word',
  'phonetic',
  'definition',
  'translation',
  'pos',
  'collins',
  'oxford',
  'tag',
  'bnc',
  'frq',
  'exchange',
  'detail',
  'audio',
] as const;

/**
 * 标准档判据：8 个考试标签任一非空（FR-B7 的「标准档 14,942 条」）。
 *
 * 顺序按覆盖度从窄到宽排，供界面展示用；判据本身与顺序无关。
 */
export const ECDICT_STANDARD_TAGS = ['zk', 'gk', 'ky', 'cet4', 'cet6', 'toefl', 'ielts', 'gre'] as const;

/** 一条已解析的 ECDICT 行（字段名与列序对应，全部是字符串原样） */
export interface EcdictRow {
  word: string;
  phonetic: string;
  definition: string;
  translation: string;
  pos: string;
  collins: string;
  oxford: string;
  tag: string;
  bnc: string;
  frq: string;
  exchange: string;
  detail: string;
  audio: string;
}

export interface EcdictParseResult {
  rows: EcdictRow[];
  /** 字段数异常 / 空词条的行数（**跳过并计数，不静默**） */
  skipped: number;
  /** 表头是否合规；`false` 时 `rows` 必为空 */
  headerOk: boolean;
  reason?: string;
}

/** 映射出来的词条草稿：只带静态词典字段，不含用户数据 */
export interface EcdictWordDraft {
  lemma: string;
  surface: string;
  phoneticUs: string;
  phoneticUk: string;
  phoneticSrc: PhoneticSource;
  defSrc: DefinitionSource;
  defZh: string[];
  pos: string[];
  examTags: string[];
  freqBnc: number;
  freqCoca: number;
  exchange: string;
  fallbackDef: string[];
  isUnlisted: boolean;
}

/**
 * RFC4180 状态机：按引号切分一行。
 *
 * 处理三件事：引号内的逗号不切、`""` 还原成一个半角引号、引号外的逗号是分隔符。
 * **不做**引号内换行——实测 ECDICT 的引号内没有真实换行，多词性用字面 `\n`。
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** 表头校验：13 列逐字匹配，顺序也算。BOM 与 CR 不算错。 */
export function parseEcdictHeader(line: string): { ok: boolean; reason?: string } {
  const cleaned = line.replace(/^\uFEFF/, '').replace(/\r$/, '');
  const got = splitCsvLine(cleaned);
  if (got.length !== ECDICT_COLUMNS.length) {
    return {
      ok: false,
      reason: `表头列数不符：期望 ${ECDICT_COLUMNS.length} 列，实际 ${got.length} 列`,
    };
  }
  const mismatch = ECDICT_COLUMNS.findIndex((name, i) => (got[i] ?? '').trim() !== name);
  if (mismatch >= 0) {
    return {
      ok: false,
      reason: `表头第 ${mismatch + 1} 列应为 ${ECDICT_COLUMNS[mismatch]}，实际为 ${got[mismatch]}`,
    };
  }
  return { ok: true };
}

/** 解析单行；字段数不符或词条为空时返回 `null`（由上层计数） */
export function parseEcdictLine(line: string): EcdictRow | null {
  if (line.trim() === '') {
    return null;
  }
  const cells = splitCsvLine(line.replace(/\r$/, ''));
  if (cells.length !== ECDICT_COLUMNS.length) {
    return null;
  }
  const row = Object.fromEntries(
    ECDICT_COLUMNS.map((name, i) => [name, cells[i]]),
  ) as unknown as EcdictRow;
  if (row.word.trim() === '') {
    return null;
  }
  return row;
}

/** 解析整份文件：先验表头，再逐行；坏行计入 `skipped` 而不中断 */
export function parseEcdictRows(text: string): EcdictParseResult {
  const lines = text.split(/\r?\n/);
  // 文件末尾无换行是实测事实；末尾空行不产生坏行
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return { rows: [], skipped: 0, headerOk: false, reason: '文件为空' };
  }
  const header = parseEcdictHeader(lines[0] ?? '');
  if (!header.ok) {
    return { rows: [], skipped: 0, headerOk: false, reason: header.reason };
  }
  const rows: EcdictRow[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      continue; // 空行不是坏行
    }
    const row = parseEcdictLine(line);
    if (row === null) {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, skipped, headerOk: true };
}

/** 标准档判据：任一考试标签非空 */
export function isStandardTier(tag: string): boolean {
  const tags = tag.split(/\s+/).filter(Boolean);
  return tags.some((t) => (ECDICT_STANDARD_TAGS as readonly string[]).includes(t));
}

/** 从 `translation` 的行首识别词性缩写（FR-B7a：ECDICT 的 pos 列全空） */
const POS_PREFIX = /^([a-z]{1,4})\.\s/;
const KNOWN_POS = new Set(['n', 'v', 'vt', 'vi', 'a', 'adj', 'ad', 'adv', 'prep', 'conj', 'pron', 'num', 'art', 'int', 'abbr']);

export function posFromTranslation(translation: string): string[] {
  const out: string[] = [];
  for (const part of translation.split('\\n')) {
    const m = POS_PREFIX.exec(part.trim());
    if (!m) {
      continue;
    }
    const abbr = m[1] ?? '';
    const pos = `${abbr}.`;
    if (KNOWN_POS.has(abbr) && !out.includes(pos)) {
      out.push(pos);
    }
  }
  return out;
}

/** `translation` 里的字面 `\n` 拆成多行，空行丢弃 */
export function translationLines(translation: string): string[] {
  return translation
    .split('\\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * 行 → 词条草稿。
 *
 * 口径（`plan/b-dictionary.md` FR-B7a / FR-B9 / FR-B10）：
 * - 释义写进 **`defZh`**（多行按 `\n` 拆开），来源标 `defSrc='imported'`——
 *   `defZh` 的语义是"这个词的释义"，来源由 `defSrc` 区分；内置词的释义是
 *   `'authored'`，导入词的释义是 `'imported'`，两者不会互相覆盖（内置词在导入时被跳过）；
 * - `fallbackDef` **留空**：那是迁移数据（MetWord 存量）专用的字段，不是导入词的家；
 * - 音标原样保留并标 `imported`——ECDICT 音标不是 IPA，不得伪装成管线产物。
 */
export function mapRowToWord(row: EcdictRow): EcdictWordDraft {
  const phonetic = row.phonetic.trim();
  const surface = row.word.trim();
  return {
    lemma: surface.toLowerCase(),
    surface,
    phoneticUs: phonetic,
    phoneticUk: '',
    phoneticSrc: phonetic === '' ? null : 'imported',
    defSrc: 'imported',
    defZh: translationLines(row.translation),
    pos: posFromTranslation(row.translation),
    examTags: row.tag.split(/\s+/).filter(Boolean),
    // 0 表示无排名，但仍是合法的数字（筛选时按 0 视为无排名处理，见 FR-F4）
    freqBnc: Number.parseInt(row.bnc, 10) || 0,
    freqCoca: Number.parseInt(row.frq, 10) || 0,
    exchange: row.exchange.trim(),
    fallbackDef: [],
    isUnlisted: false,
  };
}

/**
 * 行 → 可直接写入 `dict` store 的 `DictEntry`（`decisions/0031`）。
 *
 * **注意它不产出 `Word`**：词典条目没有 `status` / `meetCount` / `deletedAt` /
 * `createdAt`——那些是用户行为，词典条目永远不会有。上一轮把它们塞进 `Word`，
 * 才逼出"到处过滤 defSrc"的补丁；现在类型上就不给这个机会。
 */
export function buildDictEntry(row: EcdictRow): DictEntry {
  const draft = mapRowToEntry(row);
  return {
    lemma: draft.lemma,
    surface: draft.surface,
    phoneticUs: draft.phoneticUs,
    phoneticSrc: draft.phoneticSrc,
    defZh: draft.defZh,
    pos: draft.pos,
    examTags: draft.examTags,
    freqBnc: draft.freqBnc,
    freqCoca: draft.freqCoca,
    exchange: draft.exchange,
    source: 'ecdict',
  };
}

/** `mapRowToWord` 的词典版本（字段与 `DictEntry` 一致） */
export function mapRowToEntry(row: EcdictRow): DictEntry {
  const phonetic = row.phonetic.trim();
  const surface = row.word.trim();
  return {
    lemma: surface.toLowerCase(),
    surface,
    phoneticUs: phonetic,
    phoneticSrc: phonetic === '' ? null : 'imported',
    defZh: translationLines(row.translation),
    pos: posFromTranslation(row.translation),
    examTags: row.tag.split(/\s+/).filter(Boolean),
    freqBnc: Number.parseInt(row.bnc, 10) || 0,
    freqCoca: Number.parseInt(row.frq, 10) || 0,
    exchange: row.exchange.trim(),
    source: 'ecdict',
  };
}