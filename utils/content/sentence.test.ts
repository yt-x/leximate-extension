/**
 * 例句切句与清洗的单测（PLAN.md FR-C1 / FR-C2 的实现口径）。
 *
 * 这一层是纯函数：切句规则最容易"看起来对、实际错一格"，
 * 所以每条规则都配一个**能算出偏移**的例子，而不只断言文本。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_AFTER,
  CONTEXT_BEFORE,
  MAX_SENTENCE_CHARS,
  applyWindow,
  cleanWithMap,
  extractSentence,
  isSentenceEnd,
  sentenceBounds,
} from './sentence';

/** 取子串用于断言：例句里的高亮范围必须正好是被划的那个词 */
function highlightOf(text: string, from: number, to: number, word: string): void {
  expect(text.slice(from, to)).toBe(word);
}

describe('FR-C1：句界判定', () => {
  it('句号后跟空格是句界', () => {
    const text = 'He went home. She stayed.';
    expect(isSentenceEnd(text, 12)).toBe(true);
  });

  it('句中（后面还有字母）不是句界', () => {
    expect(isSentenceEnd('e.g.this', 4)).toBe(false);
  });

  it('中文句号后面**没有空格**也算句界', () => {
    expect(isSentenceEnd('今天下雨了。我们待在家。', 5)).toBe(true);
  });

  it('问号与感叹号都是句界（中英）', () => {
    expect(isSentenceEnd('Why? Because.', 3)).toBe(true);
    expect(isSentenceEnd('真的吗？是的。', 3)).toBe(true);
    expect(isSentenceEnd('Run fast!', 8)).toBe(true);
  });

  it('缩写后的点不是句界', () => {
    expect(isSentenceEnd('Mr. Smith arrived.', 2)).toBe(false);
    expect(isSentenceEnd('etc. and so on.', 3)).toBe(false);
  });

  it('点分缩写（U.S. / e.g.）不是句界', () => {
    expect(isSentenceEnd('the U.S. Army', 7)).toBe(false);
    expect(isSentenceEnd('fruits, e.g. apples', 11)).toBe(false);
  });

  it('单字母缩写不是句界，但 a / i 放行', () => {
    expect(isSentenceEnd('J. K. Rowling', 1)).toBe(false);
    expect(isSentenceEnd('I saw a. Then left.', 7)).toBe(true);
  });

  it('小数与时间不算句界', () => {
    expect(isSentenceEnd('It costs 3.14 dollars.', 11)).toBe(false);
    expect(isSentenceEnd('starts 10.30 sharp', 11)).toBe(false);
  });

  it('换行也算句界（字幕/列表这类无标点文本）', () => {
    expect(isSentenceEnd('line one\nline two', 8)).toBe(true);
  });
});

describe('FR-C1：选区所在句的边界', () => {
  it('取到选区所在的那一句', () => {
    const text = 'He went home. She stayed.';
    expect(sentenceBounds(text, 8, 12)).toEqual({ start: 0, end: 13 });
  });

  it('缩写不会被当成分句点', () => {
    const text = 'Mr. Smith arrived. He sat.';
    expect(sentenceBounds(text, 10, 17)).toEqual({ start: 0, end: 18 });
  });

  it('中文按全角句号切', () => {
    const text = '今天下雨了。我们待在家。';
    expect(sentenceBounds(text, 6, 8)).toEqual({ start: 6, end: 12 });
  });

  it('句末的引号算同一句', () => {
    const text = 'He said "go home." Then left.';
    expect(sentenceBounds(text, 12, 16)).toEqual({ start: 0, end: 18 });
  });

  it('没有标点时整段为一句', () => {
    const text = 'no punctuation here';
    expect(sentenceBounds(text, 3, 14)).toEqual({ start: 0, end: text.length });
  });

  it('换行切开（不把两行粘成一句）', () => {
    const text = 'line one\nline two\nline three';
    expect(sentenceBounds(text, 14, 17)).toEqual({ start: 9, end: 17 });
  });
});

