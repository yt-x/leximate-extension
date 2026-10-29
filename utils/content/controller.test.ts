/**
 * 内容脚本主控的行为验收（PLAN.md FR-A1、FR-A4、FR-A7、FR-A13、FR-A14、FR-A17）。
 *
 * 这一层不测"内部怎么算"，而测**行为契约**：
 * - FR-A13 / FR-A14：黑名单站点与关闭开关时**零注入**
 * - FR-A4：输入框内划词不弹
 * - FR-A1：命中就弹、未收录也弹（FR-B4 要提示）
 * - FR-A7：Esc / 滚动超阈值 / 点击外部 / 失焦都能关
 * - FR-A17：只有主动划词才计遇见次数
 */
import { describe, expect, it, vi } from 'vitest';
import type { DictLookup } from '../dict/lookup';
import type { Settings } from '../db/types';
import { DEFAULT_SETTINGS } from '../db/kv';
import type { WordStatus } from '../db/types';
import { createController, type ControllerEnv } from './controller';
import { visibleActions } from './card';
import type { CardAction, CardModel } from './card';
import type { AnnotationScheduler } from './observe';
import type { Popup } from './popup';
import type { Rect } from './position';
import type { SelectionLike } from './selection';
import type { HighlightEnv } from './highlight';

/** 一个最小可用的假词库：只认这几个词，running 经词形还原命中 run */
function fakeDict(): DictLookup {
  const known = new Set(['run', 'naive', 'well-known']);
  const entryOf = (lemma: string) => ({
    lemma,
    phoneticUs: `/${lemma}/`,
    phoneticUk: '',
    pos: ['v.'],
    defZh: ['释义'],
  });
  return {
    warm: vi.fn(async () => {}),
    lookup: (surface: string) => {
      const key = surface.normalize('NFC').toLowerCase();
      // FR-B3：running 是 run 的变形，页面词形与词条原形不同
      if (key === 'running') {
        return { entry: entryOf('run'), via: 'lemmatized' as const, hint: '现在分词' };
      }
      const hitKey = [...known].find(
        (k) => k === key || k === key.normalize('NFD').replace(/\p{M}+/gu, ''),
      );
      if (!hitKey) return undefined;
      return { entry: entryOf(hitKey), via: 'direct' as const };
    },
    ensureFor: vi.fn(async () => false),
    loadedShards: () => ['core'],
    version: () => '9.9.9',
  } as unknown as DictLookup;
}

function fakePopup() {
  const shown: Array<{ surface: string }> = [];
  const updated: Array<{ surface: string }> = [];
  /** 弹窗的宿主节点：`composedPath()` 里出现它就代表"点在弹窗内" */
  const host = { nodeName: 'LEXIMATE-POPUP-HOST' } as unknown as Node;
  let visible = false;
  let lastCard: CardModel | null = null;
  let handler: ((action: CardAction, card: CardModel) => void) | null = null;
  const popup: Popup = {
    show: (card) => {
      shown.push({ surface: card.head.surface });
      lastCard = card;
      visible = true;
    },
    update: (card) => {
      updated.push({ surface: card.head.surface });
      lastCard = card;
    },
    hide: () => {
      visible = false;
    },
    isVisible: () => visible,
    destroy: () => {},
    setActionHandler: (next) => {
      handler = next;
    },
    containsEvent: (event) => {
      const path = (event as { composedPath?: () => unknown[] })?.composedPath?.() ?? [];
      return path.includes(host);
    },
  };
  return {
    popup,
    shown,
    updated,
    host,
    isVisible: () => visible,
    card: () => lastCard,
    /** 模拟点弹窗里的按钮（FR-A6 的六个操作） */
    click: (action: CardAction) => {
      if (!handler) throw new Error('按钮没有接线：setActionHandler 从未被调用');
      handler(action, lastCard!);
    },
    hasHandler: () => handler !== null,
  };
}

const noopHighlight: HighlightEnv = {
  registry: { set: () => {}, delete: () => false },
  createRange: () => ({ range: {} }),
  createHighlight: () => ({}),
  addRanges: () => {},
  removeRanges: () => {},
  defineStyle: () => {},
  removeStyle: () => {},
};

const idleScheduler: AnnotationScheduler = {
  markDirty: () => {},
  flush: () => {},
  stop: () => {},
  isIdle: () => true,
};

interface Harness {
  env: ControllerEnv;
  shown: Array<{ surface: string }>;
  updated: Array<{ surface: string }>;
  popupVisible: () => boolean;
  popupHost: Node;
  /** 点弹窗里的某个操作按钮（未接线时抛错，红测就在这里红） */
  clickAction: (action: CardAction) => void;
  popupHasHandler: () => boolean;
  card: () => CardModel | null;
  fire: (event: string, payload?: unknown) => void;
  recordMeet: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  logs: Array<[string, unknown]>;
}

function harness(patch: Partial<ControllerEnv> = {}, settings: Partial<Settings> = {}): Harness {
  const { popup, shown, updated, host, isVisible, click, card, hasHandler } = fakePopup();
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const logs: Array<[string, unknown]> = [];
  const recordMeet = vi.fn(() => true);
  const setStatus = vi.fn(async () => ({ status: 'known' as const, meetCount: 1 }));

  let selection: SelectionLike | null = null;
  let rect: Rect | null = { top: 100, left: 100, width: 40, height: 16 };
  let scroll = { x: 0, y: 0 };

  const env: ControllerEnv = {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    hostname: 'example.com',
    dict: fakeDict(),
    popup,
    highlight: noopHighlight,
    scheduler: idleScheduler,
    getSelection: () => selection,
    getSelectionRect: () => rect,
    getScroll: () => scroll,
    collectTextNodes: () => [],
    readText: () => '',
    cachedState: () => ({ status: 'new', meetCount: 1 }),
    underlineCount: () => undefined,
    ensureStates: async () => false,
    recordMeet,
    setStatus,
    speak: vi.fn(),
    canSpeak: () => true,
    onSpeechAvailable: () => () => {},
    setSpeechRate: vi.fn(),
    copyText: vi.fn(async () => true),
    openManager: vi.fn(),
    observe: () => ({ disconnect: () => {} }),
    root: () => ({ nodeType: 1 } as unknown as Node),
    on: (target, event, handler) => {
      const key = `${target}:${event}`;
      const list = handlers.get(key) ?? [];
      list.push(handler);
      handlers.set(key, list);
      return () => {
        const current = handlers.get(key) ?? [];
        handlers.set(key, current.filter((h) => h !== handler));
      };
    },
    log: (event, detail) => void logs.push([event, detail]),
    ...patch,
  };

  return {
    env,
    shown,
    updated,
    popupVisible: isVisible,
    popupHost: host,
    clickAction: click,
    popupHasHandler: hasHandler,
    card,
    recordMeet,
    setStatus,
    logs,
    fire(event, payload) {
      // 事件名可能同时挂在 document 与 window 上
      for (const key of [`document:${event}`, `window:${event}`]) {
        for (const handler of handlers.get(key) ?? []) handler(payload);
      }
    },
    // 供用例改选区/滚动
    ...({
      setSelection(next: SelectionLike | null) {
        selection = next;
      },
      setRect(next: Rect | null) {
        rect = next;
      },
      setScroll(next: { x: number; y: number }) {
        scroll = next;
      },
    } as object),
  } as Harness & {
    setSelection(s: SelectionLike | null): void;
    setRect(r: Rect | null): void;
    setScroll(s: { x: number; y: number }): void;
  };
}

