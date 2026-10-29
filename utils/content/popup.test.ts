/**
 * 弹窗渲染与"点内部算不算外部"的验收（PLAN.md FR-A6、FR-A7、FR-A8、FR-I3）。
 *
 * @vitest-environment jsdom
 *
 * 这一层是**唯一真的碰 DOM 的地方**（Shadow DOM + adoptedStyleSheets），
 * 所以只有它需要 jsdom。判定逻辑（哪些按钮该出现）在 `card.ts` 的
 * `visibleActions` 里，那份在 node 环境下也测得到。
 *
 * ⚠️ 生产用 `closed` shadow root（FR-A8），从外部读不到渲染结果；
 * 因此这些用例用 `{ shadowMode: 'open' }` 建弹窗，**只为了能断言**，
 * 生产路径的默认值仍是 `closed`（另有专门用例锁住默认值这件事）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { CardModel } from './card';
import { createPopup } from './popup';

function card(patch: Partial<CardModel> = {}, meta: Partial<CardModel['meta']> = {}): CardModel {
  return {
    head: { surface: 'running', lemma: 'run', inflectionHint: '原形 run', phoneticUs: '/rʌn/' },
    senses: [{ pos: 'v.', defZh: ['跑'] }],
    meta: { tags: [], rank: null, meetCount: 2, firstSeenAt: null, status: 'new', inBook: true, ...meta },
    examples: [],
    unlisted: false,
    canSpeak: true,
    ...patch,
  };
}

const anchor = { top: 10, left: 10, width: 40, height: 16 };

function testPopup(doc: Document) {
  return createPopup(doc, { shadowMode: 'open' });
}

function root(doc: Document): ShadowRoot | null {
  return (doc.getElementById('leximate-popup-host')?.shadowRoot as ShadowRoot | null) ?? null;
}

function labels(doc: Document): string[] {
  return [...(root(doc)?.querySelectorAll('button') ?? [])].map((b) => b.textContent ?? '');
}

function textOf(doc: Document): string {
  return root(doc)?.textContent ?? '';
}

function click(doc: Document, label: string): void {
  const btn = [...(root(doc)?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`没有这个按钮：${label}`);
  btn.click();
}

/** 每个用例用独立文档，避免固定宿主 id 相互干扰 */
function freshDoc(): Document {
  return document.implementation.createHTMLDocument('popup-test');
}

describe('FR-A6：按钮集合由状态决定', () => {
  it('status=new 时主按钮是"已掌握"，不出现"改回生词"', () => {
    const doc = freshDoc();
    testPopup(doc).show(card({}, { status: 'new' }), anchor);

    expect(labels(doc)).toContain('已掌握');
    expect(labels(doc)).not.toContain('改回生词');
  });

  it('status=known 时主按钮是"改回生词"，不出现"已掌握"', () => {
    const doc = freshDoc();
    testPopup(doc).show(card({}, { status: 'known' }), anchor);

    expect(labels(doc)).toContain('改回生词');
    expect(labels(doc)).not.toContain('已掌握');
  });

  it('次要操作为 忽略 / 发音 / 复制释义 / 管理台', () => {
    const doc = freshDoc();
    testPopup(doc).show(card(), anchor);

    for (const label of ['忽略', '发音', '复制释义', '管理台']) {
      expect(labels(doc)).toContain(label);
    }
  });

  it('FR-I3：确定没有可用语音时不渲染发音按钮', () => {
    const doc = freshDoc();
    testPopup(doc).show(card({ canSpeak: false }), anchor);

    expect(labels(doc)).not.toContain('发音');
  });

  it('FR-B4：未收录的词也能被加入生词本，并显示"未收录"', () => {
    const doc = freshDoc();
    testPopup(doc).show(
      card(
        {
          senses: null,
          unlisted: true,
          head: { surface: 'learni', lemma: 'learni', inflectionHint: null, phoneticUs: '' },
        },
        { inBook: false },
      ),
      anchor,
    );

    expect(textOf(doc)).toContain('未收录');
    // 未收藏时的主操作就是「加入生词本」（FR-A6 的三选一）
    expect(labels(doc)).toContain('加入生词本');
  });

  it('FR-B4：未收录卡片显示 LLM 入口，生成后也渲染释义', () => {
    const doc = freshDoc();
    testPopup(doc).show(
      card({
        unlisted: true,
        senses: [{ pos: '', defZh: ['n. 测试；示例'] }],
        head: { surface: 'learni', lemma: 'learni', inflectionHint: null, phoneticUs: '' },
      }, { inBook: false }),
      anchor,
    );

    expect(labels(doc)).toContain('LLM 释义');
    expect(textOf(doc)).toContain('n. 测试；示例');
  });

  /**
   * 手动收藏轮的核心：**未加入生词本时主操作是「加入生词本」**，
   * 且不显示「忽略」（忽略一个不在生词本里的词没有意义）。
   */
  it('未加入生词本：主操作是「加入生词本」，没有「忽略」', () => {
    const doc = freshDoc();
    testPopup(doc).show(card({}, { inBook: false, meetCount: 0 }), anchor);

    expect(labels(doc)).toContain('加入生词本');
    expect(labels(doc)).not.toContain('忽略');
    expect(labels(doc)).not.toContain('已掌握');
  });

  it('未加入生词本：④段写明"尚未加入生词本"', () => {
    const doc = freshDoc();
    testPopup(doc).show(card({}, { inBook: false, meetCount: 0 }), anchor);

    expect(textOf(doc)).toContain('尚未加入生词本');
    expect(textOf(doc)).not.toContain('首次记录');
  });

  it('点按钮把动作与当前卡片交给回调', () => {
    const doc = freshDoc();
    const popup = testPopup(doc);
    const handler = vi.fn();
    popup.setActionHandler(handler);
    popup.show(card(), anchor);

    click(doc, '忽略');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toBe('ignore');
    expect((handler.mock.calls[0]![1] as CardModel).head.lemma).toBe('run');
  });

  it('四段结构：词形 / 音标 / 释义 / 遇见次数都在', () => {
    const doc = freshDoc();
    testPopup(doc).show(card(), anchor);

    const text = textOf(doc);
    expect(text).toContain('running');
    expect(text).toContain('run');
    expect(text).toContain('/rʌn/');
    expect(text).toContain('跑');
    expect(text).toContain('遇见 2 次');
  });

  /**
   * FR-A5 的 ④ 段口径原话：「**首次划词时该段显示"首次记录"**；
   * 例句尚未采集时只显示次数」。
   *
   * 这条不只是文案：划词即入库（FR-A17）是**隐式**发生的，
   * 卡片上若什么都不显示，用户会觉得"根本没有加入生词本"（实际反馈过这一点）。
   */
  it('首次划词（次数还是 0）时显示"首次记录"', () => {
    const doc = freshDoc();
    testPopup(doc).show(card({}, { meetCount: 0 }), anchor);

    expect(textOf(doc)).toContain('首次记录');
    expect(textOf(doc)).not.toContain('遇见 0 次');
  });

  it('已有次数时显示"遇见 N 次"，不显示"首次记录"', () => {
    const doc = freshDoc();
    testPopup(doc).show(card({}, { meetCount: 3 }), anchor);

    expect(textOf(doc)).toContain('遇见 3 次');
    expect(textOf(doc)).not.toContain('首次记录');
  });
});

