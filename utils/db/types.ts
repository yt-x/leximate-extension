/**
 * 数据模型（PLAN.md §2）。
 *
 * 字段名与规格逐字对应，改字段先改 PLAN.md。
 */

export type WordStatus = 'new' | 'known' | 'ignored';
export type WordOrigin = 'native' | 'migrated';
export type TranslationEngine = 'llm' | 'chrome-builtin' | 'api';
/** 音标来源（FR-B9）：本项目 CMUdict 管线算出的，还是导入词库带来的 */
export type PhoneticSource = 'pipeline' | 'imported' | null;
/** 释义来源（FR-B10）：自撰 / 导入词库 / LLM 增强 */
export type DefinitionSource = 'authored' | 'imported' | 'llm' | null;

/**
 * 词典条目（导入的完整词库）——**只读的静态数据，不是生词**。
 *
 * 为什么单独一个类型而不是复用 `Word`：词典与生词本是两类东西。
 * 词典没有 `status` / `meetCount` / `deletedAt` / `createdAt` —— 那些是"用户行为"，
 * 词典条目一辈子都不会有。把它们塞进 `Word` 会逼着每个查询都过滤一遍
 * （上一轮就是这么错的，见 `decisions/0031`）。
 *
 * 存在 `dict` store 里，与 `words`（生词本）互不相干：
 * 计数、列表、导出、备份、同步**天然看不到词典**，不需要任何运行时过滤。
 */
export interface DictEntry {
  /** 归一化原形（小写），主键 */
  lemma: string;
  /** 页面上可能见到的写法（保留大小写，如 `PC`） */
  surface: string;
  /** 音标原样保存（ECDICT 音标不是 IPA，见 FR-B7a） */
  phoneticUs: string;
  /** 音标来源：目前只可能是 'imported'；空音标时为 null */
  phoneticSrc: PhoneticSource;
  defZh: string[];
  pos: string[];
  examTags: string[];
  freqBnc: number;
  freqCoca: number;
  /** ECDICT 词形变化原始串 */
  exchange: string;
  /** 词条来自哪份数据（目前只有 'ecdict'） */
  source: string;
}

export interface Word {
  id: string;
  /** 规范原形，小写；`words.lemma` 唯一索引 */
  lemma: string;
  /** 页面上实际遇见的形式，保留大小写与变形 */
  surface: string;
  phoneticUs: string;
  phoneticUk: string;
  /**
   * FR-B9：音标的来源。`null` 表示没有音标。
   *
   * FR-B9 的验收是「不存在无来源标记的音标」，因此**有音标就必须有来源**；
   * `utils/db/words.ts` 的 `upsertWord` 负责在写入时维持这条不变式。
   */
  phoneticSrc: PhoneticSource;
  /**
   * FR-B10：释义的来源。`null` 表示还没有任何释义。
   *
   * 导入完整词库时**不得覆盖** `defSrc === 'authored'` 的既有释义。
   */
  defSrc: DefinitionSource;
  /** 中文释义，按词性切分 */
  defZh: string[];
  pos: string[];
  /** cet4 | cet6 | ky | toefl | ielts | gre */
  examTags: string[];
  freqBnc: number;
  freqCoca: number;
  /** 词形变化原始串 */
  exchange: string;
  status: WordStatus;
  /** 遇见次数，决定下划线表现 */
  meetCount: number;
  /** surface !== lemma */
  isLemmatized: boolean;
  /**
   * FR-B3c：当这个 surface **同时也是另一个词条的屈折形式**时，记下那个原形。
   *
   * `saw` 既是"锯子"也是 `see` 的过去式——此字段只用于附一行"see 的过去式"的提示，
   * **独立词义不受影响**。查词时由 `LookupHit.inflectionOf` 带出，不改变 `defZh`。
   */
  inflectionOf: string | null;
  /** 词库未收录（仍然采集，导出时标记） */
  isUnlisted: boolean;
  origin: WordOrigin;
  /** 仅迁移数据使用：原平台释义，词库未收录时保留 */
  fallbackDef: string[];
  /** 可选 LLM 增强释义，不覆盖 defZh */
  llmDef: string[];
  createdAt: number;
  updatedAt: number;
  /** 同步用墓碑 */
  deletedAt: number | null;
}

export interface Scene {
  id: string;
  wordId: string;
  /** 例句原文，已清洗 */
  text: string;
  /** 被划词在 text 中的起始偏移 */
  highlightFrom: number;
  highlightTo: number;
  /** 由 translations 缓存回填 */
  translation: string | null;
  sourceUrl: string;
  sourceTitle: string;
  domain: string;
  capturedAt: number;
  /** 同词同句去重 */
  contentHash: string;
}

export interface Translation {
  /** hash(text + lang + engine + model) */
  id: string;
  textHash: string;
  targetLang: string;
  engine: TranslationEngine;
  model: string;
  result: string;
  createdAt: number;
}

export type QueueState = 'pending' | 'running' | 'failed';