/** 造一个"正常选中一个词"的选区（默认两端都是空白，即完整覆盖） */
function selectionOf(
  word: string,
  anchorNode?: unknown,
  context: { before?: string; after?: string } = {},
): SelectionLike {
  return {
    isCollapsed: false,
    text: word,
    anchorNode: (anchorNode ?? { nodeType: 1, nodeName: 'P', parentElement: null }) as Node,
    before: context.before ?? '',
    after: context.after ?? '',
  };
}

describe('FR-A13 / FR-A14：不该干活的站点什么都不做', () => {
  it('命中黑名单时 start 返回 false 且不 warm 词库', async () => {
    const h = harness({}, { blacklist: ['example.com'] });
    const controller = createController(h.env);

    expect(await controller.start()).toBe(false);
    expect(controller.isRunning()).toBe(false);
    expect(h.env.dict.warm).not.toHaveBeenCalled();
    expect(h.logs.some(([e]) => e === 'content-skipped')).toBe(true);
  });

  it('黑名单站点划词不弹', async () => {
    const h = harness({}, { blacklist: ['example.com'] });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    expect(await controller.handleSelection()).toBeNull();
    expect(h.shown).toHaveLength(0);
  });

  it('FR-A14：全局开关关闭时 start 返回 false', async () => {
    const h = harness({}, { enabled: false });
    const controller = createController(h.env);

    expect(await controller.start()).toBe(false);
    expect(h.env.dict.warm).not.toHaveBeenCalled();
  });

  it('通配黑名单同样生效', async () => {
    const h = harness({ hostname: 'www.example.com' }, { blacklist: ['*.example.com'] });
    expect(await createController(h.env).start()).toBe(false);
  });

  it('正常站点才 warm 词库并启动', async () => {
    const h = harness();
    const controller = createController(h.env);

    expect(await controller.start()).toBe(true);
    expect(h.env.dict.warm).toHaveBeenCalledTimes(1);
    expect(controller.isRunning()).toBe(true);
  });
});

describe('FR-A1 / FR-B4：该弹的时候弹', () => {
  it('命中词库时弹卡片', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    const card = await controller.handleSelection();

    expect(card).not.toBeNull();
    expect(card!.unlisted).toBe(false);
    expect(h.shown).toEqual([{ surface: 'run' }]);
  });

  it('FR-B4：未收录也弹（要显示"未收录"，不静默失败）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('zzzz'));
    const card = await controller.handleSelection();

    expect(card).not.toBeNull();
    expect(card!.unlisted).toBe(true);
    expect(h.shown).toHaveLength(1);
  });

  it('FR-B7：内置词表没有、但导入词典有的词要出释义（不显示未收录）', async () => {
    // 用户实测：划 Adventures 显示「未收录 / 可在设置页导入完整词库后查到」——
    // 可他已经导入了完整词库。根因是 controller 调 querySelectionAsync 时
    // 没把 lookupImported 传下去，导入词典那条分支永远走不到。
    const h = harness({
      lookupImported: async (surface: string) =>
        surface.toLowerCase() === 'adventures'
          ? {
              lemma: 'adventure',
              hint: '复数形式',
              word: {
                phoneticUs: "əd'ventʃə",
                pos: ['n.'],
                defZh: ['n. 冒险, 冒险经历'],
                fallbackDef: [],
                examTags: ['cet4'],
              },
            }
          : null,
    });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('Adventures'));
    const card = await controller.handleSelection();

    expect(card).not.toBeNull();
    expect(card!.unlisted).toBe(false);
    // 命中导入词典后，词头是词条原形（adventure），并带"原形 adventure"的变形提示
    expect(card!.head.lemma).toBe('adventure');
    expect(card!.head.inflectionHint).toContain('adventure');
    // 这条 fixture 就是 ECDICT 的真实形态：`pos` 与 `defZh` **都**带词性。
    // 卡片渲染时 `pos` 单独成标签，所以 defZh 里的 `n. ` 前缀要被剥掉，
    // 否则会显示成 `n. n. 冒险, 冒险经历`（用户实测 `goofy`，2026-10-24）。
    const senses = card!.senses ?? [];
    expect(senses.map((s) => s.pos)).toEqual(['n.']);
    expect(senses.flatMap((s) => s.defZh)).toEqual(['冒险, 冒险经历']);
  });

  it('FR-B7：导入词典也没有时才显示未收录', async () => {
    const h = harness({ lookupImported: async () => null });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('zzzz'));
    const card = await controller.handleSelection();

    expect(card!.unlisted).toBe(true);
  });

  it('不是词时不弹（纯数字）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('2024'));
    expect(await controller.handleSelection()).toBeNull();
    expect(h.shown).toHaveLength(0);
  });

  it('空选区不弹', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike | null): void }).setSelection(null);
    expect(await controller.handleSelection()).toBeNull();
  });

  it('FR-A4：输入框内划词不弹', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    const input = { nodeType: 1, nodeName: 'INPUT', parentElement: null };
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('run', input),
    );
    expect(await controller.handleSelection()).toBeNull();
    expect(h.shown).toHaveLength(0);
  });

  it('未启动时不弹（黑名单站点即使被调到也不弹）', async () => {
    const h = harness({}, { blacklist: ['example.com'] });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    expect(await controller.handleSelection()).toBeNull();
  });

  it('取不到选区矩形时不弹（宁可不弹也不弹到错位置）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    (h as unknown as { setRect(r: Rect | null): void }).setRect(null);

    expect(await controller.handleSelection()).toBeNull();
    expect(h.shown).toHaveLength(0);
  });
});

/**
 * 复现用户报告：划 `proof` 一个词，生词本里出现 `p`/`pr`/`pro`/`proo`/`proof` 五条。
 *
 * 规格口径（`PLAN.md` FR-A1 的实现口径表）原话：
 * "监听 `mouseup`。**若此刻选区为空，再等一次 `selectionchange`**……
 *  以先到者为准，**不引入固定延时**。"
 *
 * 也就是说 `selectionchange` 是 mouseup 的**补等**，不是第二条独立的触发源。
 * 旧实现把它无条件挂上并对任何非空选区都跑一遍划词——而拖选时选区是
 * **逐字符增长**的，于是每个中间前缀都成了一次"划词"。
 */
