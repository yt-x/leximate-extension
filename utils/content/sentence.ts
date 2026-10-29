/**
 * 例句切句与清洗（PLAN.md FR-C1 / FR-C2 的实现口径）。
 *
 * 纯函数层：输入「块级容器的纯文本 + 选区在其中的偏移」，输出可直接入库的例句
 * 与高亮词**在清洗后文本里的**偏移。不碰 DOM（DOM 侧在 `scene.ts`），
 * 因此每条规则都能在 Node 里逐条断言——切句是最容易悄悄写错的一环。
 *
 * 为什么偏移要重算而不能直接用原下标：清洗会删零宽字符、把空白压缩成单空格，
 * 下标因此整体前移。直接拿原下标入库，导出时高亮就会偏。
 */

export interface SentenceCapture {
  /** 清洗后的例句文本；超长被截断时两端带 `…` */
  text: string;
  /** 被划的词在 `text` 里的起始偏移 */
  highlightFrom: number;
  /** 结束偏移（不含） */
  highlightTo: number;
}

/** FR-C2 的长度上限（清洗后） */
export const MAX_SENTENCE_CHARS = 500;
/** 截断窗口：词前留多少 */
export const CONTEXT_BEFORE = 200;
/** 截断窗口：词后留多少 */
export const CONTEXT_AFTER = 300;

/** 中英文句末标点 */
const ENDERS = new Set(['.', '!', '?', '…', '。', '！', '？']);

/** 句末标点后面跟着的收尾符号，算同一句的一部分 */
const CLOSERS = new Set(['"', "'", '”', '’', ')', '）', ']', '】', '》', '」', '』', '〉']);

/**
 * 缩写守卫：这些词后面的点**不是**句末。
 *
 * 清单刻意只收"出现在句中、后面跟人名或数字"的高频缩写——
 * 收太宽会把真正的句末吞掉（切不出句比切错更难查）。
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'jr',
  'sr',
  'vs',
  'etc',
  'eg',
  'ie',
  'no',
  'fig',
  'vol',
  'inc',
  'ltd',
  'co',
  'approx',
  'ca',
  'al',
  'cf',
  'esp',
  'min',
  'max',
  'dept',
  'univ',
  'est',
]);

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/;
const SPACE = /[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;
/** CJK 与全角标点：中文文本句末标点后常常**没有空格**，不能要求空白 */
const CJK_OR_FULLWIDTH = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/** 句点前的词元（字母与点组成的连续段），用于缩写判定 */
function tokenBefore(text: string, index: number): string {
  let k = index;
  while (k > 0 && /[A-Za-z.]/.test(text[k - 1] as string)) k -= 1;
  return text.slice(k, index);
}

function isAbbreviationToken(token: string): boolean {
  const lower = token.toLowerCase().replace(/\.+$/, '');
  if (lower === '') return false;
  if (ABBREVIATIONS.has(lower)) return true;

  // 单字母缩写（`J. Smith`）。`a` / `i` 是常见单词，放行
  if (lower.length === 1) return lower !== 'a' && lower !== 'i';

  // 点分缩写：`U.S.` / `U.S.A.` / `J.K.`
  return /^[A-Za-z](\.[A-Za-z])+\.?$/.test(token);
}

/** 句末标点之后是不是"该断的地方" */
function isBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index] as string;
  if (SPACE.test(ch)) return true;
  return CJK_OR_FULLWIDTH.test(ch);
}

/**
 * 这个位置是不是一句的结尾。
 *
 * `\n` 也算句界：字幕、列表项、聊天记录这类文本整行没有标点，
 * 不认换行就会把好几行粘成一句（那是比切短更糟的噪声）。
 */
export function isSentenceEnd(text: string, index: number): boolean {
  const ch = text[index];
  if (ch === '\n') return true;
  if (ch === undefined || !ENDERS.has(ch)) return false;

  let j = index + 1;
  while (j < text.length && CLOSERS.has(text[j] as string)) j += 1;
  if (!isBoundaryAfter(text, j)) return false;

  if (ch === '.') {
    // 小数 / 时间 / 版本号
    if (isDigit(text[index - 1]) && isDigit(text[index + 1])) return false;
    if (isAbbreviationToken(tokenBefore(text, index))) return false;
  }
  return true;
}

export interface SentenceBounds {
  /** 句子起点（含） */
  start: number;
  /** 句子终点（不含） */
  end: number;
}

