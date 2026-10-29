/**
 * 导入文件的解析（PLAN.md FR-J4）。
 *
 * 支持两种 JSON，**不猜第三种**：
 *
 * | 格式 | 识别依据 | 来源 |
 * |---|---|---|
 * | `metword` | 顶层有 `meta`，词上有 `word` 字段 | M0 脚本在 MetWord 页面里导出（`tools/metword-export/export.js`） |
 * | `leximate` | `app === 'leximate'` 且带 `schemaVersion` | 本项目 M1-7 的导出面板 |
 *
 * 这一层只做"文件 → 规范化的数据"，**不碰数据库、不做合并判断**：
 * 合并是 `plan.ts` 的事。分开的理由是两类错误完全不同——
 * "文件读不懂"要报给用户看，"合并策略错了"要改代码。
 *
 * ⚠️ 坏条目**跳过并计数**，不静默：用户拿到的是"导入了 537 个词，跳过 2 条坏记录"，
 * 而不是"导入了 537 个词"却发现少了两个。
 */
import { tx } from '../i18n';
import type {
  DefinitionSource,
  PhoneticSource,
  Word,
  WordOrigin,
  WordStatus,
} from '../db/types';

export type ImportFormat = 'metword' | 'leximate';

export interface ImportScene {
  text: string;
  /** 被划词在 `text` 中的起始偏移。文件里的 `-1`（"没找到"）在解析时归一为 0 */
  highlightFrom: number;
  highlightTo: number;
  sourceUrl: string;
  /** epoch 毫秒；文件里解析不出来时为 `null`，由计划层用导入时间兜底 */
  capturedAt: number | null;
  translation: string | null;
}

export interface ImportWord {
  /** 文件里的原始词形（metword）或 lemma（leximate） */
  raw: string;
  /** 页面上见到的形态（保留大小写与变形） */
  surface: string;
  phoneticUs: string;
  phoneticUk: string;
  defZh: string[];
  meetCount: number;
  status: WordStatus;
  origin: WordOrigin;
  /** "第一次见到"的时间；metword 用 `firstSeenAt` 文本，leximate 用 `createdAt` */
  createdAt: number | null;
  scenes: ImportScene[];
  /**
   * 本项目的备份里那条**原始记录**（只在 `leximate` 格式下存在）。
   *
   * 为什么要带着它：备份是**回灌**，词典侧的字段（`examTags` / `freqBnc` /
   * `defSrc` / `phoneticSrc` / `inflectionOf` …）在 metword 文件里根本没有，
   * 只能从备份记录里原样带回来——否则"导出再导入"会静默丢掉一批字段。
   * 合并时它的优先级低于"库里已有的记录"（FR-J5 的合并语义不变）。
   */
  backup: Word | null;
}

export interface ImportBundle {
  format: ImportFormat;
  schemaVersion: number | null;
  exportedAt: string | null;
  /** 文件里的词条数（未去重） */
  words: ImportWord[];
  /** 跳过的坏词条（不是对象 / 没有词形） */
  skippedWords: number;
  /** 跳过的坏例句（没有文本 / 时间等字段） */
  skippedScenes: number;
  /** 时间无法解析、将由导入时间兜底的条目数（词 + 例句） */
  unparsedTimes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 时间容错解析。
 *
 * 为什么需要：M0 的 `capturedAt` / `firstSeenAt` 是**页面上的日期文本**
 * （脚本取的是链接的 `title`），不是 epoch；而本项目的备份是 epoch 毫秒。
 * 解析不出来时返回 `null`——由计划层用导入时间兜底并计数，
 * **不假装它是 0**（1970 年的时间戳会让"按时间排序"整片前排）。
 */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text === '') return null;

  // 数字字符串也当 epoch 处理（有些导出会把时间写成字符串）
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n > 0 ? n : null;
  }

  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;

  // 常见的 `2026-10-13 21:03` 形态：Safari 与部分 Node 版本不认空格分隔
  const withT = Date.parse(text.replace(' ', 'T'));
  return Number.isFinite(withT) ? withT : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter((item) => item !== '');
}

function asCount(value: unknown, fallback = 1): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return fallback;
}

