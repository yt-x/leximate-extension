/**
 * 单词判定（PLAN.md FR-A2、FR-A16）。
 *
 * 回答一个问题：**用户在页面上选中的一段文本，算不算一个可查的词？**
 *
 * 这一层刻意是**纯函数**——不碰 DOM、不碰选区、不碰浏览器 API。原因是 FR-A16 要求
 * "规则表逐条有单元测试"，而规则一旦混进 DOM 逻辑就没法逐条测了。
 * 选区取文本、跨节点归一那些事在 `selection.ts` 里做。
 *
 * 顺序（规格明确要求）：**先判定，后归一化**。判定不通过就不进入查表，
 * 免得把 `3.14` 归一成 `314` 去查一次库。
 */

/** 判定结果：要么给出可查的词，要么给出拒绝的理由（便于测试与诊断） */
export type WordVerdict =
  | { ok: true; word: string }
  | { ok: false; reason: WordRejectReason };

export type WordRejectReason =
  /** 空的或全是空白 */
  | 'empty'
  /** 超过 FR-A16 的 45 字符上限 */
  | 'too-long'
  /** 不含任何字母（纯数字、纯符号） */
  | 'no-letter'
  /** 含空格等，超出"单词"的范围（短语不做，见 OQ2） */
  | 'not-a-word'
  /**
   * 选区**切在词中间**（`proof` 里只选到 `proo`，FR-A16 的「完整性」行）。
   *
   * 这不是"词形不合法"，而是"用户没选中一个词"——因此不弹可收藏的卡片。
   */
  | 'partial'
  /**
   * 短于设置的 `minWordLength`（FR-F9 的"最短词长"）。
   *
   * ⚠️ 这一条**不属于 FR-A16 的规则表**——规则表管的是"词形长什么样"，
   * 而最短词长是**用户设置**。因此判定顺序是：规则表通过 → 再过这一关。
   */
  | 'too-short';

/** FR-A16：单词长度上限 */
export const MAX_WORD_LENGTH = 45;

/**
 * 允许出现在词内部的字符：
 * - 字母（含变音符号，`naïve` / `café`）
 * - 数字（`COVID-19` / `3D`）
 * - 内部连字符与撇号（`well-known` / `don't` / `students'`）
 *
 * 用 Unicode 属性转义而不是 `a-z`：`\p{L}` 覆盖重音字母，免得为 `naïve` 单独开特例。
 */
