/**
 * 内容脚本 ↔ 后台的消息协议（PLAN.md §4.5 P3、FR-A6、FR-A17）。
 *
 * ⚠️ **为什么必须走消息而不是直接读库**：内容脚本里的 Web 存储 API 访问的是
 * **宿主页面源**，不是扩展源（官方原文见
 * `docs/reference/extension-storage-and-messaging.md` §1）。
 * 后台才是数据的持有者，内容脚本只持有一份当前页面的缓存。
 *
 * ⚠️ **方向决定 API**：`runtime.sendMessage` **不能**从后台投递给内容脚本
 * （同一文件 §2 的官方原文）。因此：
 * - 内容脚本 → 后台：用 `runtime.sendMessage`
 * - 后台 → 内容脚本：必须用 `tabs.sendMessage`（逐个标签页）
 *
 * 本模块只放**协议定义与纯函数**，不含任何浏览器 API，
 * 因此两侧都能安全导入，也能在单测里完整驱动。
 */
import type { SceneCapture } from './word-state-shared';

/** 消息类型前缀，避免与其它扩展/将来的消息撞名 */
const NS = 'leximate:';

export const MSG = {
  /** 内容脚本 → 后台：拉一批词的权威状态 */
  fetchStates: `${NS}fetch-states`,
  /** 内容脚本 → 后台：上报一次遇见（FR-A17 去抖在后台或内容脚本侧判定后调用） */
  recordMeet: `${NS}record-meet`,
  /** 内容脚本 → 后台：改状态（FR-A6） */
  setStatus: `${NS}set-status`,
  /** 内容脚本 → 后台：拿当前设置（内容脚本读不到扩展源的设置） */
  getSettings: `${NS}get-settings`,
  /** 内容脚本 → 后台：用户显式点击后生成未收录词的 LLM 释义（FR-B4） */
  defineWord: `${NS}define-word`,
  /**
   * 内容脚本 → 后台：打开管理台（FR-A6 的"打开管理台"）。
   *
   * 为什么必须绕后台：内容脚本跑在宿主页面源里，**打不开 `chrome-extension://` 页面**
   * （`window.open` 到扩展页会被当成跨源导航拒绝）。只有后台能 `tabs.create`。
   */
  openManager: `${NS}open-manager`,
  /**
   * 管理台 → 后台：**数据变了**（FR-A14 的角标重算）。
   *
   * 管理台直接写扩展源的 IndexedDB，后台不会收到任何事件；
   * 没有这条通知，删词/改状态后角标会一直停在旧数字上。
   */
  dataChanged: `${NS}data-changed`,
  /**
   * 内容脚本 → 后台：拉**下划线集合**（`status = new` 的词条原形 + 遇见次数）。
   *
   * `PLAN.md` §4.5 P3 的"生词集合由 SW 一次性下发"。有了它，标注不再需要
   * "页面上每个词都问一次后台"，也不会漏掉词表未收录的词（如 `proof`）。
   */
  fetchNewWords: `${NS}fetch-new-words`,
  /**
   * 内容脚本 → 后台：拉一张卡片的 ④段数据（FR-A5 的首次日期 + 首条例句 + 来源域名）。
   *
   * 只在"这次划的词**已在生词本里**"时发一次（一词一条）：未入库的词没有例句可显示，
   * 发了也是白问；而每次划词都拉全量例句会让消息随例句数一起变大。
   */
  fetchCard: `${NS}fetch-card`,
  /**
   * 内容脚本 → 后台：查**导入词库**里有没有这个词（FR-B7）。
   *
   * 为什么需要它：内置词表在内存分片里，导入词在扩展源的 IndexedDB 里，
   * 而内容脚本读不到扩展源的库（`decisions/0010`）。分片未命中时发一次。
   */
  fetchImported: `${NS}fetch-imported`,
  /**
   * 内容脚本 → 后台：读一个随包词表文件（`index.json` / 分片 / 变形索引）的**文本**。
   *
   * 为什么不让内容脚本自己 `fetch(getURL(...))`：内容脚本虽然跑在隔离世界，
   * 但发起的请求来源仍是**页面源**，会受页面 CSP / 安全策略约束。
   * 实测 2026-10-23 在 YouTube 上直接 fetch 报
   * `Unsafe attempt to load URL chrome-extension://…/dict/… from frame with URL https://www.youtube.com/`，
   * 整份词库加载失败（`web_accessible_resources` 不能豁免页面 CSP）。
   * 后台是扩展源，读自己的包不受此限。
   */
  readDictFile: `${NS}read-dict-file`,
  /**
   * 后台 → 扩展页面（管理台）：**词库变了，请重新读库**。
   *
   * 为什么必须由后台广播：内容脚本划词写入的是**扩展源**的库，
   * 管理台是另一个页面，两边互不感知（也没有 storage 事件，见 `decisions/0009`）。
   * 后台是所有写入的必经之路，只有它能发这条通知。
   *
   * ⚠️ 方向决定 API：广播给**扩展页面**用 `runtime.sendMessage`
   * （内容脚本收不到它，也不需要）；给内容脚本的仍是 `tabs.sendMessage`。
   */
  wordsChanged: `${NS}words-changed`,
  /** 后台 → 内容脚本：设置变了（必须用 tabs.sendMessage 投递） */
  settingsChanged: `${NS}settings-changed`,
  /**
   * 内容脚本 → 后台：上报一条**诊断日志**（FR-L4）。
   *
   * 为什么必须绕后台：内容脚本读不到扩展源的存储（同文件 §1），
   * 而日志表在扩展源。它是**单向通知**，不需要回复。
   */
  log: `${NS}log`,
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface FetchStatesRequest {
  type: typeof MSG.fetchStates;
  words: string[];
}

/** 拉一张卡片的 ④段数据（FR-A5）：首次日期 + 首条例句 + 来源域名 */
export interface FetchCardRequest {
  type: typeof MSG.fetchCard;
  /** 记账键（词条原形） */
  word: string;
}

export interface RecordMeetRequest {
  type: typeof MSG.recordMeet;
  /** 记账键：命中时是词条原形，未收录时是页面词形（§2 数据模型） */
  lemma: string;
  /** 页面原形，保留大小写 */
  surface: string;
  /** FR-B4：词库未收录 */
  unlisted: boolean;
  inflectionOf?: string | null;
  /** 命中词库时的字段（未收录时不带） */
  dict?: { phoneticUs: string; pos: string[]; defZh: string[] };
  /**
   * FR-C1：这次划词所在的句子。
   *
   * **可选**：捕获失败（或内容脚本没接这个能力）时不带这个字段，
   * 后台照旧只记账、不写例句——与没有例句采集时行为一致。
   */
  scene?: SceneCapture;
}

export interface SetStatusRequest {
  type: typeof MSG.setStatus;
  word: string;
  status: 'new' | 'known' | 'ignored';
}

export interface GetSettingsRequest {
  type: typeof MSG.getSettings;
}

export interface DefineWordRequest {
  type: typeof MSG.defineWord;
  word: string;
}

export interface OpenManagerRequest {
  type: typeof MSG.openManager;
}

/** 内容脚本 → 后台：拉下划线集合（生词集合下发，§4.5 P3） */
export interface FetchNewWordsRequest {
  type: typeof MSG.fetchNewWords;
}

/** 内容脚本 → 后台：查导入词库（FR-B7） */
export interface FetchImportedRequest {
  type: typeof MSG.fetchImported;
  /** 查询的 surface（页面原形） */
  word: string;
}

/**
 * 内容脚本 → 后台：读一个随包词表文件的文本。
 *
 * 只允许 `dict/` 下的白名单文件名（后台会校验），避免这条通道被用来读任意文件。
 */
export interface ReadDictFileRequest {
  type: typeof MSG.readDictFile;
  /** 相对 `dict/` 的文件名，如 `index.json` / `shard-core.json` / `inflections.json` */
  file: string;
}

/**
 * 管理台 → 后台的"数据变了"通知。
 *
 * 与其余四种消息的区别：它是**单向通知**，没有负载、也不需要回复
 * （后台收到就算数字、重写角标、再广播给内容脚本）。
 *
 * ⚠️ 刻意**不**提供 `isDataChangedNotice` 之类的判定函数：后台的
 * `handleContentMessage` 本身就是白名单（`switch` + `default` 归为"不归我管"），
 * 再加一层守卫就是没人调用的死代码——实测复核时发现过。
 */
export type DataChangedNotice = { type: typeof MSG.dataChanged };

/** 后台 → 扩展页面：词库变了（内容脚本划词、或别处写完库） */
export interface WordsChangedNotice {
  type: typeof MSG.wordsChanged;
}

/** 后台 → 内容脚本的单向通知；新版设置随消息一起带上，避免收方再问一次 */
export interface SettingsChangedNotice {
  type: typeof MSG.settingsChanged;
  settings: unknown;
}

/**
 * 内容脚本 → 后台：一条诊断日志（FR-L4）。
 *
 * 负载是**不可信输入**（内容脚本可能被页面影响），因此后台侧会再洗一遍：
 * 级别走白名单、scope/message 限长、detail 只保留可序列化的部分。
 */
export interface LogReportRequest {
  type: typeof MSG.log;
  level?: unknown;
  scope?: unknown;
  message?: unknown;
  detail?: unknown;
}

export type ContentRequest =
  | FetchStatesRequest
  | FetchCardRequest
  | FetchNewWordsRequest
  | FetchImportedRequest
  | ReadDictFileRequest
  | RecordMeetRequest
  | SetStatusRequest
  | GetSettingsRequest
  | DefineWordRequest
  | OpenManagerRequest
  | LogReportRequest;

/**
 * 判断一条消息是不是本扩展的内容脚本请求。
 *
 * 用**白名单**判定而不是"有 type 字段就算"：消息可能来自别的扩展
 * （`onMessageExternal`）或页面，官方安全提示要求把进来的消息当作不可信输入
 * （见 `docs/reference/extension-storage-and-messaging.md` §4）。
 */
export function isContentRequest(message: unknown): message is ContentRequest {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return (
    type === MSG.fetchStates ||
    type === MSG.fetchNewWords ||
    type === MSG.fetchCard ||
    type === MSG.fetchImported ||
    type === MSG.readDictFile ||
    type === MSG.recordMeet ||
    type === MSG.setStatus ||
    type === MSG.getSettings ||
    type === MSG.defineWord ||
    type === MSG.openManager ||
    type === MSG.log
  );
}

/** 判断一条消息是不是"词库变了"的广播（管理台与内容脚本据此重读/重扫） */
export function isWordsChangedNotice(message: unknown): message is WordsChangedNotice {
  if (typeof message !== 'object' || message === null) return false;
  return (message as { type?: unknown }).type === MSG.wordsChanged;
}

/**
 * 把请求里的 `words` 洗成可安全查询的形态。
 *
 * 内容脚本的输入**不可信**（官方安全提示），因此：
 * - 非数组一律当空
 * - 只保留非空字符串
 * - 去重并小写（查询按 lemma 小写匹配）
 * - **限长**：避免一个畸形请求让后台做上万次查询
 */
export const MAX_FETCH_WORDS = 500;

export function sanitizeWords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const out = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toLowerCase();
    if (key === '') continue;
    out.add(key);
    if (out.size >= MAX_FETCH_WORDS) break;
  }
  return [...out];
}