function asStatus(value: unknown): WordStatus {
  return value === 'known' || value === 'ignored' || value === 'new' ? value : 'new';
}

/**
 * 备份里的原始词记录。
 *
 * 只认**有 id 与 lemma** 的记录（其它一律当没有：缺 id 就新建一个 id，
 * 而不是把 undefined 当 id 写进库）。字段逐个取值并给默认值——
 * 备份可能来自更早的版本，缺字段是常态而不是损坏。
 */
function parseBackupWord(raw: Record<string, unknown>): Word | null {
  const id = asString(raw.id);
  const lemma = asString(raw.lemma);
  if (id === '' || lemma === '') return null;

  const surface = asString(raw.surface) || lemma;
  const phoneticUs = asString(raw.phoneticUs);
  const phoneticUk = asString(raw.phoneticUk);
  const phoneticSrc: PhoneticSource =
    raw.phoneticSrc === 'pipeline' || raw.phoneticSrc === 'imported'
      ? raw.phoneticSrc
      : phoneticUs !== '' || phoneticUk !== ''
        ? 'imported'
        : null;
  const defZh = asStringArray(raw.defZh);
  const defSrc: DefinitionSource =
    raw.defSrc === 'authored' || raw.defSrc === 'imported' || raw.defSrc === 'llm'
      ? raw.defSrc
      : defZh.length > 0
        ? 'imported'
        : null;

  return {
    id,
    lemma,
    surface,
    phoneticUs,
    phoneticUk,
    phoneticSrc,
    defSrc,
    defZh,
    pos: asStringArray(raw.pos),
    examTags: asStringArray(raw.examTags),
    freqBnc: asCount(raw.freqBnc, 0),
    freqCoca: asCount(raw.freqCoca, 0),
    exchange: asString(raw.exchange),
    status: asStatus(raw.status),
    meetCount: Math.max(1, asCount(raw.meetCount, 1)),
    isLemmatized: raw.isLemmatized === true || surface.trim().toLowerCase() !== lemma,
    inflectionOf: asString(raw.inflectionOf) || null,
    isUnlisted: raw.isUnlisted === true,
    origin: raw.origin === 'migrated' ? 'migrated' : 'native',
    fallbackDef: asStringArray(raw.fallbackDef),
    llmDef: asStringArray(raw.llmDef),
    createdAt: parseTime(raw.createdAt) ?? 0,
    updatedAt: parseTime(raw.updatedAt) ?? 0,
    deletedAt: null,
  };
}

/**
 * 高亮偏移的归一。
 *
 * M0 脚本在页面上找不到高亮词时写 `-1`（`verification/M0-2.md` 说实测 623 条全部命中，
 * 但那是那一次的数据，不能当成保证）。`-1` 会让界面上的切片落空，
 * 因此这里一律夹到 `[0, text.length]`，并保证 `from <= to`。
 */
export function safeSpan(
  text: string,
  from: unknown,
  to: unknown,
): { highlightFrom: number; highlightTo: number } {
  const f = Math.floor(typeof from === 'number' ? from : Number.NaN);
  const t = Math.floor(typeof to === 'number' ? to : Number.NaN);
  const start = Number.isFinite(f) ? Math.min(Math.max(f, 0), text.length) : 0;
  const end = Number.isFinite(t) ? Math.min(Math.max(t, start), text.length) : start;
  return { highlightFrom: start, highlightTo: end };
}

/** 识别格式；认不出来返回 `null`（调用方据此报错，不猜） */
export function detectFormat(value: unknown): ImportFormat | null {
  if (!isRecord(value) || !Array.isArray(value.words)) return null;

  if (value.app === 'leximate' && typeof value.schemaVersion === 'number') return 'leximate';

  // metword：有 meta，且词上带 `word` 字段（`lemma` 是本项目备份的字段名）
  if (isRecord(value.meta)) return 'metword';
  const first = value.words[0];
  if (isRecord(first)) {
    if (typeof first.word === 'string' && typeof first.lemma !== 'string') return 'metword';
    if (typeof first.lemma === 'string') return 'leximate';
  }
  return null;
}

export interface ParseError extends Error {
  name: 'ImportParseError';
}

