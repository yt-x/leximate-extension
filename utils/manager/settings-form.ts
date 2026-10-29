/**
 * 设置表单的校验与序列化（PLAN.md FR-F9）。
 *
 * 分成两层是**刻意的**：
 * - `validateSettingsForm` 只做判定，返回错误清单，不碰存储
 * - `applyForm` 把合法的表单值合回 `Settings`
 *
 * 这样"哪些输入算非法"可以逐条单测，而不用起 React 或 IndexedDB。
 *
 * **为什么校验不能省**：设置要写进 IndexedDB 并被内容脚本读去用。
 * 一个 `minWordLength: -1` 或 `underlineThickness: 999` 写进去之后，
 * 表现是"标注全乱/页面卡"，很难回溯到设置页。
 */
import { tx } from '../i18n';
import { LIMIT_MAX, LIMIT_MIN } from '../translate/chain';
import type {
  Settings,
  ThemeMode,
  TranslationEngine,
  TriggerMode,
  UiLanguage,
  UnderlineStyle,
} from '../db/types';
// 语速边界**与运行时共用同一个来源**（`utils/content/speech.ts`）：
// 两边各写一套数字必然慢慢分叉，表现是"设置页允许 3，实际读出来还是 2"
import { MAX_RATE, MIN_RATE } from '../content/speech';

export interface SettingsFormErrors {
  [field: string]: string;
}

/** FR-A11 的线宽范围；与 `highlight-plan` 的档位缩放相乘后仍需落在可见范围 */
export const THICKNESS_MIN = 0.5;
export const THICKNESS_MAX = 4;
/** 短于该长度的选中词不处理；下限 1 是因为 0 等于"什么都处理" */
export const MIN_WORD_LENGTH_MIN = 1;
export const MIN_WORD_LENGTH_MAX = 20;
export const PAGE_SIZE_MIN = 20;
export const PAGE_SIZE_MAX = 500;

/**
 * 枚举取值的**白名单**。
 *
 * 这些列表必须与 `utils/db/types.ts` 的类型定义逐字一致——
 * 运行时可能从旧版本数据或手改的 IndexedDB 里读到已废弃的取值
 * （例如早期的 `browser` 引擎），界面不校验就会把它写回存储。
 * 类型系统管不到运行时输入，所以这里显式列一遍。
 */
const UNDERLINE_STYLES: readonly UnderlineStyle[] = ['dotted', 'solid', 'wavy', 'none'];
const TRIGGERS: readonly TriggerMode[] = ['select', 'click', 'both'];
const ENGINES: readonly TranslationEngine[] = ['llm', 'chrome-builtin', 'api'];
const LANGUAGES: readonly UiLanguage[] = ['auto', 'zh-CN', 'en'];
const THEMES: readonly ThemeMode[] = ['auto', 'light', 'dark'];

/**
 * 校验。返回空对象表示全部合法。
 *
 * 域名黑名单与 LLM 地址这类"字符串列表/URL"单独校验，
 * 因为它们的错误不会让程序崩，只会让功能静默不工作（黑名单写了 `https://` 前缀就匹配不上）。
 */