/** 选区所在句在原始文本里的边界 */
export function sentenceBounds(text: string, selStart: number, selEnd: number): SentenceBounds {
  let start = 0;
  for (let i = selStart - 1; i >= 0; i -= 1) {
    if (isSentenceEnd(text, i)) {
      start = i + 1;
      break;
    }
  }

  let end = text.length;
  for (let i = Math.max(selEnd, 0); i < text.length; i += 1) {
    if (!isSentenceEnd(text, i)) continue;
    if (text[i] === '\n') {
      end = i;
      break;
    }
    let j = i + 1;
    while (j < text.length && CLOSERS.has(text[j] as string)) j += 1;
    end = j;
    break;
  }

  return { start, end };
}

interface Cleaned {
  text: string;
  /** `map[i]` = 清洗后第 i 个字符在原串里的下标 */
  map: number[];
}

/** 清洗并记录"清洗后 → 原串"的下标映射（FR-C2） */
export function cleanWithMap(raw: string): Cleaned {
  const chars: string[] = [];
  const map: number[] = [];
  /**
   * 待落地的空格在**原串里的第一个下标**（-1 表示没有待落地空格）。
   *
   * ⚠️ 必须记这一段空白的**首字符下标**，不能记"下一个非空白字符的下标"：
   * 后者会让一个落在空白之后的下标映射回那个空格，高亮范围于是左移一格
   * （`He  ran fast.` 里选 `fast` 会变成 ` fast`，导出时高亮就偏了）。
   */
  let pendingSpaceAt = -1;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (ZERO_WIDTH.test(ch)) continue;
    if (SPACE.test(ch)) {
      // 起始处的空白不落地（等价于 trimStart）
      if (chars.length > 0 && pendingSpaceAt < 0) pendingSpaceAt = i;
      continue;
    }
    if (pendingSpaceAt >= 0) {
      chars.push(' ');
      map.push(pendingSpaceAt);
      pendingSpaceAt = -1;
    }
    chars.push(ch);
    map.push(i);
  }

  return { text: chars.join(''), map };
}

/** 原串下标 → 清洗后下标（取第一个"原下标 ≥ 目标"的位置） */
function mapOffset(cleaned: Cleaned, rawOffset: number): number {
  let lo = 0;
  let hi = cleaned.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cleaned.map[mid] as number) < rawOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 超过上限时取"以高亮词为中心的窗口"（FR-C2 的口径）。
 *
 * 为什么不是"从句子开头截 500"：长句里被划的词常在**后半段**，
 * 从头截会把它整个切掉——例句里没有那个词，例句就没用了。
 * 被截断的一端补 `…`，让导出的人知道这里少了一段。
 */
export function applyWindow(text: string, from: number, to: number): SentenceCapture {
  if (text.length <= MAX_SENTENCE_CHARS) return { text, highlightFrom: from, highlightTo: to };

  let start = Math.max(0, from - CONTEXT_BEFORE);
  let end = Math.min(text.length, to + CONTEXT_AFTER);
  if (end - start > MAX_SENTENCE_CHARS) {
    end = Math.min(end, start + MAX_SENTENCE_CHARS);
    if (end < to) {
      // 词被切掉了 → 以词为锚重新平移窗口
      end = Math.min(text.length, to + CONTEXT_AFTER);
      start = Math.max(0, end - MAX_SENTENCE_CHARS);
    }
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const shift = prefix.length - start;

  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    highlightFrom: from + shift,
    highlightTo: to + shift,
  };
}

/**
 * 从"容器文本 + 选区偏移"切出例句。
 *
 * 返回 `null` 的三种情况都是**正常结果**（没有例句，不是错误）：
 * 容器文本为空、选区为空/越界、清洗后没有可读内容。
 */
export function extractSentence(
  blockText: string,
  selStart: number,
  selEnd: number,
): SentenceCapture | null {
  if (typeof blockText !== 'string' || blockText === '') return null;

  const from = Math.max(0, Math.min(selStart, blockText.length));
  const to = Math.max(from, Math.min(selEnd, blockText.length));
  if (from === to) return null;

  const { start, end } = sentenceBounds(blockText, from, to);
  if (end <= start) return null;

  const cleaned = cleanWithMap(blockText.slice(start, end));
  if (cleaned.text === '') return null;

  const relStart = mapOffset(cleaned, from - start);
  const relEnd = mapOffset(cleaned, to - start);
  if (relEnd <= relStart) return null;

  return applyWindow(cleaned.text, relStart, relEnd);
}
