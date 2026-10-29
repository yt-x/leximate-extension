/**
 * 弹窗的内容模型（PLAN.md FR-A5、FR-A6）。
 *
 * 把查询结果整理成"卡片上要显示什么"，与"怎么画"分开。
 * 这样 FR-A5 的"四段结构"可以逐段断言，而不必去断言 DOM。
 *
 * FR-A5 要求：词形、美音音标、多词性中文释义、考试标签、词频、变形、发音按钮、
 * 遇见次数、来源例句 —— **全部来自本地数据**。
 *
 * 信息层级（规格 §1.A）：词 → 音标 → 遇见次数 → 首次日期 → 例句；
 * 差异只有两处：**英音整列去掉**、**新增词形与变形提示**。
 */

import type { DictEntry } from '../dict/types';
import type { LookupHit } from '../dict/lookup';
import type { WordStatus } from '../db/types';

/** 卡片的四段（规格把弹窗按上到下分为四段） */
export interface CardModel {
  /** 段一：词形 */
  head: {
    /** 页面上看到的原形 */
    surface: string;
    /** 词条原形；与 surface 相同表示没有发生还原 */
    lemma: string;
    /** FR-B3c：surface 是屈折形时的提示，如「see 的过去式」 */
    inflectionHint: string | null;
    /** 美音音标；本期英音整列去掉，故只有这一个 */
    phoneticUs: string;
  };
  /** 段二：释义（多词性） */
  senses: Array<{ pos: string; defZh: string[] }> | null;
  /** 段三：标签与统计 */
  meta: {
    /** 考试标签（FR-B7 导入后才可能有） */
    tags: string[];
    /** 词频排名（FR-B7 导入后才可能有） */
    rank: number | null;
    /** FR-A17 遇见次数 */
    meetCount: number;
    /** 首次遇见日期（毫秒时间戳），没有记录时为 null */
    firstSeenAt: number | null;
    /**
     * 词条的当前状态（FR-A6 的主按钮要按它 + `inBook` 三选一）。
     *
     * 与 `meetCount` 一样，这是**卡片被画出来的那一刻**的状态快照：
     * 点按钮后由 `popup.update()` 用新状态重绘，而不是让弹窗自己读库。
     */
    status: WordStatus;
    /**
     * 这个词**是否已在生词本里**。
     *
     * 与 `status` 是两件事：`status` 是"入库之后处于什么状态"，
     * 而"还没入库"时它没有意义（旧实现用 `UNSEEN` 兜底成 `new`，
     * 于是界面分不清"是生词"与"根本没收藏"）。
     */
    inBook: boolean;
  };
  /** 段四：例句（FR-C1） */
  examples: Array<{ text: string; source: string | null; at: number | null }>;
  /** FR-B4：词库未收录 */
  unlisted: boolean;
  /** FR-B4：LLM 释义是否生成中，以及最近一次可见错误。 */
  defining?: boolean;
  definitionError?: string | null;
  /**
   * FR-I3：是否有可用的本地英文语音。
   *
   * `false` 时**不渲染发音按钮**（"加载中"不得隐藏，因此只有确定不可用才是 false）。
   */
  canSpeak: boolean;
}

export interface CardContext {
  meetCount: number;
  firstSeenAt: number | null;
  examples: Array<{ text: string; source: string | null; at: number | null }>;
  /** 词条当前状态；缺省按 `new`（首次遇见的默认语义） */
  status?: WordStatus;
  /** 这个词是否**已在生词本里**；缺省 `false`（默认手动收藏，划词不写库） */
  inBook?: boolean;
  /** FR-I3：本地英文语音是否可用；缺省 `true`（加载中不得隐藏按钮） */
  canSpeak?: boolean;
  /**
   * 考试标签与词频排名。
   *
   * **本期必然为空**：这两个字段来自 FR-B7 的用户导入词库，而 `DictEntry`
   * 目前**根本没有这两个字段**（见 `utils/dict/types.ts`）。做成可选入参而不是
   * 硬编码空数组，是为了 M2 接入导入后不必改这里的调用形态；
   * 现在传什么都不影响显示。
   */
  tags?: string[];
  rank?: number | null;
}

/**
 * 释义行首的词性前缀（`a. 愚蠢的, 傻瓜的` 里的 `a.`）。
 *
 * 度量与 `utils/import/ecdict-parse.ts::posFromTranslation` 保持一致（1~4 个字母 + 点号 + 空白），
 * 但这里**从行自身**取，不依赖 `pos` 数组的下标。
 */
