/**
 * 选区处理的单测（PLAN.md FR-A3、FR-A4）。
 *
 * FR-A3 的验收是「原插件 issue #44 的场景可用」——即跨节点/跨换行的选择能被正确判定。
 * FR-A4 的验收是「上述区域选中不弹窗」。两条都在这里逐条锁住。
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_TAGS,
  captureSelection,
  isInIgnoredRegion,
  normalizeSelectionText,
  type NodeLike,
} from './selection';

/** 造一个最小节点链：文本节点 → 若干元素祖先 */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function el(nodeName: string, parent: NodeLike | null = null, editable = false): NodeLike {
  return {
    nodeType: ELEMENT_NODE,
    nodeName,
    parentElement: parent,
    isContentEditable: editable,
  };
}

function text(parent: NodeLike): NodeLike {
  return { nodeType: TEXT_NODE, nodeName: '#text', parentElement: parent };
}

describe('FR-A3：跨节点/跨换行的选区归一', () => {
  it('跨换行（真换行符）归一为单个空格', () => {
    // 文本节点里的真换行（源码缩进或 <pre>）会出现在 toString() 里
    expect(normalizeSelectionText('well\nknown')).toBe('well known');
  });

  it('粘在一起的跨边界文本不产生分隔符——这是 toString() 的真实行为', () => {
    // ⚠️ 反直觉但已核实：DOM stringify 算法跳过非 Text/CDATA 节点，
    // 所以 <br> 与块级边界都**贡献 0 字符**，foo<br>bar 得到 'foobar'（不是 'foo bar'）。
    // 见 docs/reference/selection-and-range.md §5.1。
    // 本函数不该"自作聪明"去猜哪里有边界——它只做空白归一，
    // 'wellknown' 这样的粘合串由判定层按超长/非法处理。
    expect(normalizeSelectionText('wellknown')).toBe('wellknown');
    expect(normalizeSelectionText('foobar')).toBe('foobar');
  });

  it('跨节点产生的连续空白压成一个', () => {
    expect(normalizeSelectionText('a\n\n\n   b')).toBe('a b');
    expect(normalizeSelectionText('  spaced   out  ')).toBe('spaced out');
  });

  it('不换行空格 \\u00A0 也是空白（网页上极常见）', () => {
    // &nbsp; 不是普通空格，不处理会让判定失败
    expect(normalizeSelectionText('run\u00A0')).toBe('run');
    expect(normalizeSelectionText('\u00A0run\u00A0')).toBe('run');
    expect(normalizeSelectionText('well\u00A0known')).toBe('well known');
  });

  it('零宽字符被删掉而不是变成空格', () => {
    // 零宽字符不占视觉位置，变成空格反而会把一个词拆成两个
    expect(normalizeSelectionText('run\u200Bning')).toBe('running');
    expect(normalizeSelectionText('\uFEFFrun')).toBe('run');
  });

  it('制表符与各类 Unicode 空白统一处理', () => {
    expect(normalizeSelectionText('a\tb')).toBe('a b');
    expect(normalizeSelectionText('a\u3000b')).toBe('a b'); // 全角空格
    expect(normalizeSelectionText('a\u2003b')).toBe('a b'); // em space
  });

  it('空选区与纯空白', () => {
    expect(normalizeSelectionText('')).toBe('');
    expect(normalizeSelectionText('   \n\t ')).toBe('');
    expect(normalizeSelectionText('\u00A0')).toBe('');
  });

  it('不改变大小写与词内字符——归一化不越权', () => {
    expect(normalizeSelectionText('Well-Known')).toBe('Well-Known');
    expect(normalizeSelectionText("don't")).toBe("don't");
    expect(normalizeSelectionText('naïve')).toBe('naïve');
  });
});

describe('FR-A4：不该触发的区域', () => {
  it('排除清单里的每个标签都被识别', () => {
    for (const tag of BLOCKED_TAGS) {
      expect(isInIgnoredRegion(text(el(tag)))).toBe(true);
    }
  });

  it('大小写不敏感（HTML 里 nodeName 通常是大写，但 SVG 是小写）', () => {
    expect(isInIgnoredRegion(text(el('textarea')))).toBe(true);
    expect(isInIgnoredRegion(text(el('Code')))).toBe(true);
  });

  it('contenteditable 祖先被识别', () => {
    const editable = el('DIV', null, true);
    expect(isInIgnoredRegion(text(editable))).toBe(true);
  });

  it('嵌套：祖先里有排除元素也算（如 div > code > text）', () => {
    const article = el('ARTICLE');
    const code = el('CODE', article);
    expect(isInIgnoredRegion(text(code))).toBe(true);
  });

  it('普通正文区域不排除', () => {
    expect(isInIgnoredRegion(text(el('P', el('ARTICLE'))))).toBe(false);
    expect(isInIgnoredRegion(text(el('DIV', el('BODY'))))).toBe(false);
    expect(isInIgnoredRegion(null)).toBe(false);
  });

  it('contenteditable="false" 不算（明确关掉编辑的区域可以标注）', () => {
    expect(isInIgnoredRegion(text(el('DIV', null, false)))).toBe(false);
  });
});

describe('FR-A3 / FR-A4：captureSelection 的组合行为', () => {
  const sel = (
    text: string,
    anchorNode: NodeLike | null,
    isCollapsed = false,
    context: { before?: string; after?: string } = {},
  ) => ({
    isCollapsed,
    text,
    anchorNode: anchorNode as Node | null,
    before: context.before ?? '',
    after: context.after ?? '',
  });

  it('正常正文选区返回归一后的文本', () => {
    const result = captureSelection(sel('  Running \n fast ', text(el('P'))));
    expect(result).toEqual({ text: 'Running fast', ignored: false, before: '', after: '' });
  });

  it('无选区时返回空', () => {
    expect(captureSelection(null)).toEqual({ text: '', ignored: false, before: '', after: '' });
    expect(captureSelection(sel('', null, true))).toEqual({ text: '', ignored: false, before: '', after: '' });
  });

  it('输入框内的选区被拦下（ignored = true）', () => {
    const result = captureSelection(sel('run', text(el('INPUT'))));
    expect(result).toEqual({ text: '', ignored: true, before: '', after: '' });
  });

  it('代码块内的选区被拦下', () => {
    const result = captureSelection(sel('const x', text(el('PRE', el('BODY')))));
    expect(result).toEqual({ text: '', ignored: true, before: '', after: '' });
  });

  it('先判区域再取文本：被拦下时不返回文本', () => {
    // 输入框里 range.toString() 也能拿到内容，但不该触发，所以 text 必须是空串
    const result = captureSelection(sel('should not surface', text(el('TEXTAREA'))));
    expect(result.text).toBe('');
    expect(result.ignored).toBe(true);
  });
});