export interface QueueItem {
  id: string;
  wordId: string;
  sceneId: string;
  textHash: string;
  targetLang: string;
  state: QueueState;
  attempts: number;
  lastError: string | null;
  createdAt: number;
}

export type UnderlineStyle = 'dotted' | 'solid' | 'wavy' | 'none';
export type TriggerMode = 'select' | 'click' | 'both';
export type UiLanguage = 'auto' | 'zh-CN' | 'en';
export type ThemeMode = 'auto' | 'light' | 'dark';

export interface Settings {
  /** FR-A14 全局开关：关闭时零注入、零标注 */
  enabled: boolean;
  underlineStyle: UnderlineStyle;
  underlineColor: string;
  /** FR-A11 线宽，px */
  underlineThickness: number;
  /** FR-A11：是否用样式（线宽分档）反映遇见次数 */
  reflectMeetCount: boolean;
  /** 不注入、不标注的域名（后缀匹配） */
  blacklist: string[];
  trigger: TriggerMode;
  /** 短于该长度的选中词不处理 */
  minWordLength: number;
  /** 选中即入库，还是只弹窗、由用户确认 */
  autoAddOnSelect: boolean;
  /**
   * FR-I2：发音语速（倍速），`1` 为正常语速。
   *
   * 取值范围由 `utils/content/speech.ts` 的 `MIN_RATE` / `MAX_RATE` 定义，
   * 设置页按它校验、运行时按它钳制（设置可能被手改或被旧版本写坏）。
   */
  speechRate: number;
  translation: {
    engine: TranslationEngine;
    targetLang: string;
    llm: { baseUrl: string; apiKey: string; model: string } | null;
    api: { url: string; headers: Record<string, string> } | null;
    /**
     * FR-D5：成本控制，三项全部可配。
     *
     * 范围由 `utils/translate/chain.ts::clampLimits` 钳制——设置可能被手改或被旧版本写坏，
     * 读的一侧永远再钳一次。
     */
    limits: {
      /** 单次最多送多少句 */
      batchSize: number;
      /** 同时最多几个请求 */
      concurrency: number;
      /** 每日调用上限；`0` 表示暂停翻译 */
      dailyLimit: number;
    };
  };
  /**
   * FR-H1 / FR-H5：WebDAV 配置。
   *
   * `passphrase` 非空表示**远端加密**（FR-H5）：上传前用口令加密，下载时用它解密。
   * 口令与凭据同属"只存本机"，不进导出、不随同步文件上传（FR-H7）。
   */
  webdav:
    | {
        url: string;
        username: string;
        password: string;
        path: string;
        passphrase?: string;
        /** FR-H4：定时同步周期，分钟；缺省 15。 */
        syncIntervalMinutes?: number;
      }
    | null;
  ui: {
    language: UiLanguage;
    theme: ThemeMode;
    pageSize: number;
  };
}

export interface Meta {
  schemaVersion: number;
  dictVersion: string;
  installedAt: number;
  persistGranted: boolean;
  lastExportAt: number | null;
  lastSyncAt: number | null;
  /** FR-H6：自动/手动同步的持久状态与最近错误，页面重载后仍可见。 */
  syncState: 'idle' | 'running' | 'ok' | 'error';
  lastSyncError: string | null;
  /**
   * FR-F10：首次安装引导是否已看过。`null` 表示还没看过。
   *
   * 老库没有这个字段：`getMeta()` 按 `{ ...defaultMeta(), ...row.value }` 合并读取，
   * 因此读出来就是默认的 null，不需要动 `schemaVersion`。
   */
  onboardingDoneAt: number | null;
  /**
   * FR-D7：翻译（会让句子离开浏览器）的首次开启告知是否已确认。
   *
   * `null` 表示没确认过——此时**不得**发出任何翻译请求。与 `onboardingDoneAt` 同样
   * 靠 `getMeta()` 的合并读取兜底，不动 `schemaVersion`。
   */
  translationNoticeAt: number | null;
  /**
   * FR-D5：翻译调用数的每日计数（`{ date: 'YYYY-MM-DD', count }`）。
   *
   * `date` 不是今天时读作 0（跨天归零），因此不需要定时任务去清它。
   * 老库没有这个字段，为 `null`。
   */
  translateCalls: { date: string; count: number } | null;
  /**
   * FR-B7b：导入词库的变形映射（`surface → { lemma, label }`）。
   *
   * 为什么要单独存一张表：导入词的 `exchange` 给出的是"本词有哪些变形"，
   * 查询时要反着查（`constraints` → `constraint`）。逐次扫 77 万条不可接受，
   * 所以在导入时把关系摊平成映射存进 `meta`；移除导入词库时整项清空。
   *
   * 老库没有这个字段，`getMeta()` 合并读取兜底为空对象，不动 `schemaVersion`。
   */
  importedInflections: Record<string, { lemma: string; label: string }>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id?: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail: unknown;
  at: number;
}

/** `settings` 与 `meta` 两个 store 的存储形态 */
export interface KeyValue<T> {
  key: string;
  value: T;
}