function fail(message: string): never {
  const error = new Error(message) as ParseError;
  error.name = 'ImportParseError';
  throw error;
}

/** 解析一份导入文件。格式不认识或 JSON 不合法都直接抛错（带人话说明） */
export function parseImport(text: string): ImportBundle {
  if (text.trim() === '') fail(tx('文件是空的'));

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(tx('这不是一个合法的 JSON 文件'));
  }

  const format = detectFormat(value);
  if (format === null) {
    fail(tx('认不出这个文件的格式：需要 MetWord 导出（meta + words）或本项目的 JSON 备份（app: leximate）'));
  }

  const root = value as Record<string, unknown>;
  const list = root.words as unknown[];

  const scenesById = new Map<string, unknown[]>();
  if (format === 'leximate' && Array.isArray(root.scenes)) {
    for (const scene of root.scenes) {
      if (!isRecord(scene)) continue;
      const wordId = asString(scene.wordId);
      if (wordId === '') continue;
      const bucket = scenesById.get(wordId);
      if (bucket) bucket.push(scene);
      else scenesById.set(wordId, [scene]);
    }
  }

  const words: ImportWord[] = [];
  let skippedWords = 0;
  let skippedScenes = 0;
  let unparsedTimes = 0;

  const readScene = (raw: unknown): ImportScene | null => {
    if (!isRecord(raw)) {
      skippedScenes += 1;
      return null;
    }
    const sceneText = asString(raw.text);
    if (sceneText === '') {
      skippedScenes += 1;
      return null;
    }
    const capturedAt = parseTime(raw.capturedAt);
    if (capturedAt === null) unparsedTimes += 1;
    const span = safeSpan(sceneText, raw.highlightFrom, raw.highlightTo);
    return {
      text: sceneText,
      ...span,
      sourceUrl: asString(raw.sourceUrl),
      capturedAt,
      translation: typeof raw.translation === 'string' && raw.translation !== '' ? raw.translation : null,
    };
  };

  for (const raw of list) {
    if (!isRecord(raw)) {
      skippedWords += 1;
      continue;
    }

    const isLeximate = format === 'leximate';
    const rawWord = isLeximate ? asString(raw.lemma) : asString(raw.word);
    if (rawWord === '') {
      skippedWords += 1;
      continue;
    }

    // 例句：metword 挂在词上；leximate 在顶层按 wordId 挂
    const sceneSource = isLeximate
      ? (scenesById.get(asString(raw.id)) ?? [])
      : Array.isArray(raw.scenes)
        ? raw.scenes
        : [];

    const scenes: ImportScene[] = [];
    for (const item of sceneSource) {
      const scene = readScene(item);
      if (scene) scenes.push(scene);
    }

    const createdAt = isLeximate ? parseTime(raw.createdAt) : parseTime(raw.firstSeenAt);
    if (createdAt === null) unparsedTimes += 1;

    // metword 的次数有两个来源：API 展开表的 `meetCount` 与页面上的 `meetCountLabel`。
    // 脚本已经优先取 API 值，这里同样优先，缺失才回退到标签
    const meetCount = isLeximate
      ? asCount(raw.meetCount, 1)
      : asCount(raw.meetCount ?? raw.meetCountLabel, 1);

    words.push({
      raw: rawWord,
      surface: asString(raw.surface) || rawWord,
      phoneticUs: asString(raw.phoneticUs),
      phoneticUk: asString(raw.phoneticUk),
      defZh: asStringArray(raw.defZh),
      meetCount: Math.max(1, meetCount),
      status: asStatus(raw.status),
      origin: isLeximate ? (raw.origin === 'migrated' ? 'migrated' : 'native') : 'migrated',
      createdAt,
      scenes,
      backup: isLeximate ? parseBackupWord(raw) : null,
    });
  }

  if (words.length === 0) fail(tx('文件里没有可导入的词条'));

  return {
    format,
    schemaVersion: typeof root.schemaVersion === 'number' ? root.schemaVersion : null,
    exportedAt: isRecord(root.meta)
      ? asString(root.meta.exportedAt) || null
      : asString(root.exportedAt) || null,
    words,
    skippedWords,
    skippedScenes,
    unparsedTimes,
  };
}
