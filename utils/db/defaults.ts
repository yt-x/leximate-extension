/**
 * 设置与元数据的**默认值**（PLAN.md FR-E1）。
 *
 * ## 为什么单独一个文件
 *
 * 这些默认值原先住在 `utils/db/kv.ts` 里。而 `kv.ts` 要读写 IndexedDB，
 * 于是**内容脚本为了拿一个常量，把整个存储层拉进了自己的依赖图**：
 *
 * ```
 * entrypoints/content.ts → utils/db/kv.ts → utils/db/schema.ts → indexedDB
 * ```
 *
 * 目前靠 Rollup 的 tree-shaking 侥幸兜住（`DEFAULT_SETTINGS` 是纯对象字面量，
 * 读库那半边被摇掉了，产物里确实没有 `indexedDB`）。**但这是巧合不是保证**：
 * 只要有人给 `kv.ts` 或 `schema.ts` 加一句顶层副作用，`indexedDB` 就会
 * 静默回到内容脚本里——而在内容脚本中，Web 存储访问落在**宿主页面源**上
 * （`docs/reference/extension-storage-and-messaging.md` §1）。
 *
 * 把默认值拆出来，依赖图上就不再存在这条"为了常量而拉进存储层"的边。
 * `scripts/check-content-boundary.ts` 会守住这个边界。
 *
 * **本文件必须保持纯数据**：不 import 任何东西，不产生副作用。
 */
import type { Meta, Settings } from './types';

export const SETTINGS_KEY = 'app';
export const META_KEY = 'app';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  underlineStyle: 'dotted',
  underlineColor: '#d98b2b',
  underlineThickness: 1,
  reflectMeetCount: false,
  blacklist: [],
  trigger: 'select',
  minWordLength: 2,
  /**
   * 选中即入库。**默认关闭**（FR-A6 的手动收藏轮修订）。
   *
   * 打开时回到旧行为"划词就收进生词本"；关闭时划词**只弹卡片**，
   * 由用户点「加入生词本」才写库。默认关的理由是用户实测反馈：
   * 自动入库会被频繁的误选触发，生词本里塞满没打算收的词。
   */
  autoAddOnSelect: false,
  /** FR-I2：1 = 正常语速。边界与钳制规则见 `utils/content/speech.ts` */
  speechRate: 1,
  translation: {
    /**
     * ⚠️ 默认值是 `chrome-builtin` 而**不是** `llm`。
     *
     * 原先是 `'llm'` 配 `llm: null`——这两者不自洽：引擎指向一个没配置的通道，
     * 表现是翻译**静默不工作**（没有 key、没有地址、也不报错）。
     * PLAN.md OQ4 要求 LLM 默认关闭，所以默认落到不依赖任何配置的兜底引擎。
     */
    engine: 'chrome-builtin',
    targetLang: 'zh-CN',
    llm: null,
    limits: { batchSize: 20, concurrency: 2, dailyLimit: 2000 },
    api: null,
  },
  webdav: null,
  ui: {
    /** FR-L1：默认跟随浏览器语言（解析见 utils/i18n，解析不出来兜底中文） */
    language: 'auto',
    theme: 'auto',
    pageSize: 50,
  },
};

export function defaultMeta(now: number = Date.now()): Meta {
  return {
    schemaVersion: 1,
    dictVersion: '',
    installedAt: now,
    persistGranted: false,
    lastExportAt: null,
    lastSyncAt: null,
    syncState: 'idle',
    lastSyncError: null,
    // FR-F10：null = 还没看过首次安装引导
    onboardingDoneAt: null,
    translationNoticeAt: null,
    translateCalls: null,
    // FR-B7b：导入词库的变形映射，导入时写入、移除时清空
    importedInflections: {},
  };
}
