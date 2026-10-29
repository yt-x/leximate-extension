/**
 * 下划线标注（PLAN.md FR-A9、FR-A10、FR-A11、FR-A14）。
 *
 * 机制与边界见 `docs/reference/css-custom-highlight.md` §2：用 CSS Custom Highlight API
 * （Chrome 105+），**不修改页面 DOM**——Range 是 DOM 之外的边界点集合，效果发生在绘制阶段。
 *
 * 本模块是"真实浏览器 API"的那一层：`CSS.highlights`、`Range`、`Highlight`。
 * 决策与样式串的计算在 `highlight-plan.ts`（纯逻辑，可单测）。
 *
 * 降级规则（规格写死）：`CSS.highlights` 不可用时**不标注、不报错**，
 * **禁止**退回包裹 `<span>` 的方案——那会直接违反 FR-A9 的硬约束。
 */

import {
  DEFAULT_THEME,
  groupForHighlight,
  type AnnotateCandidate,
  type HighlightTheme,
} from './highlight-plan';
import type { WordSpan } from './scan';

/** 浏览器高亮能力的抽象，便于在测试里注入假实现 */
export interface HighlightEnv {
  /** `CSS.highlights` 这一注册表；不可用时为 undefined */
  registry: { set(name: string, highlight: unknown): void; delete(name: string): boolean } | undefined;
  /** 造一个 Range，覆盖 `[from, to)` 的字符 */
  createRange(node: Node, from: number, to: number): { range: unknown } | null;
  /** 造一个 Highlight 对象 */
  createHighlight(ranges: unknown[]): unknown;
  /**
   * 往一个**已注册**的 Highlight 里加 Range（FR-A12 的增量路径）。
   *
   * `Highlight` 是 Setlike 的活对象，因此增量标注不需要重建注册项——
   * 重建会丢掉别的节点上已经画好的下划线，这正是"下划线完全不渲染"的根因。
   */
  addRanges(highlight: unknown, ranges: unknown[]): void;
  /** 从一个已注册的 Highlight 里移除 Range */
  removeRanges(highlight: unknown, ranges: unknown[]): void;
  /** 往文档里插一条 `::highlight(name)` 样式规则 */
  defineStyle(name: string, declarations: string): void;
  /** 删除一条样式规则（**只删这一条**，不能把别的组一起清掉） */
  removeStyle(name: string): void;
  /** 诊断日志 */
  log?(event: string, detail?: unknown): void;
}

/** 一次标注的登记结果，用于诊断与测试 */
export interface AnnotationResult {
  /** 本次受影响（被注册/更新）的组名 */
  groups: string[];
  /** 本次实际登记/保留的 Range 条数 */
  ranges: number;
  /** 因为 Range 造不出来而跳过的条数（页面变动导致的失效） */
  skipped: number;
  /** 是否因为 API 不可用而整体跳过 */
  unavailable: boolean;
}

/** 待标注的文本节点 + 它里面的词 */
export interface NodeSpans {
  node: Node;
  spans: WordSpan[];
}

/**
 * 查一个词的**完整状态**（状态 + 遇见次数）。
 *
 * ⚠️ 返回 `undefined` 表示**状态未知**，而未知**不该被标注**：
 * 那意味着这个词不在生词本里。旧实现把未知当成 `{status:'new'}`，
 * 于是页面上每个词库词都会被当成生词画上下划线。
 */
export type StateOf = (
  word: string,
) => { status: AnnotateCandidate['status']; meetCount: number } | null | undefined;

export interface HighlightSession {
  /**
   * 增量标注一批节点（FR-A12）。
   *
   * **只替换传入节点自己的标注**：先摘掉这些节点上一次登记的 Range，
   * 再把新算出来的 Range 并进对应的组。其它节点的标注**一概不动**——
   * 这是"增量"二字的全部含义，也是下划线能在不停变动的页面上活下来的前提。
   */
  annotate(
    nodeSpans: NodeSpans[],
    stateOf?: StateOf,
    theme?: HighlightTheme,
    enabled?: boolean,
  ): AnnotationResult;
  /** 清空**全部自有**标注（全量重扫前、全局开关关闭时） */
  clearAll(): void;
  /** 当前已登记的组名（诊断） */
  groups(): string[];
  /** 当前已登记的节点数（诊断） */
  nodeCount(): number;
}