describe('FR-A1：只有松手才算一次划词（拖选的中间选区不算）', () => {
  it('拖选过程中每个中间选区都不弹窗、不记账', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    // 拖选：选区从 p 逐步长到 proof，浏览器每变一次就派发一次 selectionchange
    for (const partial of ['p', 'pr', 'pro', 'proo']) {
      (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
        selectionOf(partial),
      );
      h.fire('selectionchange');
    }
    // 等异步的 handleSelection 跑完：旧实现会在这里把四个前缀全记成词
    await tick();

    expect(h.recordMeet).not.toHaveBeenCalled();
    expect(h.shown).toHaveLength(0);

    // 松手：这一次才是用户的"划词"
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('proof'),
    );
    h.fire('mouseup');
    await tick();

    expect(h.recordMeet).toHaveBeenCalledTimes(1);
    expect(h.recordMeet.mock.calls[0]![0]).toMatchObject({ lemma: 'proof' });
  });

  it('规格口径仍成立：mouseup 时选区为空，则补等一次 selectionchange', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    // 部分浏览器在 mouseup 那一刻选区还没落定
    (h as unknown as { setSelection(s: SelectionLike | null): void }).setSelection(null);
    h.fire('mouseup');
    await tick();
    expect(h.recordMeet).not.toHaveBeenCalled();

    // 随后浏览器把选区补上：这一次要处理
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    h.fire('selectionchange');
    await tick();
    expect(h.recordMeet).toHaveBeenCalledTimes(1);

    // 但**一次即撤**：之后的选区变化不再被当成划词（否则又回到前缀风暴）
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('go'));
    h.fire('selectionchange');
    await tick();
    expect(h.recordMeet).toHaveBeenCalledTimes(1);
  });

  it('新的手势（mousedown）会撤掉待补状态，陈旧的一次不会误触发', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    // 一次"空选区"的 mouseup 把补等状态挂上，但浏览器没有再派发 selectionchange
    (h as unknown as { setSelection(s: SelectionLike | null): void }).setSelection(null);
    h.fire('mouseup');

    // 用户进行了新的手势（比如用键盘选了一段），不应被当成上一次的补等
    h.fire('mousedown', { composedPath: () => [] });
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('keyboard'));
    h.fire('selectionchange');
    await tick();

    expect(h.recordMeet).not.toHaveBeenCalled();
  });
});

/**
 * 手动收藏轮（FR-A6 / FR-A17 修订）：
 * **默认划词只弹卡片、不写库**，由用户点「加入生词本」才收进来。
 *
 * 用户的原话：「需要改，由用户手动触发——不然会频繁的触发误点击加入生词。」
 */
describe('FR-A6 / FR-A17：默认手动收藏（划词不写库）', () => {
  /** 一个"这个词不在生词本里"的环境 */
  function outOfBookHarness(patch: Partial<ControllerEnv> = {}) {
    return harness({ cachedState: () => undefined, ...patch });
  }

  it('划一个未收藏的词：弹卡片但不写库', async () => {
    const h = outOfBookHarness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('proof'));
    await controller.handleSelection();
    await tick();

    expect(h.recordMeet).not.toHaveBeenCalled();
    expect(h.shown).toHaveLength(1);
  });

  it('未收藏的卡片：主操作是「加入生词本」，且不显示「忽略」', async () => {
    const h = outOfBookHarness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('proof'));
    await controller.handleSelection();

    const card = h.card()!;
    expect(card.meta.inBook).toBe(false);
    expect(visibleActions({ inBook: card.meta.inBook, status: card.meta.status })[0]).toBe('collect');
  });

  it('点「加入生词本」才写库，并在回写后把卡片更新成已收藏', async () => {
    const h = outOfBookHarness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('proof'));
    await controller.handleSelection();
    expect(h.recordMeet).not.toHaveBeenCalled();

    h.clickAction('collect');
    await tick();

    expect(h.recordMeet).toHaveBeenCalledTimes(1);
    expect(h.recordMeet.mock.calls[0]![0]).toMatchObject({ lemma: 'proof', unlisted: true });

    // 后台回写状态（内容脚本在真实链路里调 applyState）
    controller.applyState('proof', { status: 'new', meetCount: 1 });
    expect(h.card()!.meta.inBook).toBe(true);
    expect(h.card()!.meta.meetCount).toBe(1);
  });

  it('已收藏的词再划一次：+1（重复遇见仍要计数）', async () => {
    const h = harness({ cachedState: () => ({ status: 'new' as const, meetCount: 3 }) });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    await controller.handleSelection();
    await tick();

    expect(h.recordMeet).toHaveBeenCalledTimes(1);
    expect(h.card()!.meta.inBook).toBe(true);
  });

  it('打开「选中即入库」开关时恢复旧行为（划词就写库）', async () => {
    const h = harness(
      { cachedState: () => undefined },
      { autoAddOnSelect: true },
    );
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('proof'));
    await controller.handleSelection();
    await tick();

    expect(h.recordMeet).toHaveBeenCalledTimes(1);
  });

  it('未收藏的词不写库，因此反复误选不会污染生词本', async () => {
    const h = outOfBookHarness();
    const controller = createController(h.env);
    await controller.start();

    for (const word of ['alpha', 'beta', 'gamma']) {
      (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf(word));
      await controller.handleSelection();
      await tick();
      // 每换一个词都要能重新弹卡（去重键只挡同一段文本）
    }

    expect(h.recordMeet).not.toHaveBeenCalled();
    expect(h.shown).toHaveLength(3);
  });
});

/**
 * FR-A16 的「完整性」行：选区切在词中间不算选中了一个词。
 *
 * 用户原话：「生词一定要是一个完整的词才加进去，你不能我仅仅选择几个英文字母，
 * 就将其视作生词，这不是生词！」
 */
describe('FR-A16 完整性：切在词中间的选区不弹可收藏的卡片', () => {
  it('从 proof 里只选到 proo（后面还有 f）→ 不弹、不写库', async () => {
    const h = harness({ cachedState: () => undefined });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('proo', undefined, { before: '', after: 'f' }),
    );

    expect(await controller.handleSelection()).toBeNull();
    expect(h.shown).toHaveLength(0);
    expect(h.recordMeet).not.toHaveBeenCalled();
  });

  it('只选中词的后半段（前面还有词字符）→ 同样不弹', async () => {
    const h = harness({ cachedState: () => undefined });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('roof', undefined, { before: 'p', after: '' }),
    );

    expect(await controller.handleSelection()).toBeNull();
  });

  it('完整覆盖（两端是空白/标点/引号）→ 正常弹', async () => {
    const h = harness({ cachedState: () => undefined });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('proof', undefined, { before: "'", after: "'" }),
    );

    expect(await controller.handleSelection()).not.toBeNull();
  });
});

