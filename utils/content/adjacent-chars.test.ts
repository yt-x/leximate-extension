/**
 * `adjacentChars`：选区带空白时的边界取值（FR-A16，用户实测反馈）。
 *
 * @vitest-environment jsdom
 *
 * 为什么单独一个文件：`controller.test.ts` 跑在 Node 环境（它测的是行为契约，
 * 不碰真 DOM）。这个函数要吃真实的 `Range`，必须 jsdom。
 *
 * 是它导致了用户说的「多划一个空格就不触发」：
 * 页面 `an adventure story`，拖选成 `"adventure "` 时 `range.endOffset`
 * 落在空格之后，直接取 `endText[endOffset]` 会得到 `'s'`，
 * 于是判成"切在词中间"、整次划词被拒。
 */
import { describe, expect, it } from 'vitest';

import { adjacentChars } from './controller';

function textNode(text: string): Text {
  const node = document.createTextNode(text);
  document.body.appendChild(node);
  return node;
}

function rangeOver(node: Text, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

describe('adjacentChars：选区多带空白时的边界判定', () => {
  it('尾部多带一个空格：after 视为干净边界（空串）', () => {
    const node = textNode('an adventure story');
    const range = rangeOver(node, 3, 13); // "adventure "
    expect(range.toString()).toBe('adventure ');
    const { before, after } = adjacentChars(range);
    expect(before).toBe(''); // 起点前是空格
    expect(after).toBe(''); // 终点后是 "s"，但选区自身以空格结尾 → 边界干净
  });

  it('头部多带一个空格：before 视为干净边界（空串）', () => {
    const node = textNode('an adventure story');
    const range = rangeOver(node, 2, 12); // " adventure"
    expect(range.toString()).toBe(' adventure');
    const { before, after } = adjacentChars(range);
    expect(before).toBe('');
    expect(after).toBe('');
  });

  it('干净选词：两端都是空格，都是空串', () => {
    const node = textNode('an adventure story');
    const range = rangeOver(node, 3, 12); // "adventure"
    const { before, after } = adjacentChars(range);
    expect(before).toBe('');
    expect(after).toBe('');
  });

  it('真·切在词中间：after 是字母，必须抓出来', () => {
    const node = textNode('an adventure story');
    const range = rangeOver(node, 3, 11); // "adventur"
    const { after } = adjacentChars(range);
    expect(after).toBe('e');
  });

  it('连字符词只选一半：after 是连字符，必须抓出来', () => {
    const node = textNode('a daisy-chain here');
    const range = rangeOver(node, 2, 7); // "daisy"
    const { after } = adjacentChars(range);
    expect(after).toBe('-');
  });

  it('撇号不是边界字符（成对引号里的整词选择要成立）', () => {
    const node = textNode("say 'proof' now");
    const range = rangeOver(node, 5, 10); // "proof"（在引号内）
    const { before, after } = adjacentChars(range);
    expect(before).toBe("'");
    expect(after).toBe("'");
  });
});
