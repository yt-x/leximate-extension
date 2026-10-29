/**
 * 弹窗渲染与隔离（PLAN.md FR-A7、FR-A8）。
 *
 * FR-A8 的验收：**不改变宿主页面任何样式**。做法是
 * Shadow DOM（`mode: 'closed'`）+ `adoptedStyleSheets`，
 * **不向页面注入任何全局 CSS**——样式表的宿主是我们的 shadow root，不是 document。
 *
 * 这里刻意不引入任何 UI 框架：内容脚本每注入一次就要付框架的体积与启动成本，
 * 而弹窗只有一个，用原生 DOM 更快也更省
 * （FR-A1 的 100ms 预算里，这一层不该是瓶颈）。
 */
import { visibleActions, type CardAction, type CardModel } from './card';
import { MARGIN, type PopupPosition, type PopupSize, type Rect, positionPopup } from './position';

/** 弹窗对外暴露的能力 */
export interface Popup {
  /** 显示卡片；返回后弹窗已挂载 */
  show(card: CardModel, anchor: Rect): void;
  /**
   * 就地重绘卡片（FR-A6：状态变更后**不关闭弹窗**，主按钮文案就地切换）。
   *
   * 与 `show` 的区别是**不重新定位**：位置只跟锚点有关，状态变更不该让卡片跳走。
   */
  update(card: CardModel): void;
  hide(): void;
  /** 当前是否可见 */
  isVisible(): boolean;
  /** 销毁并摘除宿主节点 */
  destroy(): void;
  /** 操作按钮被点击时的回调；由调用方注入业务逻辑 */
  setActionHandler(handler: (action: CardAction, card: CardModel) => void): void;
  /**
   * 事件是否发生在弹窗内部（FR-A7 的"点击**外部**才关闭"）。
   *
   * 单独开一个方法而不是把宿主节点暴露出去，是因为 shadow root 是 `closed` 的：
   * 外部只该拿到"在不在里面"这个布尔结论，拿不到内部结构（FR-A8）。
   *
   * ⚠️ 为什么不能拿 `composedPath()` 里的节点去比 `Popup` 对象本身——
   * 弹窗内部的 mousedown 冒泡到 `document` 时，目标会被**重定向为宿主节点**，
   * 路径里出现的是宿主 DOM，而 `Popup` 是个 JS 门面对象，两者永不相等。
   * 用那个判据的后果是"点按钮 = 点外部"，见 `controller.ts` 的 `onMouseDown`。
   */
  containsEvent(event: unknown): boolean;
}

/**
 * 弹窗样式。
 *
 * 挂在 shadow root 上，因此**不会泄漏到页面**，也不需要 `!important` 去压页面样式
 * （这正是 FR-A8 选 Shadow DOM 的理由）。
 *
 * 用 `all: initial` 起手：页面可能有 `* { font-family: ... }` 之类的规则，
 * 而 shadow DOM **不能**完全挡住继承属性（`font` / `color` 等会继承进来）。
 * `all: initial` 把这些继承值清掉，保证外观由我们自己决定。
 */
const POPUP_CSS = `
:host {
  all: initial;
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2147483647;
  contain: layout style;
}
.card {
  all: initial;
  display: block;
  box-sizing: border-box;
  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #1f2328;
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
  padding: 10px 12px;
  max-height: 60vh;
  overflow: auto;
}
.head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.word { font-size: 17px; font-weight: 600; }
.lemma { font-size: 12px; color: #57606a; }
.phonetic { font: 12px/1.4 ui-monospace, Consolas, monospace; color: #57606a; }
.hint { font-size: 12px; color: #9a6700; }
.senses { margin: 8px 0 0; padding: 0; list-style: none; }
.senses li { margin: 2px 0; }
.pos { color: #8250df; margin-right: 4px; }
.meta { margin-top: 8px; font-size: 12px; color: #57606a; display: flex; gap: 10px; flex-wrap: wrap; }
.examples { margin: 8px 0 0; padding: 0; list-style: none; border-top: 1px solid #eaeef2; padding-top: 6px; }
.examples li { font-size: 12px; color: #57606a; margin: 3px 0; }
.examples .src { color: #8c959f; }
.unlisted { font-size: 12px; color: #9a6700; margin-top: 6px; }
.unlisted-hint { font-size: 11px; color: #8a8a8a; margin-top: 2px; }
.actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.actions button {
  font: inherit;
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #f6f8fa;
  color: #1f2328;
  cursor: pointer;
}
.actions button:hover { background: #eaeef2; }
`;

/** 按钮文案（FR-A6 的操作） */
const ACTION_LABEL: Record<CardAction, string> = {
  collect: '加入生词本',
  'mark-known': '已掌握',
  'mark-new': '改回生词',
  ignore: '忽略',
  speak: '发音',
  'copy-definition': '复制释义',
  'open-manager': '管理台',
  'llm-define': 'LLM 释义',
};

