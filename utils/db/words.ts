/**
 * 生词与例句的读写（PLAN.md FR-E2）。
 *
 * 约定：
 * - `lemma` 一律小写归一，它是非唯一索引（兼容历史数据），也是「同一个词」的判定依据；
 * - 重复遇见同词只累加 `meetCount`，不覆盖已入库的词库字段；
 * - `surface` 保留**首次**遇见的形态，后续遇见不改写它（否则 isLemmatized 会随遇见顺序漂移）；
 * - 例句按 `wordId + text` 去重，重复遇见不产生第二行。
 */
import { sceneHash } from '../hash';
import { readTx, req, STORE, writeTx } from './schema';
import type {
  DefinitionSource,
  PhoneticSource,
  Scene,
  Word,
  WordOrigin,
  WordStatus,
} from './types';

export function normalizeLemma(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 从 URL 取来源域名；解析失败返回空串，不让一条脏 URL 毁掉整次写入 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface NewWordInput {
  lemma: string;
  surface?: string;
  phoneticUs?: string;
  phoneticUk?: string;
  /**
   * FR-B9：音标来源。**有音标就必须给来源**，否则 `upsertWord` 会拒绝写入——
   * FR-B9 的验收是「不存在无来源标记的音标」，这条不变式只能在这里守住。
   */
  phoneticSrc?: PhoneticSource;
  /** FR-B10：释义来源。给 `defZh` 就要给来源，同理 */
  defSrc?: DefinitionSource;
  defZh?: string[];
  pos?: string[];
  examTags?: string[];
  freqBnc?: number;
  freqCoca?: number;
  exchange?: string;
  status?: WordStatus;
  origin?: WordOrigin;
  /** FR-B3c：surface 同时是另一个词条的屈折形式时，记下那个原形 */
  inflectionOf?: string | null;
  fallbackDef?: string[];
  isUnlisted?: boolean;
  /** 注入时间戳，便于测试与导入时保留原始时间 */
  now?: number;
}

export interface UpsertWordResult {
  word: Word;
  created: boolean;
}

function buildWord(input: NewWordInput, lemma: string, now: number): Word {
  const surface = input.surface ?? input.lemma.trim();
  return {
    id: crypto.randomUUID(),
    lemma,
    surface,
    phoneticUs: input.phoneticUs ?? '',
    phoneticUk: input.phoneticUk ?? '',
    phoneticSrc: input.phoneticSrc ?? null,
    defSrc: input.defSrc ?? null,
    defZh: input.defZh ?? [],
    pos: input.pos ?? [],
    examTags: input.examTags ?? [],
    freqBnc: input.freqBnc ?? 0,
    freqCoca: input.freqCoca ?? 0,
    exchange: input.exchange ?? '',
    status: input.status ?? 'new',
    meetCount: 1,
    isLemmatized: normalizeLemma(surface) !== lemma,
    inflectionOf: input.inflectionOf ?? null,
    isUnlisted: input.isUnlisted ?? false,
    origin: input.origin ?? 'native',
    fallbackDef: input.fallbackDef ?? [],
    llmDef: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/**
 * 按 lemma 新增或累加。
 *
 * 已存在时：`meetCount + 1`，只补齐原来是空的词库字段（不覆盖），刷新 `updatedAt`。
 * 软删除的词会被复活 —— 用户又遇见了它，墓碑不该继续挡着。
 *
 * FR-B9 的不变式在这里守住：**有音标就必须有来源**。传了音标却没传 `phoneticSrc`
 * 会直接抛错，而不是悄悄写出一条"无来源标记的音标"——那正是 FR-B9 禁止的状态。
 */
export async function upsertWord(input: NewWordInput): Promise<UpsertWordResult> {
  const lemma = normalizeLemma(input.lemma);
  if (!lemma) throw new Error('upsertWord: lemma 不能为空');

  const hasPhonetic = (input.phoneticUs ?? '') !== '' || (input.phoneticUk ?? '') !== '';
  if (hasPhonetic && !input.phoneticSrc) {
    throw new Error(`upsertWord: 「${lemma}」带了音标却没有 phoneticSrc（FR-B9）`);
  }
  const hasDef = (input.defZh ?? []).length > 0;
  if (hasDef && !input.defSrc) {
    throw new Error(`upsertWord: 「${lemma}」带了释义却没有 defSrc（FR-B10）`);
  }

  const now = input.now ?? Date.now();

  return writeTx(STORE.words, async (tx) => {
    const store = tx.objectStore(STORE.words);
    const existing = pickUserWord(
      await req<Word[]>(store.index('lemma').getAll(lemma)),
    );

    if (!existing) {
      const word = buildWord(input, lemma, now);
      await req(store.add(word));
      return { word, created: true };
    }

    // 只在原来是空的时候才补词库字段，因此来源标记也跟着一起补——
    // 已经有音标的记录不该被后来一次查询改写来源。
    const adoptPhonetic = existing.phoneticUs === '' && input.phoneticUs !== undefined;
    const adoptDef = existing.defZh.length === 0 && (input.defZh?.length ?? 0) > 0;

    const merged: Word = {
      ...existing,
      meetCount: existing.meetCount + 1,
      phoneticUs: existing.phoneticUs || input.phoneticUs || '',
      phoneticUk: existing.phoneticUk || input.phoneticUk || '',
      phoneticSrc: adoptPhonetic ? (input.phoneticSrc ?? null) : existing.phoneticSrc,
      defSrc: adoptDef ? (input.defSrc ?? null) : existing.defSrc,
      defZh: existing.defZh.length > 0 ? existing.defZh : (input.defZh ?? []),
      pos: existing.pos.length > 0 ? existing.pos : (input.pos ?? []),
      examTags: existing.examTags.length > 0 ? existing.examTags : (input.examTags ?? []),
      freqBnc: existing.freqBnc || input.freqBnc || 0,
      freqCoca: existing.freqCoca || input.freqCoca || 0,
      exchange: existing.exchange || input.exchange || '',
      // FR-B3c：只在该字段还空着时补，不覆盖已有提示
      inflectionOf: existing.inflectionOf ?? input.inflectionOf ?? null,
      fallbackDef:
        existing.fallbackDef.length > 0 ? existing.fallbackDef : (input.fallbackDef ?? []),
      isUnlisted: input.isUnlisted === undefined ? existing.isUnlisted : input.isUnlisted,
      updatedAt: now,
      deletedAt: null,
    };
    await req(store.put(merged));
    return { word: merged, created: false };
  });
}

/**
 * 从同一 lemma 的候选记录里挑一条。
 *
 * v4 起词典已独立到 `dict` store，`words` 里同一 lemma 理论上只有一条；
 * 这个函数留着是防御历史数据（v3 及以前可能残留同 lemma 的多条），
 * 取 `meetCount` 最大的那条（用户使用最多的就是最真实的）。
 */
export function pickUserWord(candidates: readonly Word[]): Word | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, cur) => (cur.meetCount > best.meetCount ? cur : best));
}