describe('FR-A17：只有主动划词才计遇见次数', () => {
  it('后台回写状态后，已打开的卡片就地刷新（遇见次数立刻可见）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    await controller.handleSelection();
    const before = h.updated.length;

    controller.applyState('run', { status: 'new', meetCount: 7 });

    expect(h.updated).toHaveLength(before + 1);
    expect(h.card()!.meta.meetCount).toBe(7);
    expect(h.popupVisible()).toBe(true);
  });

  it('回写的是别的词时不刷新卡片（别把当前卡片改错）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    await controller.handleSelection();
    const before = h.updated.length;

    controller.applyState('other', { status: 'known', meetCount: 9 });

    expect(h.updated).toHaveLength(before);
    expect(h.card()!.head.lemma).toBe('run');
  });

  it('弹窗已关闭时回写不报错', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    expect(() => controller.applyState('run', { status: 'new', meetCount: 1 })).not.toThrow();
  });

  it('短于设置的词长不弹、不记账（minWordLength 要真的生效）', async () => {
    const h = harness({}, { minWordLength: 2 });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('p'));
    h.fire('mouseup');
    await tick();

    expect(await controller.handleSelection()).toBeNull();
    expect(h.recordMeet).not.toHaveBeenCalled();
    expect(h.shown).toHaveLength(0);
  });

  it('达到词长就正常处理（不被误伤）', async () => {
    const h = harness({}, { minWordLength: 2 });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    h.fire('mouseup');
    await tick();

    expect(h.recordMeet).toHaveBeenCalledTimes(1);
  });

  it('命中时计一次', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    await controller.handleSelection();

    expect(h.recordMeet).toHaveBeenCalledWith({
      lemma: 'run',
      surface: 'run',
      unlisted: false,
      dict: { phoneticUs: '/run/', pos: ['v.'], defZh: ['释义'] },
      inflectionOf: null,
    });
  });

  it('未收录的词也计（用户确实遇见了）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('zzzz'));
    await controller.handleSelection();

    expect(h.recordMeet).toHaveBeenCalledWith({
      lemma: 'zzzz',
      surface: 'zzzz',
      unlisted: true,
      inflectionOf: null,
    });
  });

  it('判定失败不计', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('2024'));
    await controller.handleSelection();

    expect(h.recordMeet).not.toHaveBeenCalled();
  });

  it('同一段文本重复处理只算一次（mouseup 与 selectionchange 双路径去重）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    await controller.handleSelection();
    // 同一个词再划一次：仍然在一次"打开"里，不该重复计数
    expect(await controller.handleSelection()).toBeNull();
    expect(h.recordMeet).toHaveBeenCalledTimes(1);
  });
});

/**
 * §2 数据模型的两条不变式：
 * - `lemma` 是**唯一索引**，因此变形词必须记到原形那一条上（FR-B3）
 * - `isUnlisted` 标记"词库未收录"（FR-B4 仍采集，导出时标记）
 *
 * 旧实现把 `surface` 当记账键、并且不带 `isUnlisted`：
 * 划 `running` 会新建一条 `lemma='running'` 的词（永远累加不到 `run`），
 * 划 `learni` 会以 `isUnlisted=false` 进库 —— 在管理台里和真单词完全一样。
 */
describe('FR-B3 / FR-B4：记账键与未收录标记', () => {
  it('命中变形词时按**词条原形**记账，并带上词库字段', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('running'),
    );
    await controller.handleSelection();

    expect(h.recordMeet).toHaveBeenCalledWith({
      lemma: 'run',
      surface: 'running',
      unlisted: false,
      dict: { phoneticUs: '/run/', pos: ['v.'], defZh: ['释义'] },
      inflectionOf: null,
    });
  });

  it('未收录的词按页面词形记账，并标成未收录', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('Learnin'),
    );
    await controller.handleSelection();

    expect(h.recordMeet).toHaveBeenCalledWith({
      lemma: 'learnin',
      surface: 'Learnin',
      unlisted: true,
      inflectionOf: null,
    });
  });

  it('卡片的次数与状态读的是**词条原形**那一条（不是页面词形）', async () => {
    const cachedState = vi.fn(() => ({ status: 'new' as const, meetCount: 7 }));
    const h = harness({ cachedState });
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('running'),
    );
    await controller.handleSelection();

    expect(cachedState).toHaveBeenCalledWith('run');
    expect(h.card()!.meta.meetCount).toBe(7);
    expect(h.card()!.meta.inBook).toBe(true);
  });

  it('卡片词头同时显示页面词形与原形（FR-B3c 的可读性）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(
      selectionOf('running'),
    );
    const card = await controller.handleSelection();

    expect(card!.head.surface).toBe('running');
    expect(card!.head.lemma).toBe('run');
  });
});

describe('FR-A7：四种关闭路径', () => {
  async function openPopup(h: Harness) {
    const controller = createController(h.env);
    await controller.start();
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    await controller.handleSelection();
    expect(h.popupVisible()).toBe(true);
    return controller;
  }

  it('Esc 关闭', async () => {
    const h = harness();
    await openPopup(h);
    h.fire('keydown', { key: 'Escape' });
    expect(h.popupVisible()).toBe(false);
  });

  it('非 Esc 键不关闭', async () => {
    const h = harness();
    await openPopup(h);
    h.fire('keydown', { key: 'a' });
    expect(h.popupVisible()).toBe(true);
  });

  it('滚动超过 80px 关闭', async () => {
    const h = harness();
    await openPopup(h);

    const set = h as unknown as { setScroll(s: { x: number; y: number }): void };
    set.setScroll({ x: 0, y: 50 });
    h.fire('scroll');
    expect(h.popupVisible()).toBe(true); // 阈值内

    set.setScroll({ x: 0, y: 200 });
    h.fire('scroll');
    expect(h.popupVisible()).toBe(false);
  });

  it('页面失焦关闭', async () => {
    const h = harness();
    await openPopup(h);
    h.fire('blur');
    expect(h.popupVisible()).toBe(false);
  });

  it('点击外部关闭', async () => {
    const h = harness();
    await openPopup(h);
    h.fire('mousedown', { composedPath: () => [] });
    expect(h.popupVisible()).toBe(false);
  });

  /**
   * 复现 bug：弹窗在 closed shadow root 里，按钮上的 mousedown 会**重定向到宿主节点**
   * 后冒泡到 document。旧实现拿 `composedPath()` 里的 DOM 节点去比 `env.popup`
   * 这个 JS 门面对象，永远不相等，于是"点按钮"被当成"点外部"——
   * 弹窗先被关掉，`lastHandled` 又被清空，紧接着的 mouseup 再弹一次，
   * 用户看到的就是"卡片闪了一下、按钮没有任何效果"。
   */
  it('点弹窗内部不关闭（点按钮不能走"点外部"那条路）', async () => {
    const h = harness();
    await openPopup(h);

    h.fire('mousedown', { composedPath: () => [h.popupHost] });

    expect(h.popupVisible()).toBe(true);
  });

  it('点击弹窗内部后，同一选区不会因为去重键被清空而重弹（不闪）', async () => {
    const h = harness();
    const controller = await openPopup(h);

    h.fire('mousedown', { composedPath: () => [h.popupHost] });
    // 紧接着的 mouseup 是浏览器必然派发的下一个事件
    h.fire('mouseup');

    // 弹窗一直开着，且没有被重新 show 一遍（show 次数仍是 1）
    expect(h.popupVisible()).toBe(true);
    expect(h.shown).toHaveLength(1);
    expect(controller.isRunning()).toBe(true);
  });

  it('关闭后再划同一个词能重新打开（去重键被重置）', async () => {
    const h = harness();
    const controller = await openPopup(h);

    h.fire('keydown', { key: 'Escape' });
    expect(h.popupVisible()).toBe(false);

    expect(await controller.handleSelection()).not.toBeNull();
    expect(h.popupVisible()).toBe(true);
  });
});

