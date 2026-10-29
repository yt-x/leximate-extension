/**
 * 后台侧的词状态读写（PLAN.md FR-A10、FR-A17）。
 *
 * **这个模块现在只在后台运行。** 它直接读写扩展源的 IndexedDB——
 * 这是正确的，因为后台、管理台与 SW 同属 `chrome-extension://<id>` 源。
 *
 * ⚠️ 内容脚本**不能**用本模块：内容脚本里的 Web 存储 API 访问的是
 * **宿主页面源**（官方原文见 `docs/reference/extension-storage-and-messaging.md` §1），
 * 直接调用会写进另一个库、后台永远看不到。内容脚本走 `word-state-cache.ts`
 * 的缓存 + 消息协议。
 *
 * 本模块保留原有的**内存缓存**语义（读走缓存、写穿缓存），
 * 因为后台处理 `fetch-states` 时会对同一批词反复查库。
 */
import { getWordByLemma, listNewWords, updateWordStatus, upsertWord } from '../db/words';
import type { WordStatus } from '../db/types';
import { UNSEEN, type CardDetail, type MeetRecord, type WordState } from './word-state-shared';
import { addScene, getWordCard } from '../db/words';
import { writeLog } from '../diag/log';

export type { WordState };
export { UNSEEN };

export interface MeetRecordResult extends WordState {
  /** 实际写入或已存在的例句 id；翻译 worker 用它回查原文。 */
  sceneId?: string;
}

export interface WordStateStore {
  /** 读状态（带缓存） */
  get(word: string): Promise<WordState>;
  /** 同步读缓存；未缓存时返回 undefined */
  peek(word: string): WordState | undefined;
  /**
   * 遇见次数 +1（FR-A17）；返回 +1 后的状态。
   *
   * **记账键是 `record.lemma`**（§2：`lemma` 是非唯一索引、`lemma` 是"同一个词"的判定依据）：
   * 页面词形 `running` 累加到词条 `run` 上，不会各记一条。
   * 未收录的词按 FR-B4 依然采集，但必须带上 `isUnlisted` 标记，
   * 否则它和管理台里的真单词长得一模一样。
   */
  recordMeet(record: MeetRecord): Promise<MeetRecordResult>;
  /** 手动改状态（FR-A6 的"标记为已掌握 / 改回生词 / 忽略"） */
  setStatus(word: string, status: WordStatus): Promise<WordState>;
  /** 批量读（`fetch-states` 用；未入库的词不出现在结果里） */
  getMany(words: readonly string[]): Promise<Array<{ word: string; state: WordState }>>;
  /**
   * **下划线集合**：`status = new` 且未删除的词条（原形 + 遇见次数）。
   *
   * 供 `fetch-new-words` 下发（§4.5 P3）。只回原形与次数，
   * 不含释义/音标——内容脚本画下划线只需要"该不该标 + 分档"两件事。
   */
  listNewWords(): Promise<Array<{ word: string; meetCount: number }>>;
  /**
   * FR-A5 ④段：首次日期 + **首条例句**（+ 来源域名）。
   *
   * 只回首条：卡片的 ④段就是"首条例句"，全部例句是管理台详情抽屉的事（FR-F7）；
   * 每次划词都把全部例句搬过消息通道，只会随例句数一起变慢。
   */
  getCard(word: string): Promise<CardDetail | undefined>;
  /** 清空缓存（设置变更、词库切换时） */
  clear(): void;
}

function keyOf(word: string): string {
  return word.trim().toLowerCase();
}