const POS_LINE_PREFIX = /^([a-z]{1,4})\.\s+/;

/**
 * 拆开一条释义行：行首词性前缀 + 真正的释义。
 *
 * 为什么需要：ECDICT 的 `translation` 每行以词性开头（`a. 愚蠢的, 傻瓜的`），
 * `posFromTranslation` 只负责**抽出**词性进 `pos`，并不改写 `defZh`，于是同一段
 * 文字在卡片上出现两次。内置词表的 `defZh` 不带前缀，所以只有导入词会犯。
 *
 * **为什么不按 `pos[i]` 取词性**：`posFromTranslation` 会跳过没有前缀的行
 * （`continue`），而 `defZh` 保留全部行——两者不保证一一对应。首行没有前缀时，
 * `pos[0]` 其实是第二行的词性，按索引取会把词性错标到首行释义上。
 *
 * 判定用**词性格式**而不是"与 pos 完全相等"：`a.` + `ad hoc 临时的` 里
 * `ad hoc` 不匹配 `[a-z]{1,4}\. +空白`，因此不会被误剥。
 */
function splitPosPrefix(def: string): { pos: string; def: string } {
  const trimmed = def.trimStart();
  const match = POS_LINE_PREFIX.exec(trimmed);
  if (match === null) return { pos: '', def };
  return { pos: `${match[1]}.`, def: trimmed.slice(match[0].length) };
}

/**
 * 逐行组装 sense：每行的 `pos` 与释义。
 *
 * 词性有**两个来源**，优先级如下：
 *
 * 1. **行内前缀**（导入词）：ECDICT 的 `translation` 每行以词性开头
 *    （`a. 愚蠢的, 傻瓜的`），`posFromTranslation` 只抽出词性进 `pos`、不改写 `defZh`。
 *    渲染层若再拼一次 `pos` 就成了 `a. a. 愚蠢的`（用户实测 `goofy`，2026-10-24）。
 *    所以从行里拆出来，拆出的 `pos` 就是这一行真正的词性。
 * 2. **`pos` 阵列**（内置词）：`data/core-words.tsv` 的 `defZh` 不带前缀（`abandon` 是
 *    `放弃；抛弃`），词性只在 `pos` 里——`abandon` 的 `pos` 是 `v.`。此时必须带上，
 *    否则内置词的词性会全部消失。
 *
 * **为什么回退时要先比行数**：`posFromTranslation` 会跳过没有前缀的行（`continue`），
 * 而 `defZh` 保留全部行，两者行数可能不等。行数不等时按下标对齐会把第二行的词性
 * 错标到第一行上，因此宁可不标。
 */
function buildSenses(
  defZh: readonly string[],
  pos: readonly string[],
): Array<{ pos: string; defZh: string[] }> {
  const aligned = pos.length === defZh.length ? pos : null;
  const out: Array<{ pos: string; defZh: string[] }> = [];
  for (const [i, def] of defZh.entries()) {
    const inline = splitPosPrefix(def);
    const linePos = inline.pos !== '' ? inline.pos : (aligned?.[i] ?? '');
    const text = inline.pos !== '' ? inline.def : def;
    if (text !== '') out.push({ pos: linePos, defZh: [text] });
  }
  return out;
}

/**
 * 由一个查询命中造出卡片模型。
 *
 * `hit.via === 'lemmatized'` 时词条原形与页面词形不同，此时**两个都要显示**——
 * 只显示 `run` 会让用户困惑"我明明划的 running"；只显示 `running` 又查不到词条。
 */
