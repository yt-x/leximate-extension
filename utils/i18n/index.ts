/**
 * 管理台界面文案（PLAN.md FR-L1；口径见 `decisions/0026`）。
 *
 * 范围：**只管管理台**。内容脚本的划词弹窗不参与 i18n（那边最常见的内容是网页原文例句，
 * 用户明确表示"可以全英文"）。
 *
 * 设计取舍：
 * - **默认 `auto`**：按浏览器语言解析，解析不出来就中文兜底。测试环境没有 `browser.i18n`，
 *   因此解析结果恒为中文——既有的界面用例（断言中文）一条都不用改。
 * - `t()` 找不到 key 时依次退到中文、再退到 key 本身：**缺文案可见但不致命**
 *   （`utils/i18n/index.test.ts` 里有一条用例锁住"两种语言的 key 集合一致"）。
 * - ⚠️ **不要在模块顶层把 `t()` 的结果存进常量**：那样语言切换后不会更新。
 *   需要"按 key 映射"时写成一个在渲染期调用的函数（例如 `Onboarding` 的 `titleOf`）。
 */
import type { UiLanguage } from '../db/types';
import { EN_OVERLAY } from './overlay';

export type Locale = 'zh-CN' | 'en';

/** 文案表。键名按 `区域.用途` 命名，两种语言的键必须一一对应 */
export const MESSAGES: Record<Locale, Record<string, string>> = {
  'zh-CN': {
    'app.title': 'Leximate / 词伴',
    'app.tagline': '本地生词本 · v{version} · 数据只存在本机',
    /** 中文用全角冒号，英文用「冒号+空格」——拼在文案里会跟着语言一起变 */
    'common.sep': '：',
    'tab.words': '生词',
    'tab.settings': '设置',
    'tab.diag': '诊断',

    'language.label': '界面语言',
    'language.auto': '跟随浏览器',
    'language.zh-CN': '中文',
    'language.en': 'English',
    'language.hint': '只影响管理台界面；划词弹窗不随此项变化。',

    // 词库状态（FR-F11）
    'dict.notLoaded': '词库尚未载入：第一次划词时载入（读的是扩展自带的文件，不出网）',
    'dict.ready': '词库已就绪',
    'dict.shards': '{count} 个分片',
    'dict.words': '{count} 词',
    'dict.version': '版本 {version}',
    'dict.elapsed': '载入耗时 {ms} ms',

    // 首装引导（FR-F10）
    'onboarding.aria': '首次使用引导',
    'onboarding.title': '第一次用，先花 30 秒看四件事',
    'onboarding.subtitle': '关掉也能正常用，之后可在设置页找到这些说明',
    'onboarding.dismiss': '知道了，开始使用',
    'onboarding.dismissed': '已关闭',
    'onboarding.dictStatus.title': '词库准备情况',
    'onboarding.dictStatus.hint':
      '载入完成之前，不会有任何词被判定成"未收录"——导入预演在这种情况下会直接报错，而不是给一个假的未收录数。',
    'onboarding.dictStatus.importHint':
      '内置词表只覆盖常用词。低频词查不到时，可在设置页导入完整的 ECDICT 词库（数据由你自备，不进扩展包）。',
    'onboarding.uninstall.title': '先说清楚：卸载会丢数据',
    'onboarding.uninstall.lead': '卸载这个扩展、或清理浏览器数据，会连同本地生词与例句一起清除',
    'onboarding.uninstall.rest':
      '扩展不会在云端留副本，删掉之后无法恢复。建议定期在「生词」页的工具栏导出一次 JSON 备份。',
    'onboarding.switches.title': '三个最该知道的开关',
    'onboarding.switches.query.title': '划词只是查询',
    'onboarding.switches.query.body':
      '默认不会把词收进生词本——弹卡后点「加入生词本」才写入。想让划词直接入库，去设置页打开「选中即入库」。',
    'onboarding.switches.underline.title': '下划线提醒',
    'onboarding.switches.underline.body':
      '生词本里状态为「生词」的词会被下划线标出来；样式与开关都在设置页。',
    'onboarding.switches.minLength.title': '最短词长',
    'onboarding.switches.minLength.body':
      '设置页可调。短于该长度的选中词不处理，避免拖选过程中的前缀被误收。',
    'onboarding.privacy.title': '它默认不联网',
    'onboarding.privacy.body':
      '查词、音标、释义、例句全部来自扩展自带的文件与本机数据库，默认不发出任何网络请求。只有你主动开启句子翻译之后，被划的那一句才会离开浏览器；凭据只存在本机，不会进导出文件。',
    'onboarding.footer':
      '四块内容对应规格 FR-F10（引导）、FR-E6（卸载风险）、FR-F11（词库初始化可见）。',
  },
  en: {
    'app.title': 'Leximate',
    'app.tagline': 'Local vocabulary notebook · v{version} · data stays on this machine',
    'common.sep': ': ',
    'tab.words': 'Words',
    'tab.settings': 'Settings',
    'tab.diag': 'Diagnostics',

    'language.label': 'Interface language',
    'language.auto': 'Follow browser',
    'language.zh-CN': '中文',
    'language.en': 'English',
    'language.hint': 'Affects the manager UI only; the in-page popup does not change.',

    'dict.notLoaded':
      'Dictionary not loaded yet: it loads on your first selection (bundled with the extension, no network).',
    'dict.ready': 'Dictionary ready',
    'dict.shards': '{count} shard(s)',
    'dict.words': '{count} words',
    'dict.version': 'version {version}',
    'dict.elapsed': 'loaded in {ms} ms',

    'onboarding.aria': 'Getting started',
    'onboarding.title': 'First time here? 30 seconds, four things',
    'onboarding.subtitle': 'You can close this and use the app; the same notes live in Settings',
    'onboarding.dismiss': 'Got it, start using',
    'onboarding.dismissed': 'Closed',
    'onboarding.dictStatus.title': 'Dictionary status',
    'onboarding.dictStatus.hint':
      'Until loading finishes, no word is ever reported as "not in dictionary" — the import preview fails loudly instead of showing a fake count.',
    'onboarding.dictStatus.importHint':
      'The built-in list covers common words only. When a rare word is missing, import the full ECDICT dictionary from Settings (you supply the data; it does not ship with the extension).',
    'onboarding.uninstall.title': 'First, the important part: uninstalling loses data',
    'onboarding.uninstall.lead':
      'Uninstalling this extension, or clearing its browser data, deletes your words and example sentences',
    'onboarding.uninstall.rest':
      'There is no server-side copy, so it cannot be recovered. Export a JSON backup from the Words toolbar regularly.',
    'onboarding.switches.title': 'Three switches worth knowing',
    'onboarding.switches.query.title': 'Selecting only looks up',
    'onboarding.switches.query.body':
      'By default a selection is NOT added to your notebook — click "Add to notebook" on the card. Turn on "Add on select" in Settings to change that.',
    'onboarding.switches.underline.title': 'Underline reminders',
    'onboarding.switches.underline.body':
      'Words marked as "new" in your notebook get underlined; style and on/off live in Settings.',
    'onboarding.switches.minLength.title': 'Minimum word length',
    'onboarding.switches.minLength.body':
      'Configurable in Settings. Shorter selections are ignored, so partial prefixes from a drag-selection are never collected.',
    'onboarding.privacy.title': 'No network by default',
    'onboarding.privacy.body':
      'Definitions, phonetics and examples all come from bundled files and the local database — nothing is sent by default. Only after you enable sentence translation does the selected sentence leave the browser; credentials stay local and are never exported.',
    'onboarding.footer':
      'These four blocks cover FR-F10 (onboarding), FR-E6 (uninstall risk) and FR-F11 (dictionary init visibility).',
  },
};

