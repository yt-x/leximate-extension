/**
 * 划词查询管道（PLAN.md FR-A1、FR-A2、FR-B3d、FR-B4、FR-A16）。
 *
 * 把三段串起来，并**定死它们的顺序**——顺序是规格明确要求的：
 *
 * ```
 * 选区文本 ──judgeWord──▶ 是不是词？ ──否──▶ 不弹窗
 *                             │是
 *                             ▼
 *                    lookupCandidates（原样 → 去变音符）
 *                             │
 *                             ▼
 *                     dict.lookup（内部已含 FR-B3c 独立词条优先 + 词形还原）
 *                             │
 *                      ┌──────┴──────┐
 *                     命中          未命中
 *                      │             │
 *                   出卡片      FR-B4「未收录」
 * ```
 *
 * **判定先于归一化**（规格口径）：`3.14` 判定不过就直接返回，不会先归一成 `314` 再查一次库。
 *
 * 本模块不碰 DOM——弹窗怎么画是另一层。它只回答"这段文本该不该出卡片、出什么"。
 */
import type { DictLookup, LookupHit } from '../dict/lookup';
import { isWholeWordSelection, judgeWord, lookupCandidates, type WordRejectReason } from './word';

/**
 * 导入词库查询（FR-B7）。
 *
 * 由调用方注入真实实现（发消息给后台）；未注入时查询链路与之前完全一致。
 * 返回 `null` 表示"导入词库里也没有"。
 */
export type ImportedLookup = (surface: string) => Promise<{
  lemma: string;
  hint: string | null;
  word: {
    phoneticUs: string;
    pos: string[];
    defZh: string[];
    fallbackDef: string[];
    examTags: string[];
  };
} | null>;

/** 一次划词查询的结局 */
export type QueryResult =
  /** 不是一个可查的词，按 `reason` 说明为什么 */
  | { kind: 'rejected'; reason: WordRejectReason }
  /** 是词但词库没有（FR-B4：要显示"未收录"+ 可选 LLM 入口，不能静默失败） */
  | { kind: 'unlisted'; surface: string }
  /** 命中 */
  | { kind: 'hit'; surface: string; hit: LookupHit };

export interface QueryOptions {  /** 诊断钩子：去变音符那次回退是否被用到，用于观察 FR-A16 的实际命中情况 */
  onDiacriticFallback?: (original: string, used: string) => void;
  /**
   * 最短词长（FR-F9 的"最短词长"设置，`Settings.minWordLength`）。
   *
   * 短于它的选中直接判 `too-short` 并**不弹窗、不入库**。
   * 缺省不限（规则表本身不设下限：`a` / `I` 都是合法的英语词）。
   *
   * 按**字符数**算（`[...text].length`），因此 `café` 是 4 个字符。
   */
  minLength?: number;
  /**
   * 选区两端紧邻的字符（FR-A16 的「完整性」行）。
   *
   * `before` 是选区起点前一个字符、`after` 是终点后一个字符；
   * 任一仍是词字符即判 `partial`——用户在 `proof` 里只拖到 `proo`
   * **不算选中了一个词**，不弹可收藏的卡片、不写库。
   * 缺省（都不给）视为完整，保持既有调用点的语义。
   */
  before?: string;
  after?: string;
}

/**
 * 查询一段选中的文本。
 *
 * `surface` 一律**保留页面原形**（规格：`surface` 保留页面原样，查表才转小写），
 * 因此命中的 `surface` 传回给卡片显示的是用户看到的样子，不是小写键。
 */
export function querySelection(
  raw: string,
  dict: DictLookup,
  options: QueryOptions = {},
): QueryResult {
  const verdict = judgeWord(raw);
  if (!verdict.ok) return { kind: 'rejected', reason: verdict.reason };

  const surface = verdict.word;

  // FR-A16 的「完整性」：选区必须覆盖整个词（`proo` 从 `proof` 里切出来不算）
  if (!isWholeWordSelection(options.before ?? '', options.after ?? '')) {
    return { kind: 'rejected', reason: 'partial' };
  }

  // 用户设置的最短词长：规则表只管词形，下限由设置说了算
  const minLength = options.minLength ?? 0;
  if (minLength > 0 && [...surface].length < minLength) {
    return { kind: 'rejected', reason: 'too-short' };
  }

  const candidates = lookupCandidates(surface);

  for (let i = 0; i < candidates.length; i++) {
    const key = candidates[i]!;
    const hit = dict.lookup(key);
    if (hit) {
      // 第 0 个候选是"原样"，第 1 个是"去变音符"，后者命中即为回退
      if (i > 0) options.onDiacriticFallback?.(surface, key);
      return { kind: 'hit', surface, hit };
    }
  }

  // FR-B4：明确"未收录"，不静默失败
  return { kind: 'unlisted', surface };
}

/**
 * 异步版：未命中时先尝试补拉首字母分片再查一次（§4.5 P3），
 * 仍未命中且注入了 `lookupImported` 时，再问一次后台的导入词库（FR-B7）。
 *
 * 为什么值得单独一个函数而不是让调用方自己重试：
 * **补拉分片是"这次查询的一部分"**，调用方不该关心分片机制。分片只在
 * `lookup` 未命中时才会被拉，因此命中常驻分片时这个函数与同步版一样快
 * （`ensureFor` 内部会先 `probe` 一次再决定拉不拉）。
 *
 * 导入词库同理：它是**最后一步**，只有内置分片确实没有时才发一次消息。
 * 没注入时行为与之前完全一致（返回 `unlisted`）。
 */
export async function querySelectionAsync(
  raw: string,
  dict: DictLookup,
  options: QueryOptions = {},
  imported?: ImportedLookup,
): Promise<QueryResult> {
  const first = querySelection(raw, dict, options);
  if (first.kind !== 'unlisted') return first;

  // 未命中：可能是低频词躺在还没拉下来的分片里
  const loaded = await dict.ensureFor(first.surface);
  if (loaded) {
    const second = querySelection(raw, dict, options);
    if (second.kind !== 'unlisted') return second;
  }

  // 内置没有 → 问导入词库（FR-B7）
  if (!imported) return first;
  const hit = await imported(first.surface);
  if (!hit) return first;
  return {
    kind: 'hit',
    surface: first.surface,
    hit: {
      entry: {
        lemma: hit.lemma,
        phoneticUs: hit.word.phoneticUs,
        phoneticUk: '',
        pos: hit.word.pos,
        defZh: hit.word.defZh.length > 0 ? hit.word.defZh : hit.word.fallbackDef,
      },
      via: hit.hint ? 'lemmatized' : 'direct',
      ...(hit.hint ? { hint: hit.hint } : {}),
    },
  };
}