describe('FR-A6：update 就地重绘', () => {
  it('update 换掉主按钮但弹窗仍可见（不关闭）', () => {
    const doc = freshDoc();
    const popup = testPopup(doc);
    popup.show(card({}, { status: 'new' }), anchor);
    expect(labels(doc)).toContain('已掌握');

    popup.update(card({}, { status: 'known' }));

    expect(popup.isVisible()).toBe(true);
    expect(labels(doc)).toContain('改回生词');
    expect(labels(doc)).not.toContain('已掌握');
  });

  it('未挂载时 update 不抛错', () => {
    const doc = freshDoc();
    expect(() => testPopup(doc).update(card())).not.toThrow();
  });
});

describe('FR-A8：生产用 closed shadow root', () => {
  it('不传 shadowMode 时外部读不到 shadowRoot', () => {
    const doc = freshDoc();
    const popup = createPopup(doc);
    popup.show(card(), anchor);

    expect(doc.getElementById('leximate-popup-host')!.shadowRoot).toBeNull();
  });
});

describe('FR-A7：containsEvent 判定"在不在弹窗内"', () => {
  it('路径里含宿主节点 → 在弹窗内', () => {
    const doc = freshDoc();
    const popup = testPopup(doc);
    popup.show(card(), anchor);

    const host = doc.getElementById('leximate-popup-host')!;
    expect(popup.containsEvent({ composedPath: () => [host] })).toBe(true);
  });

  it('路径里没有宿主节点 → 在弹窗外部（该关闭）', () => {
    const doc = freshDoc();
    const popup = testPopup(doc);
    popup.show(card(), anchor);

    expect(popup.containsEvent({ composedPath: () => [doc.createElement('div')] })).toBe(false);
    expect(popup.containsEvent({ composedPath: () => [] })).toBe(false);
  });

  it('没有 composedPath 时退回 target 判定（closed shadow 会重定向到宿主）', () => {
    const doc = freshDoc();
    const popup = testPopup(doc);
    popup.show(card(), anchor);

    const host = doc.getElementById('leximate-popup-host')!;
    expect(popup.containsEvent({ target: host })).toBe(true);
    expect(popup.containsEvent({ target: doc.createElement('p') })).toBe(false);
  });

  it('未挂载时一律算外部', () => {
    const doc = freshDoc();
    expect(testPopup(doc).containsEvent({ composedPath: () => [] })).toBe(false);
  });
});

describe('清理：hide / destroy', () => {
  it('hide 后不可见，再 show 恢复可见', () => {
    const doc = freshDoc();
    const popup = testPopup(doc);
    popup.show(card(), anchor);
    popup.hide();
    expect(popup.isVisible()).toBe(false);

    popup.show(card(), anchor);
    expect(popup.isVisible()).toBe(true);
  });

  it('destroy 摘掉宿主节点', () => {
    const doc = freshDoc();
    const popup = testPopup(doc);
    popup.show(card(), anchor);
    popup.destroy();

    expect(doc.getElementById('leximate-popup-host')).toBeNull();
  });
});
