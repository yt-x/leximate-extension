/**
 * 取数匹配键的归一化变体（FR-B3a 的取数口径，`changes/M1M2-closeout.md` 切片 6）。
 *
 * 为什么需要：`scripts/fetch-inflections.ts` 用 `VALUES ?lemma { "american"@en }`
 * 做**精确字符串匹配**，而 Wikidata 的 en lemma 常常不是我们词表里那个写法——
 * 实测 2026-10-18：
 *
 * | 我们的词 | Wikidata 的 lemma | 差异类型 |
 * |---|---|---|
 * | `american` | `American` | 大小写 |
 * | `favor` | `favour` | 英美拼写 |
 * | `o'clock` | `o’clock`（U+2019） | 字符 |
 * | `north-east` | `northeast` | 连字符 |
 *
 * 61 个缺口里 33 个是这类**取数键不匹配**，不是"Wikidata 没收录"。
 * 本模块只生成候选键，不判断对错——命中与否由 SPARQL 返回决定。
 */

/** 英美拼写对照（只收与本项目词表相关的常见类型，不做通用转换） */
const SPELLING_PAIRS: Array<[string, string]> = [
  ['favor', 'favour'],
  ['rumor', 'rumour'],
  ['labor', 'labour'],
  ['favorite', 'favourite'],
  ['organization', 'organisation'],
  ['color', 'colour'],
  ['honor', 'honour'],
  ['neighbor', 'neighbour'],
  ['behavior', 'behaviour'],
  ['center', 'centre'],
  ['theater', 'theatre'],
  ['traveler', 'traveller'],
  ['defense', 'defence'],
  ['license', 'licence'],
  ['catalog', 'catalogue'],
  ['dialog', 'dialogue'],
  ['program', 'programme'],
  ['analyze', 'analyse'],
  ['realize', 'realise'],
  ['recognize', 'recognise'],
  ['organize', 'organise'],
];

/** 词尾规则（覆盖 -ize/-ise、-or/-our 之外的常见派生，如 `meter → metre`） */
const SUFFIX_PAIRS: Array<[RegExp, string]> = [
  [/ize$/, 'ise'],
  [/izes$/, 'ises'],
  [/ized$/, 'ised'],
  [/izing$/, 'ising'],
  [/yze$/, 'yse'],
  [/yzed$/, 'ysed'],
  [/yzing$/, 'ysing'],
  [/or$/, 'our'],
  [/ors$/, 'ours'],
];

/** 归一化字符：弯引号 → 直引号 */
function normalizeChars(word: string): string {
  return word
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2010|\u2011|\u2012|\u2013|\u2014/g, '-');
}

/**
 * 生成该词的检索变体，按"最可能命中"的顺序，**去重且不含原词本身**。
 *
 * 只生成确定的变体，不做模糊推测（例如不加复数、不改词序）：
 * 多生成的键只会浪费查询预算，命不命中由 Wikidata 说了算。
 */
export function lemmaVariants(word: string): string[] {
  const base = normalizeChars(word.trim());
  const out = new Set<string>();

  const push = (value: string) => {
    if (value && value !== word) out.add(value);
  };

  // 1. 大小写
  push(base.charAt(0).toUpperCase() + base.slice(1));
  push(base.toUpperCase());
  if (base.includes('-')) {
    // `north-east` → `northeast` / `North-East` / `Northeast`
    const joined = base.replace(/-/g, '');
    push(joined);
    push(joined.charAt(0).toUpperCase() + joined.slice(1));
  }

  // 2. 字符归一：直引号 ↔ 弯引号（`o'clock` / `o’clock`），横线变体同理
  push(normalizeChars(base));
  push(base.replace(/'/g, '\u2019'));
  push(base.replace(/'/g, '\u2018'));
  push(base.replace(/-/g, '\u2010'));

  // 3. 英美拼写：整词对照
  const lower = base.toLowerCase();
  for (const [us, uk] of SPELLING_PAIRS) {
    if (lower === us) {
      push(uk);
      push(uk.charAt(0).toUpperCase() + uk.slice(1));
    } else if (lower === uk) {
      push(us);
      push(us.charAt(0).toUpperCase() + us.slice(1));
    }
  }

  // 4. 英美拼写：词尾规则
  for (const [pattern, replacement] of SUFFIX_PAIRS) {
    if (pattern.test(lower)) {
      const swapped = lower.replace(pattern, replacement);
      if (swapped !== lower) {
        push(swapped);
        push(swapped.charAt(0).toUpperCase() + swapped.slice(1));
      }
    }
  }

  // 5. 首字母大写 + 词尾规则（`marxist → Marxist`）
  const capitalized = base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  push(capitalized);

  return [...out];
}
