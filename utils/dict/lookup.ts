/**
 * 查询层（PLAN.md FR-B2：单次查询 < 5ms；§4.5 P3：常驻分片 + 低频按首字母分片）。
 *
 * `lookup` 是同步的——这是性能预算的关键：命中常驻分片时不产生任何 Promise。
 * 只有未命中且该首字母还留着一个没拉的分片时，才需要 `ensureFor` 去补。
 */
import { parseIndex, parseShard, type DictSource } from './source';
import type { LemmaCandidate } from './lemmatize';
import type { DictEntry } from './types';

/** 常驻分片的名字。构建脚本保证它总是存在 */
export const HOT_SHARD = 'core';

export interface DictLookupOptions {
  /**
   * 词形还原（FR-B3、FR-B3c，M1-4 接入）。
   *
   * 返回可用的还原候选；返回 null 表示还原不出来。
   * 候选里 `isKnown` 已由本模块判定过——这里只问"能还原成什么"。
   */
  lemmatize?: (surface: string) => LemmaCandidate | null;
  /** 需要补拉分片时的通知钩子，用于诊断 */
  onShardLoaded?: (name: string, words: number) => void;
}

/** 一次查询的结果。比裸 `DictEntry` 多带 FR-B3c 需要的还原信息 */
export interface LookupHit {
  entry: DictEntry;
  /**
   * 命中的过程（FR-B3c 要区分这两种，界面提示不同）：
   * - `direct`：surface 本身就是词条——**独立词条优先**
   * - `lemmatized`：经词形还原查到
   */
  via: 'direct' | 'lemmatized';
  /**
   * 变形提示（如"过去式"）。仅 `via === 'lemmatized'` 时有值。
   */
  hint?: string;
  /**
   * FR-B3c：surface 本身是独立词条、**同时**也是另一个词条的屈折形式时，
   * 记下那个原形，供卡片附一行"see 的过去式"。
   * 此时 `via` 仍是 `direct`、`isLemmatized` 保持 false，独立词义不被覆盖。
   */
  inflectionOf?: { lemma: string; hint: string };
}

export interface DictLookup {
  /** 拉清单 + 常驻分片。内容脚本注入时调用一次 */
  warm(): Promise<void>;
  /** 同步查询。命中返回结果，未命中返回 undefined */
  lookup(surface: string): LookupHit | undefined;
  /** 补拉 `surface` 首字母所在的分片；返回是否真的加载了 */
  ensureFor(surface: string): Promise<boolean>;
  isWarm(): boolean;
  /** 已载入的常驻词条数 */
  entryCount(): number;
  loadedShards(): string[];
  dictVersion(): string;
}

/**
 * 归一化查询词。
 *
 * 划词常见噪声：首尾引号、句末标点、连字符两端空白、全角撇号。
 * 只做这些清理，不做大小写以外的形态变换——那是 `lemmatize` 的职责。
 */
export function normalizeSurface(raw: string): string {
  return raw
    .trim()
    .replace(/^[‘’'"“”()[\]{}<>,.;:!?]+/, '')
    .replace(/[‘’'"“”()[\]{}<>,.;:!?]+$/, '')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function diacriticKey(raw: string): string {
  return raw.normalize('NFD').replace(/\p{M}+/gu, '');
}

function isHot(name: string): boolean {
  return name === HOT_SHARD;
}

export function createDictLookup(source: DictSource, options: DictLookupOptions = {}): DictLookup {
  const lemmatize = options.lemmatize;

  /** 常驻表 + 已按需拉下来的分片，合成一张扁平索引：跨分片查询不必知道词在哪 */
  let index: Map<string, DictEntry> | null = null;
  let version = '';
  const loaded = new Set<string>();
  /** 清单里还没拉的首字母分片：名字 → 文件名 */
  const pending = new Map<string, string>();
  /** 去变音键 → 唯一的原词条键；多个原词条共享键时记 null，绝不猜测。 */
  const diacriticAliases = new Map<string, string | null>();

  function absorb(words: Record<string, DictEntry>): void {
    for (const [key, entry] of Object.entries(words)) {
      index?.set(key, entry);
      const folded = diacriticKey(key);
      if (folded === key) continue;
      const previous = diacriticAliases.get(folded);
      if (previous === undefined) diacriticAliases.set(folded, key);
      else if (previous !== key) diacriticAliases.set(folded, null);
    }
  }

  async function loadShard(name: string, file: string): Promise<void> {
    const shard = parseShard(await source.readShard(file));
    absorb(shard.words);
    loaded.add(name);
    pending.delete(name);
    options.onShardLoaded?.(shard.name, Object.keys(shard.words).length);
  }

  function probe(word: string): LookupHit | undefined {
    // FR-B3c 第一优先：surface 本身是词条就**必须**用它。
    // `saw` 是"锯子"也是 `see` 的过去式——用了还原会让用户查到错词义。
    const direct = index?.get(word);
    if (direct) {
      const hit: LookupHit = { entry: direct, via: 'direct' };
      // 它同时也是别的词条的屈折形式时，附一行变形提示（不改词义）
      const candidates = lemmatize?.(word);
      if (candidates && candidates.lemma !== word) {
        hit.inflectionOf = { lemma: candidates.lemma, hint: candidates.hint };
      }
      return hit;
    }

    // 反向去变音只查已载入词条的唯一别名，不枚举可能的重音拼写。
    // 带变音符号的输入仍由 querySelection 的“原样 → 去变音”候选处理，
    // 这样既有优先级与 onDiacriticFallback 诊断语义不变。
    if (diacriticKey(word) === word) {
      const alias = diacriticAliases.get(word);
      if (alias) return probe(alias);
    }

    // 独立词条不存在，才走还原
    if (!lemmatize) return undefined;
    const candidate = lemmatize(word);
    if (!candidate || candidate.lemma === word) return undefined;
    const lemmatized = index?.get(candidate.lemma.toLowerCase());
    if (!lemmatized) return undefined;
    return { entry: lemmatized, via: 'lemmatized', hint: candidate.hint };
  }

  return {
    async warm() {
      if (index) return;
      const parsed = parseIndex(await source.readIndex());
      index = new Map();
      version = parsed.version;
      for (const info of parsed.shards) pending.set(info.name, info.file);
      // 常驻分片必须成功；失败就让 warm 抛出去，暴露成初始化错误而不是静默少一半词
      const hot = parsed.shards.find((s) => isHot(s.name));
      if (!hot) throw new Error('词表清单里没有常驻分片 core');
      await loadShard(hot.name, hot.file);
    },

    lookup(surface) {
      if (!index) return undefined;
      const word = normalizeSurface(surface);
      if (word === '') return undefined;
      return probe(word);
    },

    async ensureFor(surface) {
      if (!index) return false;
      const word = normalizeSurface(surface);
      if (word === '') return false;
      if (probe(word)) return false;

      const first = word[0] ?? '';
      const key = first >= 'a' && first <= 'z' ? first : 'other';
      const file = pending.get(key);
      if (!file) return false;
      await loadShard(key, file);
      return true;
    },

    isWarm: () => index !== null,
    entryCount: () => index?.size ?? 0,
    loadedShards: () => [...loaded].sort(),
    dictVersion: () => version,
  };
}