export function createWordStateStore(): WordStateStore {
  const cache = new Map<string, WordState>();

  return {
    async get(word) {
      const key = keyOf(word);
      if (key === '') return UNSEEN;

      const cached = cache.get(key);
      if (cached) return cached;

      const existing = await getWordByLemma(key);
      const state: WordState = existing
        ? { status: existing.status, meetCount: existing.meetCount }
        : UNSEEN;
      cache.set(key, state);
      return state;
    },

    peek(word) {
      return cache.get(keyOf(word));
    },

    async getMany(words) {
      const found: Array<{ word: string; state: WordState }> = [];
      for (const word of words) {
        const key = keyOf(word);
        if (key === '') continue;
        const state = await this.get(key);
        // 只回**已入库**的词：未入库的在内容脚本侧按 UNSEEN 处理，
        // 回一份 UNSEEN 只是徒增消息体积
        if (state !== UNSEEN && !(state.status === 'new' && state.meetCount === 0)) {
          found.push({ word: key, state });
        }
      }
      return found;
    },

    /**
     * 下划线集合（§4.5 P3 的下发内容）。
     *
     * **不进 `cache`**：这份数据的生命周期是"每次下发一整份"，
     * 与 `get`/`getMany` 的逐词缓存不是一回事——混进缓存会让"某个词的状态"
     * 出现两个来源，将来必然对不上。
     */
    listNewWords: () => listNewWords(),

    async recordMeet(record) {
      const key = keyOf(record.lemma);
      if (key === '') return UNSEEN;

      // 词库字段只在**命中**时才带上，并且按 FR-B9 / FR-B10 标出来源：
      // 音标来自本项目管线（CMUdict 派生），核心词表的释义是自撰的。
      // 未收录时整组不带——那正是 `isUnlisted` 要表达的状态。
      const dict = record.dict;
      const hasPhonetic = (dict?.phoneticUs ?? '') !== '';
      const hasDef = (dict?.defZh.length ?? 0) > 0;

      // 已软删除的词会被 upsertWord 复活（"用户又遇见了它"），符合 FR-A17 的语义
      const result = await upsertWord({
        lemma: key,
        surface: record.surface.trim() === '' ? record.lemma : record.surface,
        isUnlisted: record.unlisted,
        inflectionOf: record.inflectionOf ?? null,
        ...(dict
          ? {
              phoneticUs: dict.phoneticUs,
              pos: dict.pos,
              defZh: dict.defZh,
              ...(hasPhonetic ? { phoneticSrc: 'pipeline' as const } : {}),
              ...(hasDef ? { defSrc: 'authored' as const } : {}),
            }
          : {}),
      });
      const state: WordState = {
        status: result.word.status,
        meetCount: result.word.meetCount,
      };
      cache.set(key, state);
      let sceneId: string | undefined;

      // FR-C1 / FR-C3：把这次划词所在的句子写进例句表。
      //
      // 三条边界（`PLAN.md` §1.C 的口径）：
      //  ① `status = ignored` 的词**不采集**（OQ14）——判定只在这里做一次，内容脚本不再判第二遍；
      //  ② 写例句失败**不回滚词**：词已经进库了，抛出去只会让卡片谎报失败，
      //     用户会重复点、而再点还是失败；失败只留一条诊断日志（FR-L4）；
      //  ③ 去重交给 `addScene` 的 `sceneHash(wordId, text)`：同词同句永不产生第二条。
      if (record.scene && result.word.status !== 'ignored') {
        try {
          const added = await addScene({
            wordId: result.word.id,
            text: record.scene.text,
            highlightFrom: record.scene.highlightFrom,
            highlightTo: record.scene.highlightTo,
            sourceUrl: record.scene.sourceUrl,
            sourceTitle: record.scene.sourceTitle,
          });
          sceneId = added.scene.id;
        } catch (error) {
          void writeLog({
            level: 'warn',
            scope: 'scene',
            message: '例句写入失败',
            detail: {
              lemma: key,
              reason: error instanceof Error ? error.message : String(error),
            },
          }).catch(() => {});
        }
      }

      return sceneId ? { ...state, sceneId } : state;
    },

    async setStatus(word, status) {
      const key = keyOf(word);
      if (key === '') return UNSEEN;

      // ⚠️ `updateWordStatus` 按 **id** 取记录，不是按 lemma。
      // 所以必须先查出这条记录拿到 id——直接传 lemma 会静默什么都不发生。
      const existing = await getWordByLemma(key);
      if (!existing) return UNSEEN;

      // 状态变更不动 meetCount：`upsertWord` 会 +1，那是"遇见"的语义，
      // 而用户在卡片上点"已掌握"并不是又遇见了一次。
      const updated = await updateWordStatus(existing.id, status);
      const state: WordState = updated
        ? { status: updated.status, meetCount: updated.meetCount }
        : UNSEEN;
      cache.set(key, state);
      return state;
    },

    async getCard(word) {
      const key = keyOf(word);
      if (key === '') return undefined;

      const found = await getWordCard(key);
      if (!found) return undefined;

      // `listScenesByWord` 已按 `capturedAt` 升序排好，因此 [0] 就是首条例句
      const first = found.scenes[0];
      return {
        firstSeenAt: found.word.createdAt,
        examples: first
          ? [{ text: first.text, source: first.domain || null, at: first.capturedAt }]
          : [],
      };
    },

    clear() {
      cache.clear();
    },
  };
}