export async function getWordById(id: string): Promise<Word | undefined> {
  return readTx(STORE.words, (tx) => req<Word | undefined>(tx.objectStore(STORE.words).get(id)));
}

export async function getWordByLemma(lemma: string): Promise<Word | undefined> {
  const key = normalizeLemma(lemma);
  return readTx(STORE.words, async (tx) =>
    pickUserWord(await req<Word[]>(tx.objectStore(STORE.words).index('lemma').getAll(key))),
  );
}

export interface ListWordsOptions {
  status?: WordStatus;
  orderBy?: 'createdAt' | 'updatedAt' | 'meetCount' | 'lemma';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** 对 lemma 与 surface 的子串匹配（大小写不敏感） */
  search?: string;
  includeDeleted?: boolean;
}

/**
 * 列表查询。
 *
 * 1 万词的规模不值得为搜索建倒排索引：整表取回后在内存里筛，实测远快于 300ms 的预算
 * （见 verification/M1-2.md）。等规模真的上来再换游标分页。
 */
export async function listWords(options: ListWordsOptions = {}): Promise<Word[]> {
  const {
    status,
    orderBy = 'createdAt',
    direction = 'desc',
    limit,
    offset = 0,
    search,
    includeDeleted = false,
  } = options;

  const rows = await readTx(STORE.words, (tx) => {
    const store = tx.objectStore(STORE.words);
    return status
      ? req<Word[]>(store.index('status').getAll(status))
      : req<Word[]>(store.getAll());
  });

  const needle = search?.trim().toLowerCase();
  let result = rows.filter((word) => {
    if (!includeDeleted && word.deletedAt !== null) return false;
    // 词典条目已不在 words（v4 起在 `dict` store），这里不需要任何来源过滤
    if (!needle) return true;
    return word.lemma.includes(needle) || word.surface.toLowerCase().includes(needle);
  });

  const sign = direction === 'asc' ? 1 : -1;
  result.sort((a, b) => {
    if (orderBy === 'lemma') return sign * a.lemma.localeCompare(b.lemma);
    return sign * (a[orderBy] - b[orderBy]);
  });

  if (offset > 0) result = result.slice(offset);
  if (limit !== undefined) result = result.slice(0, limit);
  return result;
}