export function cardFromHit(surface: string, hit: LookupHit, context: CardContext): CardModel {
  const entry: DictEntry = hit.entry;

  return {
    head: {
      surface,
      lemma: entry.lemma,
      // FR-B3c：同形冲突时附提示；走还原时也要说明是被还原到了哪个原形
      inflectionHint: hit.inflectionOf
        ? `${hit.inflectionOf.lemma} 的${hit.inflectionOf.hint}`
        : hit.via === 'lemmatized'
          ? `原形 ${entry.lemma}`
          : null,
      phoneticUs: entry.phoneticUs,
    },
    // 释义组装：`defZh` 是**主数据**，`pos` 只是分组标签。
    //
    // 不能写成 `entry.pos.map(...)`——ECDICT 里大量词条的 `translation` 以
    // `[计]` / `[医]` 等非标准词性标记开头，`posFromTranslation` 认不出这些前缀，
    // `pos` 会是空数组。那样 `senses` 变成 `[]`，卡片就一个字都显示不出来
    // （用户实测：`dispatching` 的 defZh 是 `[计] 调度的, 发送的`，pos 为空 → 显示未收录）。
    //
    // 规则：逐条 defZh 输出一个 sense；有对应 pos 就带上，没有就 pos 留空。
    //
    // ⚠️ 但 **ECDICT 的 defZh 每行自带词性前缀**（`a. 愚蠢的, 傻瓜的`），而
    // `posFromTranslation` 只抽取、不剥离，渲染层再把 `pos` 拼在前面就成了
    // `a. a. 愚蠢的`（用户实测 `goofy`，2026-10-24）。取词性的规则见 `buildSenses`。
    senses: buildSenses(entry.defZh, entry.pos),
    meta: {
      // 本期恒为空，等 FR-B7 的导入词库进来
      tags: context.tags ?? [],
      rank: context.rank ?? null,
      meetCount: context.meetCount,
      firstSeenAt: context.firstSeenAt,
      status: context.status ?? 'new',
      inBook: context.inBook === true,
    },
    examples: context.examples,
    unlisted: false,
    canSpeak: context.canSpeak !== false,
  };
}

/**
 * 词库未收录时的卡片（FR-B4：**不静默失败**，要给"未收录"提示与可选 LLM 入口）。
 */
export function cardFromUnlisted(surface: string, context: CardContext): CardModel {
  return {
    head: { surface, lemma: surface, inflectionHint: null, phoneticUs: '' },
    senses: null,
    meta: {
      tags: [],
      rank: null,
      meetCount: context.meetCount,
      firstSeenAt: context.firstSeenAt,
      status: context.status ?? 'new',
      inBook: context.inBook === true,
    },
    examples: context.examples,
    unlisted: true,
    canSpeak: context.canSpeak !== false,
  };
}

/**
 * FR-A6 的操作词汇表。
 *
 * 前六个是规格点名的六个操作；`collect` 是**手动收藏**轮补上的：
 * 默认划词**不写库**，由用户点「加入生词本」才收进来（避免误选把词收进生词本）。
 */
export const CARD_ACTIONS = [
  'collect',
  'mark-known',
  'mark-new',
  'ignore',
  'speak',
  'copy-definition',
  'open-manager',
  'llm-define',
] as const;

export type CardAction = (typeof CARD_ACTIONS)[number];

/** 决定主操作需要的最小状态 */
export interface ActionContext {
  /** 这个词**已经在生词本里**了吗 */
  inBook: boolean;
  /** 词条状态；未加入时无意义 */
  status: WordStatus;
  /** 未收录时才提供可选 LLM 释义入口（FR-B4）。 */
  unlisted?: boolean;
}

/**
 * 当前状态该显示哪几个按钮（FR-A6 的交互约定）。
 *
 * **主操作三选一**（手动收藏轮修订）：
 * - 未加入生词本 → 「加入生词本」
 * - 已加入且 `status = new` → 「标记为已掌握」
 * - 已加入且 `known` / `ignored` → 「改回生词」
 *
 * 次要操作：已加入时有「忽略」（忽略一个不在生词本里的词没有意义，故未加入时不显示）、
 * 「复制释义」、「打开管理台」；发音按 FR-I3——**确定**没有可用本地英文语音时隐藏。
 */
export function visibleActions(context: ActionContext, canSpeak = true): CardAction[] {
  const primary: CardAction = !context.inBook
    ? 'collect'
    : context.status === 'new'
      ? 'mark-known'
      : 'mark-new';

  const rest: CardAction[] = [];
  if (context.inBook) rest.push('ignore');
  if (canSpeak) rest.push('speak');
  if (context.unlisted) rest.push('llm-define');
  rest.push('copy-definition', 'open-manager');
  return [primary, ...rest];
}

/** 给复制操作准备文本（FR-A6 的"复制释义"） */
export function definitionText(card: CardModel): string {
  if (!card.senses || card.senses.length === 0) return card.head.surface;

  const lines = card.senses.map((sense) => {
    const defs = sense.defZh.filter((d) => d !== '').join('；');
    return sense.pos ? `${sense.pos} ${defs}` : defs;
  });

  const head = card.head.phoneticUs
    ? `${card.head.surface} ${card.head.phoneticUs}`
    : card.head.surface;

  return [head, ...lines.filter((l) => l !== '')].join('\n');
}
