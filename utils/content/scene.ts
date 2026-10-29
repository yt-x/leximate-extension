/**
 * 从真实 DOM 选区捕获例句（PLAN.md FR-C1 / FR-C4）。
 *
 * 与 `selection.ts` 同一口径：这一层**不直接摸全局 `window` / `document`**，
 * 需要的能力全部由调用方传入。于是"块级容器上溯"与"跨节点偏移"这两件最容易写错的事
 * 都能在 jsdom 里逐条验证。
 *
 * 捕获失败一律返回 `null`（没有例句是正常结果，不是错误）：划词主链路
 * （查词、弹窗、收藏）不该因为切句失败而受影响。
 */
import { extractSentence, type SentenceCapture } from './sentence';
import type { SceneCapture } from './word-state-shared';

/** 块级容器最多上溯几层 */
export const MAX_WALK_UP = 8;
/** 容器文本超过这个长度就退化为"选区所在节点的父元素" */
export const MAX_BLOCK_CHARS = 20000;

export interface SceneSource {
  /** `location.href` */
  url: string;
  /** `document.title` */
  title: string;
}

/**
 * 选区所在的块级容器。
 *
 * 判据取 `display !== 'inline'` 而**不是标签白名单**：站点用
 * `<span style="display:block">` 布局太常见，按标签名找会一路退到 `<body>`，
 * 把整个页面当成"一句话"。
 *
 * `display` 拿不到（`defaultView` 缺失、元素已脱离文档）时继续上溯，
 * 最坏情况退回起始节点自身——**宁可切得短，也不要把整页当例句**。
 */
export function sentenceContainer(range: Range, doc: Document): Element | null {
  const anchor = range.startContainer;
  let current: Element | null = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
  let fallback: Element | null = current;
  const view = doc.defaultView;

  for (let depth = 0; current !== null && depth < MAX_WALK_UP; depth += 1) {
    fallback = current;
    const display = view ? view.getComputedStyle(current).display : '';
    if (display !== '' && display !== 'inline') return current;
    current = current.parentElement;
  }

  return fallback;
}

/**
 * 与 `utils/db/words.ts::domainOf` 同一口径。
 *
 * 内容脚本**不能**引后台模块（会把 IndexedDB 代码带进内容脚本包，见
 * `decisions/0012`），所以这里就地实现；`scene.test.ts` 里有一条用例
 * 拿两者对同一批 URL 比对，防止两处算法漂移。
 */
export function displayDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 某个节点位置在容器文本里的字符偏移；算不出来返回 `null` */
function offsetIn(container: Element, node: Node, offset: number, doc: Document): number | null {
  try {
    const range = doc.createRange();
    range.setStart(container, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

/**
 * 捕获"这次划词所在的那句话"。
 *
 * 偏移用 `Range.toString()` 的长度算，容器文本用 `textContent`：
 * 两者都只数 Text 节点，因此下标是同一套坐标系（`<br>` 与块级边界在两边都贡献 0 个字符，
 * 依据见 `docs/reference/selection-and-range.md` §5.1）。
 */
export function captureScene(
  selection: Selection | null | undefined,
  doc: Document,
  source: SceneSource,
): SceneCapture | null {
  try {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

    const range = selection.getRangeAt(0);
    let container: Element | null = sentenceContainer(range, doc);
    if (container === null) return null;

    let blockText = container.textContent ?? '';
    if (blockText.length > MAX_BLOCK_CHARS) {
      const anchor = range.startContainer;
      const parent = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
      if (parent === null) return null;
      container = parent;
      blockText = parent.textContent ?? '';
    }

    const start = offsetIn(container, range.startContainer, range.startOffset, doc);
    const end = offsetIn(container, range.endContainer, range.endOffset, doc);
    if (start === null || end === null) return null;

    const sentence: SentenceCapture | null = extractSentence(blockText, start, end);
    if (sentence === null) return null;

    return {
      text: sentence.text,
      highlightFrom: sentence.highlightFrom,
      highlightTo: sentence.highlightTo,
      sourceUrl: source.url,
      sourceTitle: source.title,
    };
  } catch {
    return null;
  }
}
