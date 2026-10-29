/**
 * 词状态的**共享类型**（后台与内容脚本都要用）。
 *
 * 单独成文件的原因：`utils/content/word-state-cache.ts`（内容脚本侧）
 * 与 `utils/content/word-state.ts`（后台侧）都需要 `WordState`，
 * 而内容脚本**不能**从后台模块导入实现——那会把 IndexedDB 相关代码
 * 带进内容脚本包（内容脚本里那些 API 打开的是页面源，见
 * `docs/reference/extension-storage-and-messaging.md` §1）。
 *
 * 所以：**类型与常量放这里，实现各在各家。**
 */
import type { WordStatus } from '../db/types';

export interface WordState {
  status: WordStatus;
  meetCount: number;
}

/**
 * 命中词库时能回填到词条上的字段（FR-A5 的四段内容、FR-B9 / FR-B10 的来源标记）。
 *
 * 只带内容脚本真正拿得到的那几项；来源标记（`phoneticSrc` / `defSrc`）**不在这里**——
 * 它们由后台侧按"来自本项目管线 / 自撰释义"补上，内容脚本不该也不需要知道。
 */
export interface MeetDictFields {
  phoneticUs: string;
  pos: string[];
  defZh: string[];
}

/**
 * 一条例句的采集结果（PLAN.md FR-C1 / FR-C2 / FR-C4）。
 *
 * `domain` 与 `capturedAt` **刻意不在这里**：它们由 `addScene` 侧从 URL 与当前时间推出
 * （`domainOf(url)` / `Date.now()`）。内容脚本再实现一遍只会多出一处可能与库里不一致的算法。
 */
export interface SceneCapture {
  /** 例句原文（已清洗；超长时两端带 `…`） */
  text: string;
  /** 被划的词在 `text` 里的起始偏移 */
  highlightFrom: number;
  /** 结束偏移（不含） */
  highlightTo: number;
  /** `location.href` */
  sourceUrl: string;
  /** `document.title` */
  sourceTitle: string;
}

/**
 * 一次遇见的记账内容（FR-A17 + `PLAN.md` §2 数据模型）。
 *
 * ⚠️ **为什么不是一个裸字符串**：`lemma` 是词条的记账键（非唯一索引，兼容历史数据），页面词形 `running`
 * 只是词条 `run` 的一个变形。旧实现把 `surface` 当记账键传给后台，
 * 于是划 `running` 会新建一条 `lemma='running'` 的词，**永远累加不到 `run` 上**；
 * 而未收录的 `learni` 会以 `isUnlisted=false` 进库，在管理台里与真单词完全一样。
 *
 * 因此记账必须同时带上三样东西：**记账键（lemma）、页面原形（surface）、是否未收录**。
 */
export interface MeetRecord {
  /** 记账键。命中时是词条原形，未收录时就是页面词形 */
  lemma: string;
  /** 页面上的原形，保留大小写（§2：`surface` 保留页面原样） */
  surface: string;
  /** FR-B4：词库未收录（**仍采集**，导出时标记） */
  unlisted: boolean;
  /**
   * FR-B3c：`surface` 本身是独立词条、同时也是另一个词条的屈折形式时，
   * 记下那个原形（如 `saw` 的 `see`）。没有就是 `null`。
   */
  inflectionOf?: string | null;
  /** 命中词库时的字段；未收录时没有 */
  dict?: MeetDictFields;
  /**
   * FR-C1：这次划词所在的句子。
   *
   * **可选**：捕获失败（或调用方没接这个能力）时**不带这个字段**，
   * 那时消息、入库与卡片的行为与没有例句采集时完全一致。
   */
  scene?: SceneCapture;
}

/**
 * 查不到的词按"生词、零次"处理——第一次遇见它就该被标注（FR-A10）。
 *
 * 冻结是为了防止调用方无意中改到这份共享默认值
 * （它会被多个模块返回，被改掉会污染全局默认语义）。
 */
export const UNSEEN: WordState = Object.freeze({ status: 'new', meetCount: 0 });

/** 卡片 ④段要的一条例句（FR-A5） */
export interface CardExample {
  text: string;
  /**
   * 来源**域名**（不是 URL）。
   *
   * 卡片只显示域名；完整 URL 在管理台详情与导出里（§3.1 的 `source` 列）。
   */
  source: string | null;
  /** 采集时间（毫秒） */
  at: number | null;
}

/**
 * 卡片 ④段需要的"词之外的本地数据"（FR-A5 ④段）。
 *
 * 内容脚本读不到扩展源的库，这些只有后台拿得到，因此单独一条消息（`fetch-card`）。
 */
export interface CardDetail {
  /** 首次遇见时间（词条 `createdAt`）；没有记录时 `null` */
  firstSeenAt: number | null;
  /** **首条例句**（按 `capturedAt` 升序的第一条）；没有例句时是空数组 */
  examples: CardExample[];
}
