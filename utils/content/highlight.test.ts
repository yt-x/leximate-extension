/**
 * 标注的单测（PLAN.md FR-A9、FR-A10、FR-A11、FR-A12、FR-A14）。
 *
 * 用**假环境**注入 registry / Range / Highlight，因此可以在 Node 里逐条验收——
 * 真实的 `CSS.highlights` 只在浏览器里存在（可用性数据见
 * `docs/reference/css-custom-highlight.md` §2.1：Chrome 105+）。
 *
 * FR-A9 的 DOM 不变判定靠"没有 DOM 写入 API 被调用"来保证：
 * `HighlightEnv` 接口里**根本不存在**任何修改 DOM 的方法，
 * 因此这段代码在类型层面就无法改 DOM。这是比运行时断言更强的保证。
 *
 * ⚠️ 本文件的核心是 **FR-A12 的增量语义**：
 * 标注是**按节点累积**的，`annotate()` 只能替换它收到的那几个节点，
 * 绝不能把别的节点上的标注一起清掉——那正是"页面上完全看不到下划线"的根因
 * （真实页面在 `document_idle` 之后仍在不停地增删节点）。
 */
import { describe, expect, it } from 'vitest';
import type { WordStatus } from '../db/types';
import {
  createHighlightSession,
  type AnnotationResult,
  type HighlightEnv,
  type NodeSpans,
} from './highlight';
import { DEFAULT_THEME, type HighlightTheme } from './highlight-plan';

/** 假节点：本测试不需要真 DOM，只要一个身份 */
function fakeNode(label: string): Node {
  return { nodeName: label } as unknown as Node;
}

/** 假 Highlight：一个 range 集合 */
interface FakeHighlight {
  ranges: Set<unknown>;
}

interface FakeEnv extends HighlightEnv {
  registered: Map<string, FakeHighlight>;
  styles: Map<string, string>;
  addCalls: number;
  removeCalls: number;
}

/**
 * 造一个假环境。
 *
 * `badSpans` 里的区间会造 Range 失败，用来模拟"页面改写了文本节点"。
 */
function fakeEnv(badSpans: Array<{ from: number; to: number }> = []): FakeEnv {
  const registered = new Map<string, FakeHighlight>();
  const styles = new Map<string, string>();
  const env: FakeEnv = {
    registered,
    styles,
    addCalls: 0,
    removeCalls: 0,
    registry: {
      set: (name, highlight) => void registered.set(name, highlight as FakeHighlight),
      delete: (name) => registered.delete(name),
    },
    createRange(node, from, to) {
      if (badSpans.some((b) => b.from === from && b.to === to)) return null;
      return { range: { node, from, to } };
    },
    createHighlight: (ranges) => ({ ranges: new Set(ranges) }),
    addRanges(highlight, ranges) {
      env.addCalls += 1;
      const target = highlight as FakeHighlight;
      for (const range of ranges) target.ranges.add(range);
    },
    removeRanges(highlight, ranges) {
      env.removeCalls += 1;
      const target = highlight as FakeHighlight;
      for (const range of ranges) target.ranges.delete(range);
    },
    defineStyle: (name, declarations) => void styles.set(name, declarations),
    removeStyle: (name) => void styles.delete(name),
  };
  return env;
}

const theme = (patch: Partial<HighlightTheme> = {}): HighlightTheme => ({
  ...DEFAULT_THEME,
  ...patch,
});

const state = (status: WordStatus | undefined = 'new', meetCount = 1) => () =>
  status === undefined ? undefined : { status, meetCount };

/**
 * 各用例的默认入参：**所有词都是生词**。
 *
 * 必须显式给：标注会话的默认语义是"状态未知就不标"（见 `shouldAnnotate`），
 * 不给状态函数等于什么都不标——这正是 FR-A9 要的行为。
 */
const allNew = state();

/** 一个文本节点 + 它里面的词 */
function spans(node: Node, words: string[]): NodeSpans[] {
  return [{ node, spans: words.map((w) => ({ text: w, from: 0, to: w.length })) }];
}

function rangeCount(env: FakeEnv, group = 'leximate-1'): number {
  return env.registered.get(group)?.ranges.size ?? 0;
}