const ALLOWED_BODY = /^[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*['’]?$/u;

/** 至少一个字母——数字与符号单独出现不算词 */
const HAS_LETTER = /\p{L}/u;

/**
 * 判定一段文本是不是可查的词（FR-A2 / FR-A16）。
 *
 * 规则表逐条对应：
 * | 情形 | 规则 |
 * |---|---|
 * | 长度上限 | 45 字符，超出不弹窗 |
 * | 数字混排 | 允许数字在词内或词尾，但**整段必须至少含一个字母** |
 * | 连字符 | 整体作为一个词，**不做左右拆分** |
 * | 撇号 | 整体查表，**不做词尾剥离** |
 * | 明确不做 | 不做词干化、不做短语拆分 |
 *
 * 判定使用 NFC，避免组合记号被当成非法字符；返回的 `word` 仍是 trim 后的页面原形式，
 * 查表时的 NFC、小写与去变音符回退由 `normalizeForLookup` / `lookupCandidates` 负责。
 */
export function judgeWord(raw: string): WordVerdict {
  // 首尾空白不算内容；内部的空白会让它变成短语
  const text = raw.trim();
  const normalized = text.normalize('NFC');
  if (normalized === '') return { ok: false, reason: 'empty' };

  if ([...normalized].length > MAX_WORD_LENGTH) return { ok: false, reason: 'too-long' };
  if (!HAS_LETTER.test(normalized)) return { ok: false, reason: 'no-letter' };

  // 内部有空白 = 短语（OQ2：本期只做单词）
  if (/\s/.test(normalized)) return { ok: false, reason: 'not-a-word' };

  if (!ALLOWED_BODY.test(normalized)) return { ok: false, reason: 'not-a-word' };

  return { ok: true, word: text };
}

/**
 * 判定"选区是不是**覆盖了整个词**"（FR-A16 的「完整性」行）。
 *
 * 规格原话：`proof` 里只选到 `proo` **不算选中了一个词**。
 * 判据是选区**两端紧邻的字符**：任一仍是词字符，就说明选区切在词中间。
 *
 * 词字符 = 字母 / 数字 / 词内连字符（`well-known` 里选 `well` 是半截）。
 *
 * ⚠️ **撇号不算边界字符**：它在英文里既可能是词内字符（`don't`）也可能是引号
 * （`'proof'`）。若把撇号当词字符，`'proof'` 这种带引号的整词选择会被误判成
 * "前后还有词字符"。宁可漏判"从 `don't` 里选了 `don`"这一种，也不误伤成对引号。
 *
 * `before` / `after` 由浏览器层从 Range 起止点取（取不到就是空串）——
 * 本函数保持纯函数，因此规则表这一行可以逐条单测（FR-A16 的验收要求）。
 */
export function isWholeWordSelection(before: string, after: string): boolean {
  // 生产路径上 `before` / `after` 由 `controller.ts::adjacentChars` 给出，
  // 它已经处理了"选区自身两端带空白"的情况（返回空串）。
  // 这里再 trim 一次是防御：本函数是纯函数，将来若有别的调用方传入带空白的
  // 端点字符，也不该把"词与词之间的空白"当成"切在词中间"。
  const prev = [...before.replace(/\s+$/, '')].pop() ?? '';
  const next = [...after.replace(/^\s+/, '')][0] ?? '';
  return !isWordBoundaryChar(prev) && !isWordBoundaryChar(next);
}

/** 该字符是否让"选区切在词中间"（含连字符，**不含**撇号） */
function isWordBoundaryChar(char: string): boolean {
  if (char === '') return false;
  return /[\p{Script=Latin}\p{N}\-]/u.test(char);
}

/**
 * 查表用的归一化（FR-A16 的"归一化"行 + FR-A16「大小写」行）。
 *
 * 与 `utils/dict/lookup.ts` 的 `normalizeSurface` 的分工：
 * 那个函数服务的是"已经确定是个词"之后的查表清理；本函数服务的是**判定通过后**
 * 把词变成查表键，额外承担 FR-A16 的 NFC 与去变音符要求。
 *
 * 重音符号（FR-A16）：`naïve` 先按原样查，未命中再按去变音符的 `naive` 查。
 * 因此本函数**只做 NFC + 小写**，去变音符是**第二个候选**，由 `lookupCandidates` 给出。
 */
export function normalizeForLookup(raw: string): string {
  return raw.normalize('NFC').toLowerCase();
}

/**
 * 去掉变音符号：`naïve` → `naive`、`café` → `cafe`。
 *
 * 用 NFD 先分解成"基字母 + 组合记号"，再把组合记号去掉。
 */
export function stripDiacritics(raw: string): string {
  return raw.normalize('NFD').replace(/\p{M}+/gu, '');
}

/**
 * 查表候选，**按优先级排序**（FR-A16 的重音符号规则）。
 *
 * - 页面写 `naïve`：先查 `naïve`，未命中再查 `naive`
 * - 页面写 `naive`：先查 `naive`，未命中再查……没有 `naive` 的词库条目时，
 *   规格要求"双向都成立"，即反过来也要能命中。实现方式是把两个方向都作为候选，
 *   由调用方按顺序试——**去变音符方向永远在后**，保证"原样优先"。
 *
 * 结果已去重：`naive` 的两个候选都是 `naive` 时只留一个。
 */
export function lookupCandidates(raw: string): string[] {
  const base = normalizeForLookup(raw);
  const stripped = stripDiacritics(base);
  return base === stripped ? [base] : [base, stripped];
}