/** 洗一个单词（内容脚本上报的 word 同样不可信） */
export function sanitizeWord(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const key = input.trim().toLowerCase();
  return key === '' ? null : key;
}

/**
 * 洗一个**页面原形**（`surface`）。
 *
 * 与 `sanitizeWord` 的区别是**不做小写化**——§2 明确"`surface` 保留页面原样"，
 * 小写化会把用户看到的形式改掉。上限与 FR-A16 的 45 字符对齐（再留一点余量给
 * 可能的连字符变体），超出即判为不可信输入丢弃。
 */
export const MAX_SURFACE_LENGTH = 64;

export function sanitizeSurface(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text === '' || [...text].length > MAX_SURFACE_LENGTH) return null;
  return text;
}

/** 洗一个字符串数组（释义与词性），限长限量 */
export function sanitizeStringList(input: unknown, max = 20, maxLength = 200): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text === '' || [...text].length > maxLength) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 洗一组词库字段（FR-A5 的释义段与音标）。
 *
 * 三项**必须同时合法**才接受：只收下一半（比如有释义没音标）会让词条进入
 * "半截数据"状态，界面出现空音标列。宁可整组丢掉（表现为"这次只记了词本身"）。
 */
export function sanitizeDictFields(
  input: unknown,
): { phoneticUs: string; pos: string[]; defZh: string[] } | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as { phoneticUs?: unknown; pos?: unknown; defZh?: unknown };

  const phoneticUs = typeof raw.phoneticUs === 'string' ? raw.phoneticUs.trim() : '';
  if ([...phoneticUs].length > MAX_SURFACE_LENGTH) return null;

  const pos = sanitizeStringList(raw.pos, 10, 20);
  const defZh = sanitizeStringList(raw.defZh, 30);
  if (defZh.length === 0) return null;

  return { phoneticUs, pos, defZh };
}