export function validateSettingsForm(form: Settings): SettingsFormErrors {
  const errors: SettingsFormErrors = {};

  if (
    !Number.isFinite(form.underlineThickness) ||
    form.underlineThickness < THICKNESS_MIN ||
    form.underlineThickness > THICKNESS_MAX
  ) {
    errors.underlineThickness = tx('线宽需在 {min} ~ {max} 之间', { min: THICKNESS_MIN, max: THICKNESS_MAX });
  }

  if (
    !Number.isInteger(form.minWordLength) ||
    form.minWordLength < MIN_WORD_LENGTH_MIN ||
    form.minWordLength > MIN_WORD_LENGTH_MAX
  ) {
    errors.minWordLength = tx('最短词长需为 {min} ~ {max} 的整数', { min: MIN_WORD_LENGTH_MIN, max: MIN_WORD_LENGTH_MAX });
  }

  if (
    !Number.isInteger(form.ui.pageSize) ||
    form.ui.pageSize < PAGE_SIZE_MIN ||
    form.ui.pageSize > PAGE_SIZE_MAX
  ) {
    errors.pageSize = tx('每页条数需为 {min} ~ {max} 的整数', { min: PAGE_SIZE_MIN, max: PAGE_SIZE_MAX });
  }

  // FR-I2：语速。越界会让朗读快得听不清或慢得不像话，且写进去之后
  // 很难回溯到设置页——所以与线宽、最短词长同一条规矩：非法就不让保存
  if (!Number.isFinite(form.speechRate) || form.speechRate < MIN_RATE || form.speechRate > MAX_RATE) {
    errors.speechRate = tx('发音语速需在 {min} ~ {max} 之间', { min: MIN_RATE, max: MAX_RATE });
  }

  // 颜色必须是 `#rgb` / `#rrggbb`：写 CSS 变量时非法值会让整条声明失效，
  // 表现是"下划线突然全没了"，而不是报错
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(form.underlineColor)) {
    errors.underlineColor = tx('颜色需为 #rgb 或 #rrggbb 形式');
  }

  if (!UNDERLINE_STYLES.includes(form.underlineStyle)) {
    errors.underlineStyle = tx('下划线样式取值非法');
  }
  if (!TRIGGERS.includes(form.trigger)) errors.trigger = tx('触发方式取值非法');
  if (!ENGINES.includes(form.translation.engine)) errors.engine = tx('翻译引擎取值非法');
  if (!LANGUAGES.includes(form.ui.language)) errors.language = tx('界面语言取值非法');
  if (!THEMES.includes(form.ui.theme)) errors.theme = tx('主题取值非法');

  const badDomains = form.blacklist.filter((d) => !isValidDomainEntry(d));
  if (badDomains.length > 0) {
    errors.blacklist = tx('以下条目不合法（应为域名后缀，如 example.com）：{list}', { list: badDomains.join('、') });
  }

  // LLM 只有在"启用了 llm 引擎"时才要求配置齐——选了引擎却没填 key 是最常见的静默失败
  if (form.translation.engine === 'llm') {
    const llm = form.translation.llm;
    if (!llm || llm.baseUrl.trim() === '') {
      errors.llmBaseUrl = tx('启用 LLM 翻译时必须填写接口地址');
    } else if (!isHttpUrl(llm.baseUrl)) {
      errors.llmBaseUrl = tx('接口地址需为 http(s) URL');
    }
    if (!llm || llm.apiKey.trim() === '') {
      errors.llmApiKey = tx('启用 LLM 翻译时必须填写 API Key');
    }
  }

  if (form.translation.engine === 'api') {
    const api = form.translation.api;
    if (!api || !isHttpUrl(api.url)) {
      errors.apiUrl = tx('启用自建接口时必须填写合法的 http(s) 地址');
    }
  }

  if (form.translation.targetLang.trim() === '') {
    errors.targetLang = tx('目标语言不能为空');
  }

  // FR-D5：三个上限都必须落在合法范围内。这里**不能**用 clampLimits 悄悄纠正——
  // 用户填了 9999 就该被告知，而不是保存后看到 100 却不知道为什么。
  const limits = form.translation.limits;
  // 标签在**调用处**就取好译文：这样每个中文字面量都在 `tx(...)` 里，
  // "不留未包裹中文"的门禁能直接看住它们（这是它抓到过三次漏网之后定下的写法）。
  const badLimit = (value: number, min: number, max: number, label: string): string | null =>
    Number.isInteger(value) && value >= min && value <= max
      ? null
      : tx('{label}需为 {min} ~ {max} 的整数', { label, min, max });
  const limitError =
    badLimit(limits.batchSize, LIMIT_MIN.batchSize, LIMIT_MAX.batchSize, tx('单批条数')) ??
    badLimit(limits.concurrency, LIMIT_MIN.concurrency, LIMIT_MAX.concurrency, tx('并发数')) ??
    badLimit(limits.dailyLimit, LIMIT_MIN.dailyLimit, LIMIT_MAX.dailyLimit, tx('每日上限'));
  if (limitError !== null) {
    errors.limits = limitError;
  }

  return errors;
}

export function hasErrors(errors: SettingsFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * 域名条目是否合法。
 *
 * 只接受**裸域名后缀**，不接受带协议/路径/通配符的写法。
 * 理由：项目里用的是"后缀匹配"（`Settings.blacklist` 注释），
 * 若允许 `https://example.com/*` 混进来，匹配会永远失败且用户看不出原因。
 */
export function isValidDomainEntry(raw: string): boolean {
  const value = raw.trim();
  if (value === '') return false;
  if (value.includes('/') || value.includes('://') || value.includes('*')) return false;
  // 至少一个点，且每段是字母数字与连字符
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 把文本域里的黑名单解析成数组。
 *
 * 按行拆、去空白、去空行、**去重并按字母序**排序——
 * 去重是必要的：重复项会让"删除某一项"的界面逻辑删不干净；
 * 排序则保证同一份输入两次解析结果一致（设置写回时不会产生无意义的 diff）。
 */
export function parseBlacklist(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (value !== '') seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function formatBlacklist(domains: readonly string[]): string {
  return domains.join('\n');
}

/**
 * 把校验通过的表单值合回完整设置。
 *
 * 只覆盖界面上真正暴露的字段，其余（webdav、翻译的其余部分）原样保留——
 * 那些在别的里程碑做，本轮不该因为"打开设置页点保存"就被重置掉。
 */
export function applyForm(current: Settings, form: Settings): Settings {
  return {
    ...current,
    enabled: form.enabled,
    underlineStyle: form.underlineStyle,
    underlineColor: form.underlineColor,
    underlineThickness: form.underlineThickness,
    reflectMeetCount: form.reflectMeetCount,
    blacklist: form.blacklist,
    trigger: form.trigger,
    minWordLength: form.minWordLength,
    autoAddOnSelect: form.autoAddOnSelect,
    speechRate: form.speechRate,
    translation: {
      ...current.translation,
      engine: form.translation.engine,
      targetLang: form.translation.targetLang,
      llm: form.translation.llm,
      api: form.translation.api,
      limits: form.translation.limits,
    },
    webdav: form.webdav,
    ui: { ...current.ui, language: form.ui.language, theme: form.ui.theme, pageSize: form.ui.pageSize },
  };
}