/** 等一轮微任务 + 宏任务：操作处理是异步的（要等后台回写状态） */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 可对账的标注环境（FR-A9 / FR-A10 / FR-A12）。
 *
 * 记录"哪些 Range 被登记在哪个组下"，这样"该不该标"与"增量有没有抹掉别人"
 * 都能在 Node 里断言——真实 `CSS.highlights` 只在浏览器里存在。
 */
function trackingHighlight() {
  const registered = new Map<string, Set<unknown>>();
  const styles = new Map<string, string>();
  const env: HighlightEnv = {
    registry: {
      set: (name, highlight) => void registered.set(name, highlight as Set<unknown>),
      delete: (name) => registered.delete(name),
    },
    createRange: (node, from, to) => ({ range: { node, from, to } }),
    createHighlight: (ranges) => new Set(ranges),
    addRanges: (highlight, ranges) => {
      const set = highlight as Set<unknown>;
      for (const range of ranges) set.add(range);
    },
    removeRanges: (highlight, ranges) => {
      const set = highlight as Set<unknown>;
      for (const range of ranges) set.delete(range);
    },
    defineStyle: (name, declarations) => void styles.set(name, declarations),
    removeStyle: (name) => void styles.delete(name),
  };
  return {
    env,
    registered,
    styles,
    /** 当前登记的全部 Range 条数（跨组求和） */
    total: () => [...registered.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

/** 造一个文本节点：内容与研究用的字面量一致 */
function textNode(text: string): Node {
  return { nodeType: 3, nodeValue: text, textContent: text } as unknown as Node;
}

describe('FR-A9 / FR-A10：下划线只标"生词本里的生词"', () => {
  /**
   * 判据是**后台下发的生词集合**（`underlineCount`），不是"词典认不认识"、
   * 也不是"缓存里有没有状态"。
   *
   * 旧实现拿"在词典里"当候选、把"查不到状态"当成 `{status:'new'}`（`UNSEEN`），
   * 两处合起来是"页面上每个词库词都算生词"；再叠加"每次调用整表清空"，
   * 用户看到的最终形态是"一条下划线都没有"。
   */
  function annotateHarness(options: {
    text?: string;
    /** 下发的生词集合：词条原形 → 次数；不在表里 = 不是生词 */
    newWords?: Record<string, number>;
  }) {
    const highlight = trackingHighlight();
    const node = textNode(options.text ?? 'run naive');
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: () => [node],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      underlineCount: (word) => options.newWords?.[word.normalize('NFC').toLowerCase()],
    });
    return { h, highlight };
  }

  it('不在生词集合里的词不标：词库里有它也没用', async () => {
    const { h, highlight } = annotateHarness({ newWords: {} });
    await createController(h.env).start();
    await tick();

    expect(highlight.total()).toBe(0);
  });

  it('集合里是生词的词会被标上', async () => {
    const { h, highlight } = annotateHarness({
      text: 'run naive',
      newWords: { run: 1, naive: 1 },
    });
    await createController(h.env).start();
    await tick();

    expect(highlight.total()).toBe(2);
  });

  it('已掌握与忽略的词不在集合里，因此不标（FR-A10）', async () => {
    // 后台只下发 status=new 的词，所以"已掌握/忽略"表现为**不在集合里**
    const { h, highlight } = annotateHarness({ text: 'run', newWords: {} });
    await createController(h.env).start();
    await tick();

    expect(highlight.total()).toBe(0);
  });

  /**
   * 划词路径仍然要问后台（卡片要显示次数与状态），
   * 但**标注路径不再逐词询问**——集合是一次性下发的。
   */
  it('选中一个不在集合里的词时向后台问一次状态（可能是已掌握/忽略）', async () => {
    const highlight = trackingHighlight();
    const node = textNode('run');
    const ensureStates = vi.fn(async () => false);
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: () => [node],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      underlineCount: () => undefined,
      cachedState: () => undefined,
      ensureStates,
    });

    const controller = createController(h.env);
    await controller.start();
    // 启动时的标注**不该**问后台（集合已经下发了）
    expect(ensureStates).not.toHaveBeenCalled();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    await controller.handleSelection();
    await tick();

    expect(ensureStates).toHaveBeenCalledWith(['run']);
    expect(highlight.total()).toBe(0);
  });
});

/**
 * 复现用户报告："加入生词本以后的词，在页面中并没有渲染出下划线——什么都没有"。
 *
 * 根因：标注的**候选**是按**词典**圈的
 * （`scanKnownWords(text, (w) => dict.lookup(w) !== undefined)`）。
 * 于是"被收藏但词表没收录的词"（如 `proof`，920 条核心词表里没有它）
 * **永远进不了候选**——刷新多少次都不会有下划线。
 *
 * 规格口径（FR-A9 + §4.5 P3）是：标注集合 = **本地生词本**里的生词，
 * 由后台**一次性下发**。词典在这里只该当**词形还原器**用，不该当过滤器。
 */