/**
 * 解析 `MSG.fetchImported` 的响应（FR-B7）。
 *
 * 后台回的形状与 `ImportedLookup` 的返回值一致：
 * `{ lemma, hint, word: { phoneticUs, pos, defZh, fallbackDef, examTags } }` 或 `null`。
 *
 * 口径：`dict` 字段走 `sanitizeDictFields` 的同一套清洗；**释义为空就不算命中**
 * （没有释义的词典条目对用户毫无价值，显示出来只会是空卡片）。
 */
export function parseImportedResponse(input: unknown): {
  lemma: string;
  hint: string | null;
  word: { phoneticUs: string; pos: string[]; defZh: string[]; fallbackDef: string[]; examTags: string[] };
} | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as { lemma?: unknown; hint?: unknown; word?: unknown };
  if (typeof raw.lemma !== 'string' || raw.lemma.trim() === '') return null;

  const dict = sanitizeDictFields(raw.word);
  if (!dict) return null;

  const hint = typeof raw.hint === 'string' && raw.hint.trim() !== '' ? raw.hint.trim() : null;
  return {
    lemma: raw.lemma.trim().toLowerCase(),
    hint,
    word: { ...dict, fallbackDef: [], examTags: [] },
  };
}

const VALID_STATUS = new Set(['new', 'known', 'ignored']);

/** 洗一个状态值；非法值返回 null（不猜、不默认） */
export function sanitizeStatus(input: unknown): 'new' | 'known' | 'ignored' | null {
  return typeof input === 'string' && VALID_STATUS.has(input)
    ? (input as 'new' | 'known' | 'ignored')
    : null;
}