describe('FR-A9：注册标注，且不碰 DOM', () => {
  it('把词注册成 highlight，范围与偏移被正确传递', () => {
    const env = fakeEnv();
    const node = fakeNode('#text');
    const session = createHighlightSession(env);
    const result = session.annotate(
      [{ node, spans: [{ text: 'run', from: 4, to: 7 }] }],
      allNew,
    );

    expect(result.unavailable).toBe(false);
    expect(result.ranges).toBe(1);
    expect(result.groups).toEqual(['leximate-1']);

    const ranges = [...env.registered.get('leximate-1')!.ranges] as Array<{
      node: unknown;
      from: number;
      to: number;
    }>;
    expect(ranges).toEqual([{ node, from: 4, to: 7 }]);
  });

  it('样式规则写进 ::highlight()，可供页面绘制', () => {
    const env = fakeEnv();
    createHighlightSession(env).annotate(spans(fakeNode('#text'), ['run']), allNew);

    expect(env.styles.get('leximate-1')).toBe(
      'text-decoration-line: underline; text-decoration-style: dotted; ' +
        'text-decoration-color: #d98b2b; text-decoration-thickness: 1px',
    );
  });

  it('新增节点用 addRanges 并入既有组，而不是重建注册项', () => {
    const env = fakeEnv();
    const session = createHighlightSession(env);

    session.annotate(spans(fakeNode('#a'), ['run']), allNew);
    const before = env.registered.get('leximate-1');

    session.annotate(spans(fakeNode('#b'), ['go']), allNew);

    // 同一个 Highlight 对象被继续使用（注册项没被换掉）
    expect(env.registered.get('leximate-1')).toBe(before);
    expect(rangeCount(env)).toBe(2);
    expect(env.addCalls).toBeGreaterThan(0);
  });
});

/**
 * FR-A12：增量标注的**核心不变式**。
 *
 * 旧实现每次调用都先 `CSS.highlights` 全局清空，再只注册"本次传入的子树"。
 * 于是页面任何一处 DOM 变更（广告位、懒加载、SPA 水合、时间戳刷新）都会
 * 把已经画好的全页下划线抹掉，只留下刚变的那个子树——
 * 用户的实际观感就是"完全没渲染下划线"。
 */
describe('FR-A12：增量标注只动自己收到的那几个节点', () => {
  it('标注新节点不会清掉旧节点的标注', () => {
    const env = fakeEnv();
    const session = createHighlightSession(env);
    const first = fakeNode('#first');

    session.annotate(spans(first, ['run', 'go']), allNew);
    expect(rangeCount(env)).toBe(2);

    session.annotate(spans(fakeNode('#second'), ['see']), allNew);

    // 第一个节点的两条都还在（总数 3）
    expect(rangeCount(env)).toBe(3);
  });

  it('同一个节点再次标注时替换它自己的 ranges，不影响别的节点', () => {
    const env = fakeEnv();
    const session = createHighlightSession(env);
    const target = fakeNode('#target');
    const other = fakeNode('#other');

    session.annotate(spans(other, ['keep']), allNew);
    session.annotate(spans(target, ['run']), allNew);
    expect(rangeCount(env)).toBe(2);

    // 用户把这个词标成已掌握：重新标注同一个节点
    const result = session.annotate(spans(target, ['run']), state('known'));
    expect(result.ranges).toBe(0);
    // 目标节点的那一条被摘掉了，别的节点的仍在
    expect(rangeCount(env)).toBe(1);

    // 再改回生词：它回来，且仍然不影响别的节点
    session.annotate(spans(target, ['run']), allNew);
    expect(rangeCount(env)).toBe(2);
  });

  it('状态改为 known 后该节点的 range 被移除，组里空了就摘掉注册项', () => {
    const env = fakeEnv();
    const session = createHighlightSession(env);
    const node = fakeNode('#text');

    session.annotate(spans(node, ['run']), state('new'));
    expect(env.registered.size).toBe(1);

    session.annotate(spans(node, ['run']), state('known'));

    expect(env.registered.size).toBe(0);
    expect(env.styles.size).toBe(0);
  });

  it('clearAll 清掉全部自有标注与样式', () => {
    const env = fakeEnv();
    const session = createHighlightSession(env);

    session.annotate(spans(fakeNode('#a'), ['run']), allNew);
    session.annotate(spans(fakeNode('#b'), ['go']), allNew);

    session.clearAll();

    expect(env.registered.size).toBe(0);
    expect(env.styles.size).toBe(0);
    expect(session.nodeCount()).toBe(0);
  });

  it('nodes 为空时不做任何事（不误伤既有标注）', () => {
    const env = fakeEnv();
    const session = createHighlightSession(env);
    session.annotate(spans(fakeNode('#a'), ['run']), allNew);

    const result: AnnotationResult = session.annotate([]);

    expect(result.ranges).toBe(0);
    expect(rangeCount(env)).toBe(1);
  });
});

