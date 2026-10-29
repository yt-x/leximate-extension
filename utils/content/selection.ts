/**
 * 选区取文本与"是否在不该触发的区域"（PLAN.md FR-A3、FR-A4）。
 *
 * 这一层**不直接摸全局 `document` / `window`**——所有需要 DOM 的能力都由调用方注入。
 * 这样它在 Node 里可以逐条单测（FR-A3 的跨节点归一、FR-A4 的区域清单都要求可验），
 * 在浏览器里则传入真实的选区与节点。
 *
 * 分工：本模块只负责"把选区变成一段干净的候选文本"和"这个位置该不该管"。
 * 文本**算不算一个词**是 `word.ts` 的事。
 */
import { BLOCKED_TAGS } from './blocked-tags';

/** 保留对外的导出名（既有测试与调用方从本模块取它） */
export { BLOCKED_TAGS };

/** 从选区取文本所需的最小能力——注入而非直接调用 `window.getSelection()` */
export interface SelectionLike {
  /** 选区是否为空（无 Range） */
  isCollapsed: boolean;
  /** `range.toString()` 的结果 */
  text: string;
  /** 用来判断触发区域的那个起始节点 */
  anchorNode: Node | null;
  /**
   * 选区起点**前一个字符**（取不到就是空串）。用于 FR-A16 的「完整性」判定：
   * 前面还有词字符就说明选区切在词中间。
   */
  before?: string;
  /** 选区终点**后一个字符** */
  after?: string;
}

/**
 * 从节点向上找最近的、需要排除的祖先（FR-A4）。
 *
 * 规格口径：`input` / `textarea` / `select` / `script` / `style` / `code` / `pre`，
 * 以及任何 `isContentEditable === true` 的祖先。
 *
 * 清单本体在 `blocked-tags.ts`——标注扫描（`controller.ts`）引用同一份，
 * 避免两处各写一份后悄悄分叉。
 */
/** 节点上我们关心的那点能力，避免在测试里造整个 DOM */
export interface NodeLike {
  nodeType: number;
  nodeName: string;
  parentElement: NodeLike | null;
  isContentEditable?: boolean;
  /** 元素节点才有；文本节点为 null */
  closest?: ((selector: string) => NodeLike | null) | null;
}

/**
 * 该不该在这个节点上触发（FR-A4）。
 *
 * 从起始节点一路向上找，命中排除标签或 contenteditable 就返回 `true`（= 该忽略）。
 *
 * 用 `parentElement` 手工走链而**不是**只依赖 `closest()`：
 * 起始节点常常是文本节点，文本节点没有 `closest`，必须先上溯到元素。
 * 手工走链也让这个函数在 Node 里能被完整测到。
 */
export function isInIgnoredRegion(node: NodeLike | null): boolean {
  let current: NodeLike | null = node;
  while (current) {
    if (current.nodeType === 1) {
      const name = current.nodeName.toUpperCase();
      if ((BLOCKED_TAGS as readonly string[]).includes(name)) return true;
      if (current.isContentEditable === true) return true;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * 把选区文本归一成候选文本（FR-A3）。
 *
 * 规格口径：「用 `range.toString()` 取文本；跨换行时把 `\n`（含 `<br>` 产生的）
 * **归一为单个空格**再判定。归一化只影响判定与 `surface` 的取值，不修改页面。」
 *
 * ⚠️ **规格原文对 `<br>` 的说法是错的**，实现按真实行为来。DOM 规范的 stringify 算法：
 *
 * > `For each node in range, in tree order: If node is not a Text or CDATA Section node,
 * > then continue. Append node's data to s.`
 *
 * `<br>` 是 Element，因此**贡献 0 个字符**（不是换行）——`foo<br>bar` 得到 `foobar`。
 * 块级边界同理（`<p>foo</p><p>bar</p>` 也是 `foobar`）。
 * 而 `innerText` 恰好相反（它把 `<br>` 映射成 `\n`），两个标准 API 对同一 DOM 给出不同结果。
 * 见 `docs/reference/selection-and-range.md` §5.1。
 *
 * **这对本模块意味着什么**：`\n` 仍然要处理（`toString()` 可以正常包含文本节点里的真换行，
 * 而且某些选区路径确实会带出 `\n`），但**不能假定 `<br>` 一定产生分隔符**。
 * 真正危险的是反过来的情况：两个词被 `<br>` 或块边界隔开时 `toString()` 会给
 * `wellknown` 这样一个**粘在一起的串**。因此判定层（`word.ts`）必须能处理——
 * 好在它本来就会把这种超长游程判为超限或非法，而不会误当成一个词去查。
 *
 * 除 `\n` 外还要处理两类真实噪声：
 * - **不换行空格 `\u00A0`**：网页上极常见（`&nbsp;`），它不是 `\s` 之外的普通空格，
 *   不处理会让 `run\u00A0` 判定失败
 * - **零宽字符**（`\u200B` 等）：排版用的隐形字符，混进词里会让查表落空
 *
 * 多段连续空白压成一个，首尾 trim。
 */
export function normalizeSelectionText(raw: string): string {
  return raw
    // 零宽字符直接删掉（它们不占视觉位置，留着只会污染查表键）
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // 各类空白（含不换行空格）压成单个普通空格
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
    .trim();
}

/** 取一次选区的结果 */
export interface SelectionCapture {
  /** 归一后的候选文本；没选到东西时是空串 */
  text: string;
  /** 是否落在不该触发的区域（FR-A4） */
  ignored: boolean;
  /** 选区起点前一个字符（不完整选择判定用，见 FR-A16 的「完整性」行） */
  before: string;
  /** 选区终点后一个字符 */
  after: string;
}

/**
 * 把一次选区读成可判定的输入。
 *
 * 顺序有意：**先判区域，再取文本**。在输入框里选中一段文字时，
 * `range.toString()` 也能拿到东西，但它不该触发——先判区域能省掉后面的全部工作。
 *
 * ⚠️ `before` / `after` 与 `text` **同源**（都来自同一个 Range），
 * 不能事后另取一次选区——那时的选区可能已经被用户改掉了。
 */
export function captureSelection(selection: SelectionLike | null): SelectionCapture {
  if (!selection || selection.isCollapsed) {
    return { text: '', ignored: false, before: '', after: '' };
  }

  const ignored = isInIgnoredRegion(selection.anchorNode as NodeLike | null);
  if (ignored) return { text: '', ignored: true, before: '', after: '' };

  return {
    text: normalizeSelectionText(selection.text),
    ignored: false,
    before: selection.before ?? '',
    after: selection.after ?? '',
  };
}