describe('FR-C2：清洗与偏移映射', () => {
  it('连续空白压成一个，零宽字符删除', () => {
    const cleaned = cleanWithMap('  He  ran\u200B   fast.  ');
    expect(cleaned.text).toBe('He ran fast.');
  });

  it('压缩空白后偏移仍然指向被划的词', () => {
    const text = 'He  ran\u200B fast.';
    const capture = extractSentence(text, 9, 13);
    expect(capture).not.toBeNull();
    highlightOf(capture?.text ?? '', capture?.highlightFrom ?? 0, capture?.highlightTo ?? 0, 'fast');
  });

  it('不换行空格（&nbsp;）同样被归一', () => {
    const text = 'He\u00A0ran fast.';
    const capture = extractSentence(text, 3, 6);
    highlightOf(capture?.text ?? '', capture?.highlightFrom ?? 0, capture?.highlightTo ?? 0, 'ran');
    expect(capture?.text).toBe('He ran fast.');
  });

  it('行首空白不进入例句（trimStart）', () => {
    const text = '   Indented sentence.';
    const capture = extractSentence(text, 3, 11);
    expect(capture?.text).toBe('Indented sentence.');
    highlightOf(capture?.text ?? '', capture?.highlightFrom ?? 0, capture?.highlightTo ?? 0, 'Indented');
  });
});

describe('FR-C2：500 字符上限', () => {
  it('不超限时原样返回', () => {
    const result = applyWindow('abc def', 4, 7);
    expect(result).toEqual({ text: 'abc def', highlightFrom: 4, highlightTo: 7 });
  });

  it('超限时窗口以高亮词为中心，词一定还在文本里', () => {
    const word = 'targetword';
    const text = `${'a'.repeat(400)} ${word} ${'b'.repeat(400)}`;
    const from = text.indexOf(word);
    const capture = extractSentence(text, from, from + word.length);

    expect(capture).not.toBeNull();
    expect((capture?.text.length ?? 0)).toBeLessThanOrEqual(MAX_SENTENCE_CHARS + 2);
    highlightOf(capture?.text ?? '', capture?.highlightFrom ?? 0, capture?.highlightTo ?? 0, word);
  });

  it('词在句子末尾时窗口向右平移，不把词切掉', () => {
    const word = 'tailword';
    const text = `${'c'.repeat(900)} ${word}`;
    const from = text.indexOf(word);
    const capture = extractSentence(text, from, from + word.length);

    highlightOf(capture?.text ?? '', capture?.highlightFrom ?? 0, capture?.highlightTo ?? 0, word);
    expect(capture?.text.startsWith('…')).toBe(true);
  });

  it('被截断的一端带省略号，没截断的一端不带', () => {
    const text = `${'d'.repeat(900)} word`;
    const from = text.indexOf('word');
    const capture = extractSentence(text, from, from + 4);
    expect(capture?.text.startsWith('…')).toBe(true);
    expect(capture?.text.endsWith('word')).toBe(true);
    expect(capture?.text.endsWith('…')).toBe(false);
  });

  it('窗口参数是 200 / 300（口径写在 PLAN §1.C）', () => {
    expect(CONTEXT_BEFORE).toBe(200);
    expect(CONTEXT_AFTER).toBe(300);
  });
});

describe('正常结果就是"没有例句"的几种情况', () => {
  it('空容器文本 → null', () => {
    expect(extractSentence('', 0, 0)).toBeNull();
  });

  it('空选区 → null', () => {
    expect(extractSentence('He ran.', 3, 3)).toBeNull();
  });

  it('越界下标被夹紧而不是抛错', () => {
    const capture = extractSentence('He ran fast.', 3, 999);
    expect(capture).not.toBeNull();
  });

  it('全是空白与零宽字符 → null', () => {
    expect(extractSentence('  \u200B  ', 1, 3)).toBeNull();
  });
});