describe('FR-A9：下划线按生词本判定，不是按词典', () => {
  function underlineHarness(options: {
    text: string;
    /** 后台推送的"生词集合"：词条原形 → 遇见次数 */
    newWords: Record<string, number>;
  }) {
    const highlight = trackingHighlight();
    const node = textNode(options.text);
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: () => [node],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      // 词典只认识 testDict 里那几个词：proof 不在其中（用户遇到的就是这种）
      underlineCount: (word: string) => {
        const key = word.normalize('NFC').toLowerCase();
        if (options.newWords[key] !== undefined) return options.newWords[key];
        // 词形还原：页面上的 running 要落到词条 run
        const lemma = /^running$/.test(key) ? 'run' : undefined;
        return lemma ? options.newWords[lemma] : undefined;
      },
    });
    return { h, highlight };
  }

  it('未收录但已被收藏的词会被标上下划线（用户的 bug）', async () => {
    const { h, highlight } = underlineHarness({ text: 'the proof is here', newWords: { proof: 1 } });
    await createController(h.env).start();

    expect(highlight.total()).toBe(1);
  });

  it('词条在生词本里、页面是它的变形形式 → 也标（经词形还原落到原形）', async () => {
    const { h, highlight } = underlineHarness({ text: 'running fast', newWords: { run: 2 } });
    await createController(h.env).start();

    expect(highlight.total()).toBe(1);
  });

  it('词典认识但**不在生词本**的词不标（回归保护）', async () => {
    const { h, highlight } = underlineHarness({
      text: 'run naive well-known',
      newWords: { proof: 1 },
    });
    await createController(h.env).start();

    expect(highlight.total()).toBe(0);
  });

  it('加入生词本后**不需要刷新页面**：重扫一次就出现下划线', async () => {
    const highlight = trackingHighlight();
    const node = textNode('the proof is here');
    const newWords: Record<string, number> = {};
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: () => [node],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      underlineCount: (word) => {
        const key = word.normalize('NFC').toLowerCase();
        return newWords[key];
      },
    });

    const controller = createController(h.env);
    await controller.start();
    expect(highlight.total()).toBe(0);

    // 用户点了「加入生词本」：后台回写 → 入口层更新集合 → 重扫
    newWords.proof = 1;
    controller.annotateAll();

    expect(highlight.total()).toBe(1);
  });
});

describe('FR-A12：增量标注不抹掉别的节点', () => {
  it('标注新子树后，先前标注的节点仍然带着下划线', async () => {
    const highlight = trackingHighlight();
    const first = textNode('run');
    const second = textNode('naive');
    const nodes = new Map<Node, boolean>();
    nodes.set(first, true);

    const state = () => ({ status: 'new' as const, meetCount: 1 });
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: (root) => (root === first || root === second ? [root] : [...nodes.keys()]),
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      cachedState: state,
      underlineCount: () => 1,
      root: () => ({ nodeType: 1 } as unknown as Node),
    });

    const controller = createController(h.env);
    await controller.start();
    await tick();
    const afterAll = highlight.total();
    expect(afterAll).toBe(1);

    // 页面新增了一个子树（真实页面一直在做这件事）
    controller.annotateSubtree(second);
    await tick();

    // 旧的还在，新的加上来
    expect(highlight.total()).toBe(2);
  });

  it('文本节点自身的改写也会被重新标注（characterData 变更的脏节点就是它）', async () => {
    const highlight = trackingHighlight();
    // 内容由闭包给出：模拟页面改写了这个文本节点
    let text = 'run';
    const node = {
      nodeType: 3,
      get textContent() {
        return text;
      },
    } as unknown as Node;

    const h = harness({
      highlight: highlight.env,
      // TreeWalker 不会返回根节点：这里刻意返回空，验的就是控制器自己处理文本节点
      collectTextNodes: () => [],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      cachedState: () => ({ status: 'new' as const, meetCount: 1 }),
      underlineCount: () => 1,
    });

    const controller = createController(h.env);
    await controller.start();
    await tick();
    expect(highlight.total()).toBe(0); // root 不是文本节点，collectTextNodes 返回空

    controller.annotateSubtree(node);
    expect(highlight.total()).toBe(1);

    // 页面把 run 改成 naive：旧 Range 必须被摘掉，否则会停在错误偏移上
    text = 'naive';
    controller.annotateSubtree(node);
    await tick();
    expect(highlight.total()).toBe(1);
  });

  it('文本节点改为空时摘掉旧 Range', async () => {
    const highlight = trackingHighlight();
    let text = 'run';
    const node = {
      nodeType: 3,
      get textContent() {
        return text;
      },
    } as unknown as Node;
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: () => [],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      underlineCount: (word) => (word === 'run' ? 1 : undefined),
    });
    const controller = createController(h.env);
    controller.annotateSubtree(node);
    expect(highlight.total()).toBe(1);

    text = '';
    controller.annotateSubtree(node);

    expect(highlight.total()).toBe(0);
  });

  it('文本节点改为无生词候选时摘掉旧 Range', async () => {
    const highlight = trackingHighlight();
    let text = 'run';
    const node = {
      nodeType: 3,
      get textContent() {
        return text;
      },
    } as unknown as Node;
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: () => [],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      underlineCount: (word) => (word === 'run' ? 1 : undefined),
    });
    const controller = createController(h.env);
    controller.annotateSubtree(node);
    expect(highlight.total()).toBe(1);

    text = 'naive';
    controller.annotateSubtree(node);

    expect(highlight.total()).toBe(0);
  });

  it('点"已掌握"后该词的下划线立刻消失（FR-A6 × FR-A10）', async () => {
    const highlight = trackingHighlight();
    const node = textNode('run');
    let cached: { status: WordStatus; meetCount: number } = {
      status: 'new',
      meetCount: 1,
    };
    // 生词集合里有没有它，决定画不画下划线：改状态后入口层会把它从集合里移掉
    let inUnderlineSet = true;
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: () => [node],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      cachedState: () => cached,
      underlineCount: () => (inUnderlineSet ? cached.meetCount : undefined),
      // 模拟入口层：后台确认后更新缓存与集合，控制器随后重扫
      setStatus: async (_word, status) => {
        cached = { status, meetCount: 1 };
        inUnderlineSet = status === 'new';
        return cached;
      },
    });

    const controller = createController(h.env);
    await controller.start();
    await tick();
    expect(highlight.total()).toBe(1);

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    await controller.handleSelection();
    h.clickAction('mark-known');
    await tick();

    expect(highlight.total()).toBe(0);
  });
});

describe('R1：设置快照热更新', () => {
  it('updateSettings 替换设置快照，并在运行中重扫标注', async () => {
    const highlight = trackingHighlight();
    let text = 'run';
    const node = {
      nodeType: 3,
      get textContent() {
        return text;
      },
    } as unknown as Node;
    const h = harness({
      highlight: highlight.env,
      collectTextNodes: () => [node],
      readText: (n) => (n as unknown as { textContent: string }).textContent,
      underlineCount: (word) => (word === 'run' ? 1 : undefined),
    });
    const controller = createController(h.env);
    await controller.start();
    expect(highlight.total()).toBe(1);

    text = 'naive';
    const next = { ...h.env.settings, underlineColor: '#123456' };
    controller.updateSettings(next);

    expect(h.env.settings).toBe(next);
    expect(highlight.total()).toBe(0);
  });
});