/**
 * 取**下划线集合**：`status = new` 且未删除的词条（词条原形 + 遇见次数）。
 *
 * 用途是 `PLAN.md` §4.5 P3 的"**生词集合由 SW 一次性下发**"：
 * 内容脚本拿到它之后，标注就是一次同步的集合查找——
 * 不再需要"页面上每个词都问一次后台"，也不再有"词典不认识的词标不出来"的问题。
 *
 * ⚠️ 不含墓碑（`deletedAt`），与列表/计数/角标的口径一致；
 * 次数要带上，因为 FR-A11 的分档要用它。
 */
export async function listNewWords(): Promise<Array<{ word: string; meetCount: number }>> {
  return readTx(STORE.words, (tx) => {
    const source = tx.objectStore(STORE.words).index('status').openCursor('new');
    return new Promise<Array<{ word: string; meetCount: number }>>((resolve, reject) => {
      const out: Array<{ word: string; meetCount: number }> = [];
      source.onsuccess = () => {
        const cursor = source.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        const word = cursor.value as Word;
        // 词典条目不在 words 表（v4 起在 `dict` store），这里不需要过滤来源
        if (word.deletedAt === null) {
          out.push({ word: word.lemma, meetCount: word.meetCount });
        }
        cursor.continue();
      };
      source.onerror = () => reject(source.error ?? new Error('读取生词集合失败'));
    });
  });
}

/**
 * 数词条。
 *
 * ⚠️ **默认不含墓碑**。`deletedAt` 是"删除标记"（§2，给同步用的 tombstone），
 * 不是"遇见过的词"——用户批量删完生词之后，角标（FR-A14）必须跟着掉到 0。
 * 旧实现直接 `store.count()`，把墓碑一起数了进去，于是"删了词角标不掉"。
 *
 * 实现用 **`deletedAt` 索引**（v2 加的）而不是游标过滤：
 * `null` 不是合法的 IndexedDB 键，因此**没有墓碑的记录不进这个索引**，
 * `index('deletedAt').count()` 就是墓碑数。两次 B 树计数 vs. 逐条读 1 万条记录——
 * 后者实测把测试套件从 1.8s 拖到 13s，而本函数在**每一次划词**都会被调用
 * （刷新角标）。
 *
 * `status` 过滤走的是游标：`[status, deletedAt]` 复合索引才够用，而目前
 * 带状态计数只在测试与管理台统计里出现，不在这条热路径上。
 */
export async function countWords(
  options: { status?: WordStatus; includeDeleted?: boolean } = {},
): Promise<number> {
  const { status, includeDeleted = false } = options;

  return readTx(STORE.words, async (tx) => {
    const store = tx.objectStore(STORE.words);

    // 快路径：不带状态，直接用计数（B 树上是 O(log n)）
    if (!status) {
      const total = await req<number>(store.count());
      if (includeDeleted) return total;
      const tombstones = await req<number>(store.index('deletedAt').count());
      return total - tombstones;
    }

    // 带状态的路径：逐条判定 `deletedAt`（它不在 status 索引里）
    if (includeDeleted) return countByCursor(store, status, true);
    return countByCursor(store, status, false);
  });
}