/**
 * 造一个标注会话。
 *
 * 会话持有三份状态（都是"我们的"，不碰页面）：
 * - `highlights`：组名 → 已注册的 `Highlight` 对象（活对象，可增删 Range）
 * - `declarations`：组名 → 该组的 CSS 声明（用于诊断与去重）
 * - `rangesByNode`：节点 → 组名 → 该节点已登记的 Range
 *
 * `rangesByNode` 是增量语义的关键：没有它就无法"只摘掉这个节点的旧标注"，
 * 只能退化成全局清空重来（旧实现的做法）。
 */
export function createHighlightSession(env: HighlightEnv): HighlightSession {
  const highlights = new Map<string, unknown>();
  const declarations = new Map<string, string>();
  const rangesByNode = new Map<Node, Map<string, unknown[]>>();

  /** 把一个节点已有的 Range 从各组的 Highlight 里摘掉 */
  function detachNode(node: Node): void {
    const groups = rangesByNode.get(node);
    if (!groups) return;
    for (const [name, ranges] of groups) {
      if (ranges.length === 0) continue;
      const highlight = highlights.get(name);
      if (highlight) env.removeRanges(highlight, ranges);
    }
    rangesByNode.delete(node);
  }

  /** 某个组空了就摘掉注册项与样式，避免留下"空组"让诊断数字虚高 */
  function dropEmptyGroups(): void {
    for (const [name] of [...highlights.entries()]) {
      const stillUsed = [...rangesByNode.values()].some(
        (groups) => (groups.get(name)?.length ?? 0) > 0,
      );
      if (stillUsed) continue;
      try {
        env.registry?.delete(name);
      } catch {
        // 名字不存在时某些实现会抛，忽略——清理必须幂等
      }
      env.removeStyle(name);
      highlights.delete(name);
      declarations.delete(name);
    }
  }

  function attach(node: Node, name: string, ranges: unknown[]): void {
    let highlight = highlights.get(name);
    if (highlight) {
      env.addRanges(highlight, ranges);
    } else {
      // 这个组第一次出现：建对象、登记（样式由调用方在此之前写好）
      highlight = env.createHighlight(ranges);
      env.registry?.set(name, highlight);
      highlights.set(name, highlight);
    }

    let groups = rangesByNode.get(node);
    if (!groups) {
      groups = new Map();
      rangesByNode.set(node, groups);
    }
    groups.set(name, [...(groups.get(name) ?? []), ...ranges]);
  }

  return {
    annotate(nodeSpans, stateOf, theme = DEFAULT_THEME, enabled = true) {
      // FR-A9 的降级：不可用就不标注、不报错
      if (!env.registry) {
        env.log?.('highlight-unavailable');
        return { groups: [], ranges: 0, skipped: 0, unavailable: true };
      }

      const lookup: StateOf = stateOf ?? (() => undefined);
      const touched = new Set<string>();
      let rangeCount = 0;
      let skipped = 0;

      for (const entry of nodeSpans) {
        // 1. 摘掉这个节点上一次的标注（只摘它自己的）
        detachNode(entry.node);

        // 2. 算这一批里该标哪些词（未知状态 → status 为 undefined → 被过滤掉）
        const candidates: AnnotateCandidate[] = entry.spans.map((span) => {
          const state = lookup(span.text);
          return {
            span,
            status: state?.status,
            meetCount: state?.meetCount ?? 0,
          };
        });

        const groups = groupForHighlight(candidates, theme, enabled);
        for (const group of groups) {
          const ranges: unknown[] = [];
          for (const span of group.spans) {
            const created = env.createRange(entry.node, span.from, span.to);
            if (!created) {
              // Range 失效（页面改写了文本节点）：丢弃这一条，不影响其余
              // 见 docs/reference/css-custom-highlight.md §2.5
              skipped++;
              continue;
            }
            ranges.push(created.range);
          }
          if (ranges.length === 0) continue;

          // 样式只在这一组第一次出现时写一次；重复写会让 style 元素不断增长
          if (!declarations.has(group.name)) {
            env.defineStyle(group.name, group.declarations);
            declarations.set(group.name, group.declarations);
          }
          attach(entry.node, group.name, ranges);
          touched.add(group.name);
          rangeCount += ranges.length;
        }
      }

      dropEmptyGroups();

      const registered = [...touched].filter((name) => highlights.has(name)).sort();
      env.log?.('highlight-applied', {
        groups: registered.length,
        ranges: rangeCount,
        skipped,
      });
      return { groups: registered, ranges: rangeCount, skipped, unavailable: false };
    },

    clearAll() {
      for (const node of [...rangesByNode.keys()]) detachNode(node);
      for (const name of [...highlights.keys()]) {
        try {
          env.registry?.delete(name);
        } catch {
          // 幂等：不存在时忽略
        }
        env.removeStyle(name);
      }
      highlights.clear();
      declarations.clear();
      rangesByNode.clear();
    },

    groups: () => [...highlights.keys()].sort(),
    nodeCount: () => rangesByNode.size,
  };
}