describe('FR-A6：六个操作按钮的行为', () => {
  /** 打开一个命中卡片的弹窗 */
  async function openOn(h: Harness, word = 'run') {
    const controller = createController(h.env);
    await controller.start();
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf(word));
    await controller.handleSelection();
    expect(h.popupVisible()).toBe(true);
    return controller;
  }

  it('六个操作在按钮层都接线了（setActionHandler 被调用过）', async () => {
    const h = harness();
    await openOn(h);
    expect(h.popupHasHandler()).toBe(true);
  });

  it('主按钮按当前状态二选一：new → 已掌握', async () => {
    const h = harness();
    await openOn(h);
    expect(h.card()!.meta.status).toBe('new');
  });

  it('点"已掌握"：改状态、弹窗不关闭、卡片就地切到"改回生词"', async () => {
    const h = harness();
    await openOn(h);

    h.clickAction('mark-known');
    await tick();

    expect(h.setStatus).toHaveBeenCalledWith('run', 'known');
    // FR-A6：状态变更后弹窗**不关闭**，主按钮就地切换文案
    expect(h.popupVisible()).toBe(true);
    expect(h.updated).toHaveLength(1);
    expect(h.card()!.meta.status).toBe('known');
  });

  it('点"改回生词"：改回 new，弹窗仍不关闭', async () => {
    const h = harness();
    h.setStatus.mockResolvedValue({ status: 'new', meetCount: 3 });
    await openOn(h);

    h.clickAction('mark-new');
    await tick();

    expect(h.setStatus).toHaveBeenCalledWith('run', 'new');
    expect(h.popupVisible()).toBe(true);
    expect(h.card()!.meta.status).toBe('new');
    expect(h.card()!.meta.meetCount).toBe(3);
  });

  it('点"忽略"：改状态 + 关闭弹窗（FR-A6 的"忽略后弹窗关闭"）', async () => {
    const h = harness();
    h.setStatus.mockResolvedValue({ status: 'ignored', meetCount: 1 });
    await openOn(h);

    h.clickAction('ignore');
    await tick();

    expect(h.setStatus).toHaveBeenCalledWith('run', 'ignored');
    expect(h.popupVisible()).toBe(false);
  });

  it('点"发音"：用词条原形调 speak', async () => {
    const h = harness();
    await openOn(h);

    h.clickAction('speak');
    await tick();

    expect(h.env.speak).toHaveBeenCalledWith('run');
  });

  /**
   * FR-I2：语速改动要能"下一次发音即生效"。
   *
   * 控制器不持 `Speech` 对象、只持它暴露的能力，因此这条链路是
   * `controller.setSpeechRate` → `env.setSpeechRate` →（真实实现里）`speech.setRate`。
   * 中间任意一段断开，表现都是"设置页改了语速但朗读速度没变"——不报错的那种坏。
   */
  it('FR-I2：setSpeechRate 把语速转交给发音实现', () => {
    const setSpeechRate = vi.fn();
    const h = harness({ setSpeechRate });
    const controller = createController(h.env);

    controller.setSpeechRate(1.5);

    expect(setSpeechRate).toHaveBeenCalledWith(1.5);
  });

  it('点"复制释义"：把纯文本释义交给剪贴板（不含 HTML）', async () => {
    const h = harness();
    await openOn(h);

    h.clickAction('copy-definition');
    await tick();

    expect(h.env.copyText).toHaveBeenCalledTimes(1);
    const text = (h.env.copyText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(text).toContain('run');
    expect(text).toContain('释义');
    expect(text).not.toContain('<');
  });

  it('点"管理台"：调 openManager', async () => {
    const h = harness();
    await openOn(h);

    h.clickAction('open-manager');
    await tick();

    expect(h.env.openManager).toHaveBeenCalledTimes(1);
  });

  it('FR-B4：点「LLM 释义」后只请求一次，并把释义就地填进未收录卡片', async () => {
    const defineWord = vi.fn(async () => ({ defZh: ['n. 测试；示例'] }));
    const h = harness({ defineWord });
    await openOn(h, 'learni');
    expect(h.card()!.unlisted).toBe(true);

    h.clickAction('llm-define');
    await tick();

    expect(defineWord).toHaveBeenCalledWith('learni');
    expect(defineWord).toHaveBeenCalledTimes(1);
    expect(h.card()!.senses?.flatMap((sense) => sense.defZh)).toContain('n. 测试；示例');
    expect(h.card()!.definitionError).toBeNull();
  });

  it('FR-B4：LLM 失败保留未收录卡片并显示可见错误', async () => {
    const defineWord = vi.fn(async () => ({ error: 'HTTP 401' }));
    const h = harness({ defineWord });
    await openOn(h, 'learni');

    h.clickAction('llm-define');
    await tick();

    expect(h.card()!.unlisted).toBe(true);
    expect(h.card()!.definitionError).toBe('HTTP 401');
  });

  it('改状态不计遇见次数（点"已掌握"不是又遇见了一次）', async () => {
    const h = harness();
    await openOn(h);
    expect(h.recordMeet).toHaveBeenCalledTimes(1);

    h.clickAction('mark-known');
    await tick();

    expect(h.recordMeet).toHaveBeenCalledTimes(1);
  });

  it('状态写失败（后台不可达）时不谎报成功：卡片不变、弹窗不关', async () => {
    const h = harness();
    h.setStatus.mockResolvedValue(undefined);
    await openOn(h);

    h.clickAction('mark-known');
    await tick();

    expect(h.popupVisible()).toBe(true);
    expect(h.updated).toHaveLength(0);
    expect(h.card()!.meta.status).toBe('new');
  });
});

describe('stop：停止后不再响应', () => {
  it('stop 后划词不弹', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    controller.stop();
    expect(controller.isRunning()).toBe(false);

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    expect(await controller.handleSelection()).toBeNull();
  });

  it('stop 会解绑所有事件（不再因事件而弹）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();
    controller.stop();

    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf('run'));
    h.fire('mouseup');
    expect(h.shown).toHaveLength(0);
  });

  it('stop 可重复调用', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();
    controller.stop();
    expect(() => controller.stop()).not.toThrow();
  });
});

/**
 * FR-C1：例句随记账送出，并在段四就地显示。
 *
 * 这里的重点不是"切句对不对"（在 `sentence.test.ts` / `scene.test.ts` 里验），
 * 而是**接线的两条边界**：① 没有例句时记账内容与旧逻辑逐字段一致；
 * ② 例句采集出任何问题都不得影响划词主链路（弹窗、记账、状态）。
 */