/** 按状态数词，同时按需排除墓碑。逐条游标，只在带 status 时走 */
function countByCursor(store: IDBObjectStore, status: WordStatus, includeDeleted: boolean): Promise<number> {
  const source = store.index('status').openCursor(status);
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    source.onsuccess = () => {
      const cursor = source.result;
      if (!cursor) {
        resolve(count);
        return;
      }
      const word = cursor.value as Word;
      if (includeDeleted || word.deletedAt === null) count += 1;
      cursor.continue();
    };
    source.onerror = () => reject(source.error ?? new Error('按状态计数失败'));
  });
}

export async function updateWordStatus(id: string, status: WordStatus): Promise<Word | undefined> {
  return writeTx(STORE.words, async (tx) => {
    const store = tx.objectStore(STORE.words);
    const word = await req<Word | undefined>(store.get(id));
    if (!word) return undefined;
    const next: Word = { ...word, status, updatedAt: Date.now() };
    await req(store.put(next));
    return next;
  });
}

/** 软删除：打墓碑，等同步（PLAN.md §2 的 deletedAt） */
export async function softDeleteWord(id: string): Promise<boolean> {
  return writeTx(STORE.words, async (tx) => {
    const store = tx.objectStore(STORE.words);
    const word = await req<Word | undefined>(store.get(id));
    if (!word) return false;
    const now = Date.now();
    await req(store.put({ ...word, deletedAt: now, updatedAt: now }));
    return true;
  });
}

export interface NewSceneInput {
  wordId: string;
  text: string;
  highlightFrom: number;
  highlightTo: number;
  sourceUrl: string;
  sourceTitle?: string;
  capturedAt?: number;
}

export interface AddSceneResult {
  scene: Scene;
  created: boolean;
}

export async function addScene(input: NewSceneInput): Promise<AddSceneResult> {
  const contentHash = sceneHash(input.wordId, input.text);
  const now = input.capturedAt ?? Date.now();

  return writeTx(STORE.scenes, async (tx) => {
    const store = tx.objectStore(STORE.scenes);
    const existing = await req<Scene | undefined>(store.index('contentHash').get(contentHash));
    if (existing) return { scene: existing, created: false };

    const scene: Scene = {
      id: crypto.randomUUID(),
      wordId: input.wordId,
      text: input.text,
      highlightFrom: input.highlightFrom,
      highlightTo: input.highlightTo,
      translation: null,
      sourceUrl: input.sourceUrl,
      sourceTitle: input.sourceTitle ?? '',
      domain: domainOf(input.sourceUrl),
      capturedAt: now,
      contentHash,
    };
    await req(store.add(scene));
    return { scene, created: true };
  });
}

/** 按 id 取一条例句（翻译 worker 要用原文，scene 可能已被删掉 → 返回 undefined） */
export async function getSceneById(id: string): Promise<Scene | undefined> {
  return readTx(STORE.scenes, (tx) => req<Scene | undefined>(tx.objectStore(STORE.scenes).get(id)));
}

export async function listScenesByWord(wordId: string): Promise<Scene[]> {
  const rows = await readTx(STORE.scenes, (tx) =>
    req<Scene[]>(tx.objectStore(STORE.scenes).index('wordId').getAll(wordId)),
  );
  return rows.sort((a, b) => a.capturedAt - b.capturedAt);
}

export async function countScenes(): Promise<number> {
  return readTx(STORE.scenes, (tx) => req<number>(tx.objectStore(STORE.scenes).count()));
}

/** 内容脚本弹窗要的最小集合：词 + 它的全部例句 */
export async function getWordCard(
  lemma: string,
): Promise<{ word: Word; scenes: Scene[] } | undefined> {
  const word = await getWordByLemma(lemma);
  if (!word) return undefined;
  return { word, scenes: await listScenesByWord(word.id) };
}