/**
 * 清除全部标注（FR-A14 的"关闭即清除"）。
 *
 * ⚠️ 这是**整表清理**（用于全局开关关闭、`stop()`）。日常的增量刷新走
 * `createHighlightSession`——那条路径绝不整表清空，否则页面自己一动，
 * 全页下划线就没了（见 `createHighlightSession` 的注释）。
 *
 * `registry.delete()` 之后把样式规则也删掉，避免页面里堆积无用规则。
 * **幂等**：对没注册过的名字调用不报错。
 */
export function clearHighlights(env: HighlightEnv, names: string[]): void {
  if (!env.registry) return;
  for (const name of names) {
    try {
      env.registry.delete(name);
    } catch {
      // 名字不存在时某些实现会抛，忽略——清理必须是幂等的
    }
    env.removeStyle(name);
  }
}

/** 我们注册的组名范围。只清理自己注册的，绝不碰页面自己的 highlight */
export function currentGroupNames(env: HighlightEnv, probe = 5): string[] {
  // 组名只有 `leximate-1` … `leximate-5` 五种可能，直接枚举比遍历整个注册表安全
  const names: string[] = [];
  for (let tier = 1; tier <= probe; tier++) names.push(`leximate-${tier}`);
  return names;
}

/**
 * 用真实浏览器 API 造一个 `HighlightEnv`。
 *
 * 抽出来是为了让标注逻辑能在 Node 里用假环境测——
 * 真实的 `CSS.highlights` / `Range` / `Highlight` 都只在浏览器里存在。
 */
export function createBrowserHighlightEnv(doc: Document = document): HighlightEnv {
  const css = (globalThis as { CSS?: { highlights?: HighlightEnv['registry'] } }).CSS;
  const registry = css?.highlights;
  const styleEl = doc.createElement('style');
  /** 我们自己写的规则；`removeStyle` 只删这一条，不能整表重写（会连别的组一起丢） */
  const rules = new Map<string, string>();
  let attached = false;

  function ensureStyleElement(): void {
    if (!attached) {
      // 挂到 documentElement 而不是 body：body 可能还不存在，也可能被页面替换
      doc.documentElement.appendChild(styleEl);
      attached = true;
    }
  }

  function flushStyles(): void {
    // 整份重写而不是 `+=`：删除某一条时无法"从字符串里减掉一段"
    styleEl.textContent = [...rules.entries()]
      .map(([name, declarations]) => `::highlight(${name}) { ${declarations} }\n`)
      .join('');
  }

  return {
    registry,
    createRange(node, from, to) {
      try {
        const range = doc.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        // 折叠的 Range 不渲染（规范 §4.2.4），直接当作失效丢弃
        if (range.collapsed) return null;
        return { range };
      } catch {
        // 偏移超出节点长度时 setStart/setEnd 会抛 —— 页面变动导致的失效
        return null;
      }
    },
    createHighlight(ranges) {
      const Ctor = (globalThis as { Highlight?: new (...r: unknown[]) => unknown }).Highlight;
      if (!Ctor) throw new Error('Highlight 构造器不可用');
      return new Ctor(...ranges);
    },
    addRanges(highlight, ranges) {
      // `Highlight` 是 Setlike：直接 add 就能让新增的 Range 参与绘制
      const target = highlight as { add(range: unknown): void };
      for (const range of ranges) target.add(range);
    },
    removeRanges(highlight, ranges) {
      const target = highlight as { delete(range: unknown): void };
      for (const range of ranges) target.delete(range);
    },
    defineStyle(name, declarations) {
      if (declarations === '') return;
      ensureStyleElement();
      rules.set(name, declarations);
      flushStyles();
    },
    removeStyle(name) {
      if (!rules.delete(name)) return;
      flushStyles();
    },
  };
}
