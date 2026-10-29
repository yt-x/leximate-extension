/**
 * 设置 → 标注主题的桥接（PLAN.md FR-A11、FR-A14）。
 *
 * 存在的理由：`Settings` 是**面向用户与设置页**的形态（`underlineStyle`、
 * `underlineColor`、`underlineThickness`、`reflectMeetCount`、`enabled`），
 * 而 `HighlightTheme` 是**面向渲染**的形态。两者字段几乎一一对应，
 * 但直接让渲染层吃 `Settings` 会把"用户的设置"与"画下划线需要的东西"绑死——
 * 设置页加一个与渲染无关的字段，渲染层就要跟着动。
 *
 * 这一层还承担**校验**：设置存在 storage 里，可能被手改、被旧版本写坏
 * （比如线宽写成 `-5` 或 `"abc"`）。渲染前必须挡掉，否则页面会拿到非法 CSS。
 */
import type { Settings, UnderlineStyle } from '../db/types';
import type { HighlightTheme } from './highlight-plan';

const VALID_STYLES: readonly UnderlineStyle[] = ['dotted', 'solid', 'wavy', 'none'];

/** 线宽上下限。上限不是技术限制，是防止用户填个 `100px` 把页面糊掉 */
export const MIN_THICKNESS = 1;
export const MAX_THICKNESS = 4;

/** 颜色必须是 `#rgb` / `#rrggbb`；其它一律退回默认 */
const HEX_COLOR = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

export const FALLBACK_COLOR = '#d98b2b';

function safeStyle(value: unknown): UnderlineStyle {
  return VALID_STYLES.includes(value as UnderlineStyle) ? (value as UnderlineStyle) : 'dotted';
}

function safeThickness(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return MIN_THICKNESS;
  return Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, Math.round(n * 100) / 100));
}

function safeColor(value: unknown): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : FALLBACK_COLOR;
}

/** 把用户设置转成渲染主题（FR-A11） */
export function themeFromSettings(settings: Pick<
  Settings,
  'underlineStyle' | 'underlineColor' | 'underlineThickness' | 'reflectMeetCount'
>): HighlightTheme {
  return {
    style: safeStyle(settings.underlineStyle),
    color: safeColor(settings.underlineColor),
    thickness: safeThickness(settings.underlineThickness),
    reflectMeetCount: settings.reflectMeetCount === true,
  };
}

/**
 * 内容脚本要不要在这个站点干活（FR-A13 + FR-A14）。
 *
 * 两个条件都要满足：全局开关打开，且当前主机名不在黑名单里。
 * 合成一个函数是因为**调用方只关心"干不干"**——分开判会让两处判断散落在注入逻辑里，
 * 而这两条恰好都是"宁可漏标不可误伤"的语义。
 */
export function shouldRunOn(
  settings: Pick<Settings, 'enabled' | 'blacklist'>,
  hostname: string,
  isBlacklisted: (hostname: string, rules: string[]) => boolean,
): boolean {
  if (settings.enabled === false) return false;
  return !isBlacklisted(hostname, settings.blacklist ?? []);
}

export interface SettingsChangePlan {
  /**
   * FR-I2：新语速。**无论开关怎么变都要带上**——
   * 否则"先关掉扩展、改语速、再打开"之后，第一次发音还用旧语速。
   */
  speechRate: number;
  /** 原本在跑、现在不该跑 → 停 */
  stop: boolean;
  /** 原本没跑、现在该跑 → 起 */
  start: boolean;
}

/**
 * 收到后台的 `settings-changed` 后要做什么（FR-A14 的开关联动 + FR-I2 的语速）。
 *
 * 为什么把它抽成纯函数：这段分支住在 `entrypoints/content.ts` 的
 * 消息监听里，而入口模块**没有单测**（它是副作用模块，import 就会注册内容脚本）。
 * 于是"设置改了到底做了什么"这件事只能靠读码确认——而这一族缺陷
 * （接线看起来合理、不报错、只是永远不触发）恰恰是读码最难发现的
 * （`CONSTRAINTS.md` 第 13、27 条）。抽出来之后，四种开关组合都能断言。
 */
export function planSettingsChange(
  running: boolean,
  next: Pick<Settings, 'enabled' | 'speechRate'>,
  allowedOnSite: boolean = next.enabled === true,
): SettingsChangePlan {
  const shouldRun = next.enabled === true && allowedOnSite;
  return {
    speechRate: next.speechRate,
    stop: running && !shouldRun,
    start: !running && shouldRun,
  };
}