/** 首次遇见日期的显示形态 */
function formatDate(at: number | null): string {
  if (at === null) return '';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 建一个弹窗。
 *
 * 宿主节点用**固定 id**，重复注入时先移除旧的——扩展被重新加载、或页面里
 * 意外注入两次时，不至于留下两个弹窗。
 *
 * `shadowMode` 是**唯一为单测开的口子**：生产必须用默认的 `closed`
 * （FR-A8：页面脚本拿不到我们的 shadow root），而 `closed` 的渲染结果
 * 从外部读不到，单测就没法断言按钮集合。默认值就是生产行为。
 */
export function createPopup(
  doc: Document = document,
  options: { shadowMode?: 'open' | 'closed' } = {},
): Popup {
  const HOST_ID = 'leximate-popup-host';
  const shadowMode = options.shadowMode ?? 'closed';

  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let cardEl: HTMLElement | null = null;
  let current: CardModel | null = null;
  let handler: ((action: CardAction, card: CardModel) => void) | null = null;
  let sheet: CSSStyleSheet | null = null;

  function ensureMounted(): ShadowRoot {
    // 已有宿主就复用；页面里若有残留（reload 后）先清掉
    const existing = doc.getElementById(HOST_ID);
    if (existing) existing.remove();

    host = doc.createElement('div');
    host.id = HOST_ID;
    // closed：页面脚本拿不到我们的 shadow root，无法干扰内部结构（FR-A8）
    root = host.attachShadow({ mode: shadowMode });

    // adoptedStyleSheets 优先；老实现退回 <style>（两者都不泄漏到页面）
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(POPUP_CSS);
        root.adoptedStyleSheets = [sheet];
      } catch {
        sheet = null;
      }
    }
    if (!sheet) {
      const style = doc.createElement('style');
      style.textContent = POPUP_CSS;
      root.appendChild(style);
    }

    cardEl = doc.createElement('div');
    cardEl.className = 'card';
    root.appendChild(cardEl);

    // 挂到 body；body 不在时退回 documentElement（document_start 注入的情况）
    (doc.body ?? doc.documentElement).appendChild(host);
    return root;
  }

  function render(card: CardModel): void {
    if (!cardEl) return;
    cardEl.textContent = '';

    const head = doc.createElement('div');
    head.className = 'head';

    const word = doc.createElement('span');
    word.className = 'word';
    word.textContent = card.head.surface;
    head.appendChild(word);

    // 还原过时把原形也显示出来，否则用户会困惑"我划的不是这个"
    if (card.head.lemma !== card.head.surface) {
      const lemma = doc.createElement('span');
      lemma.className = 'lemma';
      lemma.textContent = card.head.lemma;
      head.appendChild(lemma);
    }

    if (card.head.phoneticUs) {
      const ph = doc.createElement('span');
      ph.className = 'phonetic';
      ph.textContent = card.head.phoneticUs;
      head.appendChild(ph);
    }

    if (card.head.inflectionHint) {
      const hint = doc.createElement('span');
      hint.className = 'hint';
      hint.textContent = card.head.inflectionHint;
      head.appendChild(hint);
    }

    cardEl.appendChild(head);

    if (card.unlisted) {
      // FR-B4：明确提示未收录，不静默失败
      const p = doc.createElement('div');
      p.className = 'unlisted';
      p.textContent = '未收录';
      cardEl.appendChild(p);
      // FR-B7：未收录时给一句导入引导（不放进度/按钮——弹窗打不开设置页）
      const hint = doc.createElement('div');
      hint.className = 'unlisted-hint';
      hint.textContent = '可在设置页导入完整词库（ECDICT）后查到';
      cardEl.appendChild(hint);
    }

    // 未收录词经用户显式点击生成释义后，也在当前卡片就地展示。
    if (card.senses && card.senses.length > 0) {
      const ul = doc.createElement('ul');
      ul.className = 'senses';
      for (const sense of card.senses) {
        const li = doc.createElement('li');
        if (sense.pos) {
          const pos = doc.createElement('span');
          pos.className = 'pos';
          pos.textContent = sense.pos;
          li.appendChild(pos);
        }
        li.appendChild(doc.createTextNode(sense.defZh.filter((d) => d !== '').join('；')));
        ul.appendChild(li);
      }
      cardEl.appendChild(ul);
    }

    if (card.definitionError) {
      const error = doc.createElement('div');
      error.className = 'unlisted-hint';
      error.textContent = `LLM 释义失败：${card.definitionError}`;
      cardEl.appendChild(error);
    }

    // 段三：标签、词频、遇见次数、首次日期
    const meta = doc.createElement('div');
    meta.className = 'meta';
    const parts: string[] = [];
    if (!card.meta.inBook) {
      // FR-A5 ④段：**未加入生词本时显示"尚未加入生词本"**。
      // 默认是手动收藏（划词不写库），所以这一段必须说清楚"还没进去"，
      // 否则用户会以为它已经进了生词本（实测反馈过）。
      parts.push('尚未加入生词本');
    } else if (card.meta.meetCount > 0) {
      parts.push(`遇见 ${card.meta.meetCount} 次`);
    } else {
      // 已加入但次数还没回写
      parts.push('首次记录');
    }
    const first = formatDate(card.meta.firstSeenAt);
    if (first) parts.push(`首次 ${first}`);
    if (card.meta.rank !== null) parts.push(`词频 #${card.meta.rank}`);
    for (const tag of card.meta.tags) parts.push(tag);
    if (parts.length > 0) {
      meta.textContent = parts.join(' · ');
      cardEl.appendChild(meta);
    }

    if (card.examples.length > 0) {
      const ul = doc.createElement('ul');
      ul.className = 'examples';
      for (const ex of card.examples) {
        const li = doc.createElement('li');
        li.appendChild(doc.createTextNode(ex.text));
        if (ex.source) {
          const src = doc.createElement('span');
          src.className = 'src';
          src.textContent = ` — ${ex.source}`;
          li.appendChild(src);
        }
        ul.appendChild(li);
      }
      cardEl.appendChild(ul);
    }

    const actions = doc.createElement('div');
    actions.className = 'actions';
    // FR-A6：主按钮按"是否已加入 / 当前状态"三选一，不是把动作全画出来（见 `visibleActions`）
    for (const action of visibleActions(
      { inBook: card.meta.inBook, status: card.meta.status, unlisted: card.unlisted },
      card.canSpeak,
    )) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = action === 'llm-define' && card.defining ? '生成中…' : ACTION_LABEL[action];
      btn.dataset.action = action;
      if (action === 'llm-define' && card.defining) btn.disabled = true;
      // 主操作给一个视觉区分：规格要求"单一主按钮"，全同权重等于没有主次
      if (action === 'collect' || action === 'mark-known' || action === 'mark-new') {
        btn.className = 'primary';
      }
      btn.addEventListener('click', (event) => {
        // 不让点击穿透到页面：否则可能触发页面的链接或折叠（FR-A7 的要求）
        event.preventDefault();
        event.stopPropagation();
        if (current) handler?.(action, current);
      });
      actions.appendChild(btn);
    }
    cardEl.appendChild(actions);
  }

  /** 把弹窗放到锚点附近（FR-A1 的定位约束全在 position.ts 里） */
  function place(anchor: Rect): void {
    if (!host || !cardEl) return;

    // 先量真实尺寸再定位：内容长短决定高度，不能用预设值
    const measured = cardEl.getBoundingClientRect();
    const size: PopupSize = { width: measured.width, height: measured.height };

    const position: PopupPosition = positionPopup(anchor, size, {
      width: doc.documentElement.clientWidth || window.innerWidth,
      height: doc.documentElement.clientHeight || window.innerHeight,
    });

    // 用页面坐标（absolute + 滚动偏移），这样滚动时能跟随
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    host.style.left = `${position.left + scrollX}px`;
    host.style.top = `${position.top + scrollY}px`;
  }

  return {
    show(card, anchor) {
      ensureMounted();
      current = card;
      render(card);
      place(anchor);
    },

    update(card) {
      // 未挂载时不重绘：没有弹窗就没有"就地更新"这回事
      if (!host || !cardEl) return;
      current = card;
      render(card);
    },

    hide() {
      if (host) host.style.display = 'none';
      current = null;
    },

    isVisible() {
      return host !== null && host.style.display !== 'none';
    },

    destroy() {
      host?.remove();
      host = null;
      root = null;
      cardEl = null;
      sheet = null;
      current = null;
    },

    setActionHandler(next) {
      handler = next;
    },

    containsEvent(event) {
      if (!host) return false;

      // 首选 composedPath：closed shadow root 里的事件在这里会被重定向为宿主节点，
      // 因此"路径里有没有宿主"就是"在不在弹窗内"的准确判据。
      const path = (event as { composedPath?: () => unknown[] } | null)?.composedPath?.();
      if (Array.isArray(path)) return path.includes(host);

      // 没有 composedPath 的实现（老浏览器 / 简化的事件对象）退回目标包含判断：
      // 重定向后 target 就是宿主，因此 `host.contains(target)` 依然成立。
      const target = (event as { target?: unknown } | null)?.target;
      if (target === host) return true;
      return target instanceof Node && host.contains(target);
    },
  };
}

/** 供测试与诊断：样式表内容（不导出到页面，仅本模块内可见） */
export const popupCssForTest = POPUP_CSS;
export { MARGIN };
