/**
 * 内容脚本侧的词状态**本地缓存**（PLAN.md FR-A10、FR-A17）。
 *
 * ⚠️ 本模块替代了原先直接读写 IndexedDB 的实现。原实现是**错的**：
 * 内容脚本里的 `indexedDB.open('leximate')` 打开的是**宿主页面源**的库，
 * 而后台读的是**扩展源**的库——两个同名但互不可见的库。
 * 官方原文（见 `docs/reference/extension-storage-and-messaging.md` §1）：
 *
 * > In content scripts, calling web storage APIs accesses data from the host page
 * > the content script is injected on and not the extension.
 *
 * 后果是划词记的生词后台看不到、角标不涨、管理台也无从展示。
 * 按 `PLAN.md` §4.5 P3「生词集合由 SW 下发」，数据**归后台所有**，
 * 内容脚本只持有一份**当前页面用得到的**缓存。
 *
 * 设计要点：
 * - **标注路径必须同步读**（FR-A12 长页面滚动不卡顿），所以缓存是主路径，
 *   网络/消息只在启动与变更时发生。
 * - 内容脚本要"写"时**发消息给后台**落库，不在本地改真值。
 * - 缓存只装**当前页面出现过的词**，不装全量词库——
 *   官方安全提示："Assume any data sent to the content script might leak to the web page."
 */
import { UNSEEN, type CardDetail, type MeetRecord, type WordState } from './word-state-shared';
import type { WordDefinitionResult } from '../translate/define-word';

export type { WordState, MeetRecord };
export { UNSEEN };

function keyOf(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * 词状态的本地视图。
 *
 * **不持久化**：内容脚本每次注入都从后台拉一次权威状态。
 * 不做本地持久化的理由——页面源的库对后台不可见（见上），
 * 而把它存进 `storage.local` 又要处理"两个源谁新"的合并问题，
 * 收益却只是省一次启动拉取。等真机上量到需要优化再加。
 */
export interface WordStateCache {

  /**
   * 同步读缓存；**未命中返回 `undefined`**。
   *
   * 与 `peek` 的区别是**语义**，不是实现：
   * - `peek` 服务界面（"第一次见到的词显示 0 次遇见"是对的）
   * - `get` 服务**标注判定**——"词不在生词本里"和"词是生词"必须分开，
   *   混为一谈会让页面上每个词库词都被画上下划线（FR-A9 只标本地生词）
   */
  get(word: string): WordState | undefined;
  /** 用后台下发的数据**整体覆盖**缓存 */
  replaceAll(entries: ReadonlyArray<{ word: string; state: WordState }>): void;
  /** 单条写入（后台确认落库后调用） */
  set(word: string, state: WordState): void;
  /** 当前缓存的词数，用于诊断与测试 */
  size(): number;
  /** 清空（设置变更、词库切换时） */
  clear(): void;
}

export function createWordStateCache(): WordStateCache {
  const cache = new Map<string, WordState>();

  return {

    get(word) {
      const key = keyOf(word);
      if (key === '') return undefined;
      // 未命中就是"未知"：标注路径据此判断这个词不在生词本里
      return cache.get(key);
    },

    replaceAll(entries) {
      cache.clear();
      for (const { word, state } of entries) {
        const key = keyOf(word);
        if (key !== '') cache.set(key, state);
      }
    },

    set(word, state) {
      const key = keyOf(word);
      if (key !== '') cache.set(key, state);
    },

    size: () => cache.size,

    clear() {
      cache.clear();
    },
  };
}

/**
 * 后台侧的词状态接口（内容脚本通过消息调用）。
 *
 * 抽成接口的原因是**内容脚本不该知道后台怎么存**——
 * 它只需要"读一批词的状态"与"报一次遇见"这两个动作。
 */
export interface WordStateGateway {
  /** 拉取一批词的权威状态（未入库的词不必返回，缓存按 UNSEEN 处理） */
  fetchStates(words: readonly string[]): Promise<Array<{ word: string; state: WordState }>>;
  /** 上报一次遇见；返回落库后的状态 */
  recordMeet(record: MeetRecord): Promise<WordState | undefined>;
  /**
   * 拉**下划线集合**（`status = new` 的词条原形 + 遇见次数），§4.5 P3。
   *
   * 失败返回 `undefined`（后台不可达）——调用方据此决定要不要重扫，
   * 而不是把"拿不到"当成"生词本是空的"（那会把整页下划线抹掉）。
   */
  fetchNewWords(): Promise<Array<{ word: string; meetCount: number }> | undefined>;
  /** 改状态（FR-A6 的"标记为已掌握 / 改回生词 / 忽略"） */
  setStatus(word: string, status: WordState['status']): Promise<WordState | undefined>;
  /**
   * FR-A5 ④段：拉一张卡片的"首次日期 + 首条例句 + 来源域名"。
   *
   * **可选**：没接这个能力（或返回 `undefined`）时，卡片维持"例句尚未采集"的显示，
   * 与没有这条通道时完全一致。
   */
  fetchCard?(word: string): Promise<CardDetail | undefined>;
  /**
   * FR-B7：内置分片未命中时问一次导入词典。
   *
   * **可选**：没接时划词行为与没有导入功能时完全一致（直接显示"未收录"）。
   * 返回 `null` 表示导入词典里也没有。
   */
  fetchImported?(word: string): Promise<{
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
  /** 用户点击后生成未收录词的 LLM 释义；错误以可见文本返回。 */
  defineWord(word: string): Promise<WordDefinitionResult>;
  /** 打开管理台（FR-A6）；失败返回 false */
  openManager(): Promise<boolean>;
}