/**
 * 把设置里的语言值解析成实际渲染用的语言。
 *
 * - `'auto'`（默认）：浏览器语言以 `en` 开头就英文，其余一律中文。
 * - `'zh-CN'` / `'en'`：显式覆盖。
 */
export function resolveLocale(
  language: UiLanguage | null | undefined,
  browserLanguage?: string | null,
): Locale {
  if (language === 'en') return 'en';
  if (language === 'zh-CN') return 'zh-CN';
  const lang = (browserLanguage ?? '').toLowerCase();
  return lang.startsWith('en') ? 'en' : 'zh-CN';
}

/** 当前渲染语言。模块级状态：切换时由调用方 `setLocale` 并触发一次重渲染 */
let current: Locale = 'zh-CN';

export function setLocale(next: Locale): void {
  current = next;
}

export function getLocale(): Locale {
  return current;
}

/** 取一条文案；`{name}` 形式的占位符用 `params` 填充 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = MESSAGES[current][key] ?? MESSAGES['zh-CN'][key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

/** 某个语言的 key 列表（用例用它比对两种语言是否对齐） */
export function keysOf(locale: Locale): string[] {
  return Object.keys(MESSAGES[locale]).sort();
}

/**
 * 按**中文原文**取文案（逐页搬文案时用这一条）。
 *
 * - 中文：原样返回原文（渲染结果与改造前逐字节一致，既有中文断言零风险）；
 * - 英文：查 `EN_OVERLAY`，查不到就退回中文（**漏翻可见、不白屏**）；
 * - 占位符 `{name}` 在两种语言下都按 `params` 填充。
 */
export function tx(zh: string, params?: Record<string, string | number>): string {
  const template = current === 'en' ? (EN_OVERLAY[zh] ?? zh) : zh;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

/** 英文覆盖层里还缺哪些中文原文（用例/工具用它核对完整性） */
export function overlayKeys(): string[] {
  return Object.keys(EN_OVERLAY).sort();
}