describe('FR-A9：CSS.highlights 不可用时的降级', () => {
  it('不可用时整体跳过，不抛错', () => {
    const env = fakeEnv();
    env.registry = undefined;
    const logs: Array<[string, unknown]> = [];
    env.log = (event, detail) => void logs.push([event, detail]);

    const result = createHighlightSession(env).annotate(spans(fakeNode('#text'), ['run']), allNew);

    expect(result).toEqual({ groups: [], ranges: 0, skipped: 0, unavailable: true });
    expect(logs).toContainEqual(['highlight-unavailable', undefined]);
  });

  it('不可用时 clearAll 也不报错', () => {
    const env = fakeEnv();
    env.registry = undefined;
    expect(() => createHighlightSession(env).clearAll()).not.toThrow();
  });
});

describe('FR-A9：Range 失效只丢那一条，不影响其余', () => {
  it('失效的区间被计入 skipped，其余照常注册', () => {
    const env = fakeEnv([{ from: 10, to: 13 }]);
    const node = fakeNode('#text');

    const result = createHighlightSession(env).annotate(
      [
        {
          node,
          spans: [
            { text: 'run', from: 0, to: 3 },
            { text: 'bad', from: 10, to: 13 }, // 这一条会失败
          ],
        },
      ],
      allNew,
    );

    expect(result.ranges).toBe(1);
    expect(result.skipped).toBe(1);
    expect(env.registered.size).toBe(1);
  });

  it('全部失效时不注册空组', () => {
    const env = fakeEnv([{ from: 0, to: 3 }]);
    const result = createHighlightSession(env).annotate(spans(fakeNode('#text'), ['run']), allNew);

    expect(result.groups).toEqual([]);
    expect(env.registered.size).toBe(0);
  });
});

describe('FR-A10 / FR-A14：过滤与开关', () => {
  it('已掌握与忽略的词不被注册', () => {
    const env = fakeEnv();
    const statusOf = (word: string): { status: WordStatus; meetCount: number } =>
      word === 'a'
        ? { status: 'new' as WordStatus, meetCount: 1 }
        : { status: 'known' as WordStatus, meetCount: 1 };

    const result = createHighlightSession(env).annotate(
      [
        { node: fakeNode('#a'), spans: [{ text: 'a', from: 0, to: 1 }] },
        { node: fakeNode('#b'), spans: [{ text: 'b', from: 0, to: 1 }] },
      ],
      statusOf,
    );

    expect(result.ranges).toBe(1);
  });

  /**
   * 这条是"下划线该标哪些词"的**规格要害**（FR-A9 的"本地生词"）：
   * 词状态未知 = 这个词**不在生词本里**，不该被标。
   *
   * 旧实现把"查不到状态"当成 `{status:'new'}`（`UNSEEN`），于是页面上
   * **每一个词库里的词**都会被当成生词标注——这与"下划线提醒重复遇见"完全无关。
   */
  it('状态未知的词不标注（不在生词本里的词不该被标）', () => {
    const env = fakeEnv();

    const result = createHighlightSession(env).annotate(
      spans(fakeNode('#text'), ['run']),
      () => undefined,
    );

    expect(result.ranges).toBe(0);
    expect(env.registered.size).toBe(0);
  });

  it('全局开关关闭时零注册', () => {
    const env = fakeEnv();
    const result = createHighlightSession(env).annotate(
      spans(fakeNode('#text'), ['run']),
      state(),
      theme(),
      false,
    );

    expect(result.ranges).toBe(0);
    expect(env.registered.size).toBe(0);
  });
});

describe('FR-A11：按遇见次数分组注册', () => {
  it('不同档位注册成不同的组，各带自己的样式', () => {
    const env = fakeEnv();
    const statusOf = (word: string) => ({
      status: 'new' as WordStatus,
      meetCount: word === 'a' ? 1 : 5,
    });

    const result = createHighlightSession(env).annotate(
      [
        { node: fakeNode('#a'), spans: [{ text: 'a', from: 0, to: 1 }] },
        { node: fakeNode('#b'), spans: [{ text: 'b', from: 0, to: 1 }] },
      ],
      statusOf,
      theme({ reflectMeetCount: true }),
    );

    expect(result.groups).toEqual(['leximate-1', 'leximate-5']);
    expect(env.styles.get('leximate-1')).toContain('1px');
    expect(Number(/([\d.]+)px/.exec(env.styles.get('leximate-5')!)![1])).toBeGreaterThan(1);
  });

  it('不按次数变化时只注册一组', () => {
    const env = fakeEnv();
    const statusOf = (word: string) => ({
      status: 'new' as WordStatus,
      meetCount: word === 'a' ? 1 : 5,
    });

    const result = createHighlightSession(env).annotate(
      [
        { node: fakeNode('#a'), spans: [{ text: 'a', from: 0, to: 1 }] },
        { node: fakeNode('#b'), spans: [{ text: 'b', from: 0, to: 1 }] },
      ],
      statusOf,
      theme({ reflectMeetCount: false }),
    );

    expect(result.groups).toEqual(['leximate-1']);
    expect(result.ranges).toBe(2);
  });
});