describe('FR-C1：例句随记账送出', () => {
  const scene = {
    text: 'He ran fast.',
    highlightFrom: 3,
    highlightTo: 6,
    sourceUrl: 'https://example.com/read/1',
    sourceTitle: 'Example',
  };

  const select = (h: Harness, word: string): void => {
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf(word));
  };

  it('捕获到例句时记账内容带上它', async () => {
    const h = harness({ captureScene: () => scene });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();

    expect(h.recordMeet).toHaveBeenCalledWith(expect.objectContaining({ lemma: 'run', scene }));
  });

  it('捕获返回 null 时记账内容**不带** scene（与没有例句采集时一致）', async () => {
    const h = harness({ captureScene: () => null });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();

    const arg = h.recordMeet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(arg, 'scene')).toBe(false);
    expect(h.recordMeet).toHaveBeenCalledWith({
      lemma: 'run',
      surface: 'run',
      unlisted: false,
      dict: { phoneticUs: '/run/', pos: ['v.'], defZh: ['释义'] },
      inflectionOf: null,
    });
  });

  it('没接 captureScene 时同样不带 scene（默认路径不变）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();

    const arg = h.recordMeet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(arg, 'scene')).toBe(false);
  });

  it('捕获抛错也不影响划词：照旧弹窗、照旧记账', async () => {
    const h = harness({
      captureScene: () => {
        throw new Error('切句炸了');
      },
    });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();

    expect(h.shown).toHaveLength(1);
    expect(h.recordMeet).toHaveBeenCalledTimes(1);
  });

  it('收藏之后段四显示刚采集的那一句（带来源域名）', async () => {
    const h = harness({ captureScene: () => scene });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();
    h.clickAction('collect');
    // 真实接线里是入口拿到后台回写的状态后调 applyState（见 entrypoints/content.ts）
    controller.applyState('run', { status: 'new', meetCount: 1 });

    const card = h.card();
    expect(card?.examples[0]?.text).toBe('He ran fast.');
    expect(card?.examples[0]?.source).toBe('example.com');
  });

  /**
   * 用户实测：「划词并加入生词的时候，似乎并没有触发例句的增加」。
   *
   * 这条锁的是**用户点「加入生词本」那一下**传出去的记录必须带例句——
   * 只测"划词时 record 带 scene"不够，收藏是另一条调用点（handleAction）。
   */
  it('点「加入生词本」时传给写库的记录必须带例句（FR-C1 用户实测）', async () => {
    const h = harness({
      captureScene: () => scene,
      // 默认夹具把所有词都当"已在生词本"，这里要复现"未收藏"的真实起点
      cachedState: () => undefined,
      underlineCount: () => undefined,
      ensureStates: async () => false,
    });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'zzzz');
    await controller.handleSelection();
    await tick();
    // 未收藏的词：划词本身不写库（默认不自动收藏）
    expect(h.recordMeet).not.toHaveBeenCalled();

    h.clickAction('collect');
    await tick();

    expect(h.recordMeet).toHaveBeenCalledTimes(1);
    const arg = h.recordMeet.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({ lemma: 'zzzz', unlisted: true, scene });
  });

  it('同一句重复回写不会出现两行', async () => {
    const h = harness({ captureScene: () => scene });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();
    h.clickAction('collect');
    controller.applyState('run', { status: 'new', meetCount: 1 });
    controller.applyState('run', { status: 'new', meetCount: 2 });

    const card = h.card();
    expect(card?.examples.filter((e) => e.text === 'He ran fast.')).toHaveLength(1);
  });

  it('没有例句时段四保持空（不凭空造一行）', async () => {
    const h = harness({ captureScene: () => null });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();
    h.clickAction('collect');
    controller.applyState('run', { status: 'new', meetCount: 1 });

    expect(h.card()?.examples).toEqual([]);
  });
});

/**
 * FR-A5 ④段：卡片补拉"首次日期 + 首条例句"。
 *
 * 这条通道是**可选依赖**：不注入 `fetchCard` 时卡片行为与本轮之前完全一致，
 * 因此这里有专门一条用例锁住"没接就不拉、显示保持不变"。
 */
describe('FR-A5 ④段：卡片补拉首次日期与首条例句', () => {
  const detail = {
    firstSeenAt: 1_700_000_000_000,
    examples: [{ text: 'Earlier sentence.', source: 'early.example.com', at: 1600 }],
  };
  const scene = {
    text: 'He ran fast.',
    highlightFrom: 3,
    highlightTo: 6,
    sourceUrl: 'https://example.com/a',
    sourceTitle: 'Example',
  };

  const select = (h: Harness, word: string): void => {
    (h as unknown as { setSelection(s: SelectionLike): void }).setSelection(selectionOf(word));
  };

  it('已在生词本里时拉一次，并把首次日期与首条例句补进段四', async () => {
    const h = harness({ fetchCard: async () => detail });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();
    await tick();

    expect(h.card()?.meta.firstSeenAt).toBe(detail.firstSeenAt);
    expect(h.card()?.examples[0]?.text).toBe('Earlier sentence.');
    expect(h.card()?.examples[0]?.source).toBe('early.example.com');
  });

  it('未入库的词不拉（没有例句可显示，问了也是白问）', async () => {
    const h = harness({ cachedState: () => undefined, fetchCard: async () => detail });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();
    await tick();

    expect(h.card()?.examples).toEqual([]);
  });

  it('刚采集的那句与后台回来的同一条时不会变成两行', async () => {
    const h = harness({
      captureScene: () => scene,
      fetchCard: async () => ({
        firstSeenAt: 123,
        examples: [{ text: scene.text, source: 'example.com', at: 5 }],
      }),
    });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();
    h.clickAction('collect');
    controller.applyState('run', { status: 'new', meetCount: 1 });
    await tick();

    expect(h.card()?.examples.filter((e) => e.text === scene.text)).toHaveLength(1);
  });

  it('拉不到时保持原样：不改状态、不关弹窗', async () => {
    const h = harness({ fetchCard: async () => undefined });
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();
    await tick();

    expect(h.card()?.examples).toEqual([]);
    expect(h.card()?.meta.firstSeenAt).toBeNull();
    expect(h.popupVisible()).toBe(true);
  });

  it('没接 fetchCard 时行为与之前一致（首次日期仍为 null）', async () => {
    const h = harness();
    const controller = createController(h.env);
    await controller.start();

    select(h, 'run');
    await controller.handleSelection();
    await tick();

    expect(h.card()?.meta.firstSeenAt).toBeNull();
    expect(h.card()?.examples).toEqual([]);
  });
});
