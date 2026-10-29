/**
 * 标注决策与样式的单测（PLAN.md FR-A10、FR-A11、FR-A14）。
 *
 * 三条规格的验收判定都在这里：
 * - FR-A10：只标 `status = new`，known/ignored 不标
 * - FR-A11：样式可配置；按次数变化时要真的产生不同样式
 * - FR-A14：全局开关关闭时零标注
 */
import { describe, expect, it } from 'vitest';
import type { UnderlineStyle, WordStatus } from '../db/types';
import {
  DEFAULT_THEME,
  groupForHighlight,
  highlightDeclarations,
  meetCountTier,
  shouldAnnotate,
  type AnnotateCandidate,
  type HighlightTheme,
} from './highlight-plan';
import type { WordSpan } from './scan';

function span(text: string, from = 0): WordSpan {
  return { text, from, to: from + text.length };
}

function candidate(
  text: string,
  status: WordStatus = 'new',
  meetCount = 1,
): AnnotateCandidate {
  return { span: span(text), status, meetCount };
}

const theme = (patch: Partial<HighlightTheme> = {}): HighlightTheme => ({
  ...DEFAULT_THEME,
  ...patch,
});

describe('FR-A10：只标注生词', () => {
  it('shouldAnnotate 只对 new 为真', () => {
    expect(shouldAnnotate('new')).toBe(true);
    expect(shouldAnnotate('known')).toBe(false);
    expect(shouldAnnotate('ignored')).toBe(false);
  });

  it('分组时已知/忽略的词被排除', () => {
    const groups = groupForHighlight(
      [candidate('a', 'new'), candidate('b', 'known'), candidate('c', 'ignored')],
      theme(),
    );
    expect(groups.flatMap((g) => g.spans.map((s) => s.text))).toEqual(['a']);
  });

  it('全部是已掌握时没有组（页面重载后下划线消失的机制）', () => {
    const groups = groupForHighlight([candidate('a', 'known'), candidate('b', 'known')], theme());
    expect(groups).toEqual([]);
  });
});

describe('FR-A14：全局开关', () => {
  it('关闭时零标注', () => {
    const groups = groupForHighlight([candidate('a')], theme(), false);
    expect(groups).toEqual([]);
  });

  it('开启时正常标注', () => {
    const groups = groupForHighlight([candidate('a')], theme(), true);
    expect(groups).toHaveLength(1);
  });

  it('关闭优先于其它一切设置', () => {
    const groups = groupForHighlight(
      [candidate('a', 'new', 5)],
      theme({ reflectMeetCount: true, style: 'wavy' }),
      false,
    );
    expect(groups).toEqual([]);
  });
});

describe('FR-A11：样式可配置', () => {
  it('三种线型都反映到 CSS 里', () => {
    for (const style of ['dotted', 'solid', 'wavy'] as UnderlineStyle[]) {
      const decl = highlightDeclarations(theme({ style }));
      expect(decl).toContain(`text-decoration-style: ${style}`);
    }
  });

  it('线型为 none 时不产生任何声明（而不是写成 none）', () => {
    // 写成 `text-decoration-line: none` 语义反了：那是"清除下划线"，不是"不标注"
    const decl = highlightDeclarations(theme({ style: 'none' }));
    expect(decl).toBe('');
    expect(groupForHighlight([candidate('a')], theme({ style: 'none' }))).toEqual([]);
  });

  it('颜色与粗细进入声明', () => {
    const decl = highlightDeclarations(theme({ color: '#ff0000', thickness: 2 }));
    expect(decl).toContain('text-decoration-color: #ff0000');
    expect(decl).toContain('text-decoration-thickness: 2px');
  });

  it('用四个长属性而非 text-decoration 简写（简写顺序未能核实）', () => {
    const decl = highlightDeclarations(theme());
    expect(decl).toContain('text-decoration-line: underline');
    expect(decl).toContain('text-decoration-style:');
    expect(decl).toContain('text-decoration-color:');
    expect(decl).toContain('text-decoration-thickness:');
    // 不应出现简写形式
    expect(decl).not.toMatch(/text-decoration:/);
  });
});

describe('FR-A11：按遇见次数变化', () => {
  it('次数分五档', () => {
    expect(meetCountTier(0)).toBe(1);
    expect(meetCountTier(1)).toBe(1);
    expect(meetCountTier(2)).toBe(2);
    expect(meetCountTier(3)).toBe(3);
    expect(meetCountTier(4)).toBe(4);
    expect(meetCountTier(5)).toBe(5);
    expect(meetCountTier(99)).toBe(5); // 5 及以上同档
  });

  it('不按次数变化时，所有词合成一组且粗细一致', () => {
    const groups = groupForHighlight(
      [candidate('a', 'new', 1), candidate('b', 'new', 5)],
      theme({ reflectMeetCount: false }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.spans).toHaveLength(2);
  });

  it('按次数变化时，不同档位分成不同组，且粗细递增', () => {
    const groups = groupForHighlight(
      [candidate('a', 'new', 1), candidate('b', 'new', 3), candidate('c', 'new', 5)],
      theme({ reflectMeetCount: true, thickness: 1 }),
    );
    expect(groups.map((g) => g.name)).toEqual(['leximate-1', 'leximate-3', 'leximate-5']);
    // 粗细确实递增
    const widths = groups.map((g) => Number(/([\d.]+)px/.exec(g.declarations)![1]));
    expect(widths[0]!).toBeLessThan(widths[1]!);
    expect(widths[1]!).toBeLessThan(widths[2]!);
  });

  it('同档的词合进同一组（注册项数量受控）', () => {
    const groups = groupForHighlight(
      [candidate('a', 'new', 5), candidate('b', 'new', 7), candidate('c', 'new', 100)],
      theme({ reflectMeetCount: true }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.spans).toHaveLength(3);
  });

  it('组名稳定，便于测试与排查', () => {
    const groups = groupForHighlight([candidate('a', 'new', 2)], theme({ reflectMeetCount: true }));
    expect(groups[0]!.name).toBe('leximate-2');
  });
});

describe('分组：空输入与顺序', () => {
  it('空候选返回空数组', () => {
    expect(groupForHighlight([], theme())).toEqual([]);
  });

  it('组按档位升序返回（输出稳定）', () => {
    const groups = groupForHighlight(
      [candidate('a', 'new', 5), candidate('b', 'new', 1)],
      theme({ reflectMeetCount: true }),
    );
    expect(groups.map((g) => g.name)).toEqual(['leximate-1', 'leximate-5']);
  });

  it('每组保留词的原始偏移（标注要用）', () => {
    const groups = groupForHighlight([{ span: span('run', 10), status: 'new', meetCount: 1 }], theme());
    expect(groups[0]!.spans[0]).toEqual({ text: 'run', from: 10, to: 13 });
  });
});
