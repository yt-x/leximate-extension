/**
 * 标注决策与样式（PLAN.md FR-A9、FR-A10、FR-A11、FR-A14）。
 *
 * 这层回答三个问题，**都不碰 DOM**：
 * 1. 这个词该不该标？（FR-A10：只标 `status = new`；FR-A14：全局开关关了就都不标）
 * 2. 该用什么样式？（FR-A11：颜色/线型/粗细/是否按遇见次数变化）
 * 3. 一次标注任务要注册哪些 highlight？（把词按样式分组）
 *
 * 为什么不直接生成 `Highlight` 对象：那需要真实的 `Range`/`Highlight` 构造器，
 * 在 Node 里没法测。这里产出**样式描述 + 词列表**，由 `highlight.ts` 落成真实对象。
 */
import type { UnderlineStyle, WordStatus } from '../db/types';
import type { WordSpan } from './scan';

/** 下划线样式（来自设置的子集，只保留渲染需要的字段） */
export interface HighlightTheme {
  style: UnderlineStyle;
  color: string;
  /** 线宽，px */
  thickness: number;
  /** 是否按遇见次数改变表现（FR-A11 / R3） */
  reflectMeetCount: boolean;
}

/** 一次标注的输入：一个待标注的词 */
export interface AnnotateCandidate {
  span: WordSpan;
  /**
   * 词的状态。**`undefined` 表示状态未知**——那个词不在生词本里，
   * 与"是生词"是两回事（FR-A9 只标注**本地生词**）。
   */
  status: WordStatus | undefined;
  meetCount: number;
}

/**
 * 该不该标注这个词（FR-A10）。
 *
 * 规格：**只标注 `status = new` 的词；已掌握 / 忽略不标注。**
 * 这条是"下划线提醒"的全部意义所在——用户已经掌握的词不该继续打扰他。
 *
 * ⚠️ **状态未知（`undefined`）不标注**：页面上大多数词都不在生词本里，
 * 把"查不到状态"当成"是生词"会让整页都被画上下划线。旧实现就是这么错的
 * （`UNSEEN = {status:'new'}`），后果是"下划线该什么时候出现"完全失去意义。
 */
export function shouldAnnotate(status: WordStatus | undefined): boolean {
  return status === 'new';
}

/**
 * 遇见次数 → 线宽倍数（FR-A11 / R3）。
 *
 * 规格把"什么算一次遇见"（FR-A17）与"怎么呈现"分开，这里只做呈现。
 *
 * **为什么必须分档而不能叠加**：调研（`docs/reference/css-custom-highlight.md` §2.3.2）
 * 确认了 CSS 的硬限制——`text-decoration` 在一个元素上是**一个复合值**，
 * **根本无法在同一段文字上叠加两条不同样式的下划线**；同一 Highlight 注册到两个名字
 * 会画两遍且**叠加顺序不可控**。所以次数只能编码成
 * **离散档位 → 各自独立的 highlight 名字 → 每组一条 CSS 规则**。
 *
 * 在可选维度里选**粗细**，是因为它最不干扰阅读（颜色深浅在浅色主题下容易看不清，
 * 线型变化太跳）。分档而非连续：连续映射会让相邻次数几乎看不出差别，
 * 而用户要的是"这词我见过很多次了"这个**粗粒度**信号。
 *
 * ⚠️ 调研同时指出：`text-decoration-thickness` 是**全篇最不确定的一项**——
 * 规范白名单的括号里只点名了 `text-underline-position` / `-offset`，没点 thickness，
 * 且 WebKit 有明确 bug。**因此这一项必须在真机确认**；不生效时按 FR-A11
 * 禁用该设置项并写明，不得静默失效。
 */
export function meetCountTier(meetCount: number): 1 | 2 | 3 | 4 | 5 {
  if (meetCount <= 1) return 1;
  if (meetCount === 2) return 2;
  if (meetCount === 3) return 3;
  if (meetCount === 4) return 4;
  return 5;
}

/** 每档在基础线宽上乘的倍数 */
const TIER_SCALE: Record<number, number> = { 1: 1, 2: 1.4, 3: 1.8, 4: 2.2, 5: 2.6 };

/**
 * 造 CSS 声明串（FR-A11）。
 *
 * 输出的是 `::highlight(name) { ... }` 里那一串声明，不是完整规则——
 * 名字由 `highlight.ts` 按分组决定。
 *
 * **用四个长属性而不是 `text-decoration` 简写**：简写的取值顺序
 * （`<line> || <style> || <color> || <thickness>` 是否严格有序）在调研中**未能核实**，
 * 而长属性没有顺序歧义，且规范自己的示例用的就是长属性
 * （见 `docs/reference/css-custom-highlight.md` §2.3.3 第 3 条）。
 *
 * `none` 线型时**不写任何声明**：设置成 `none` 是"关闭标注"的意思，
 * 写成 `text-decoration-line: none` 会让本已存在的下划线被清除，语义反了。
 */
export function highlightDeclarations(theme: HighlightTheme, meetCount = 1): string {
  if (theme.style === 'none') return '';

  const width = theme.reflectMeetCount
    ? Math.round(theme.thickness * (TIER_SCALE[meetCountTier(meetCount)] ?? 1) * 100) / 100
    : theme.thickness;

  // 长属性，顺序无关；`text-decoration-skip-ink` 保持默认以免破坏连字
  return [
    'text-decoration-line: underline',
    `text-decoration-style: ${theme.style}`,
    `text-decoration-color: ${theme.color}`,
    `text-decoration-thickness: ${width}px`,
  ].join('; ');
}

/**
 * 把候选词按"渲染样式"分组（FR-A11 / FR-A12 的性能要求）。
 *
 * 为什么要分组：`CSS.highlights` 的一个注册项对应**一个** `Highlight` 对象，
 * 而一个 `Highlight` 可以装任意多个 `Range`。同一组里塞一千个 Range 只在
 * 注册表里占一个条目——这比"一个词注册一次"在样式计算上便宜得多。
 *
 * 不按次数分组时（`reflectMeetCount === false`）全部合成一组，这是最常见的配置。
 * 按次数分组时最多 5 组（分档只有 5 档）。
 *
 * 返回的组名是稳定的：`leximate-1` … `leximate-5`，便于测试与排查。
 */
export interface HighlightGroup {
  name: string;
  declarations: string;
  spans: WordSpan[];
}

export function groupForHighlight(
  candidates: AnnotateCandidate[],
  theme: HighlightTheme,
  enabled = true,
): HighlightGroup[] {
  // FR-A14：全局开关关闭时不标注任何词
  if (!enabled) return [];
  if (theme.style === 'none') return [];

  const groups = new Map<number, WordSpan[]>();

  for (const candidate of candidates) {
    // FR-A10：只标生词
    if (!shouldAnnotate(candidate.status)) continue;
    const tier = theme.reflectMeetCount ? meetCountTier(candidate.meetCount) : 1;
    const bucket = groups.get(tier);
    if (bucket) bucket.push(candidate.span);
    else groups.set(tier, [candidate.span]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tier, spans]) => ({
      name: `leximate-${tier}`,
      declarations: highlightDeclarations(theme, tier),
      spans,
    }));
}

/** 默认主题，与 `DEFAULT_SETTINGS` 保持一致 */
export const DEFAULT_THEME: HighlightTheme = {
  style: 'dotted',
  color: '#d98b2b',
  thickness: 1,
  reflectMeetCount: false,
};
