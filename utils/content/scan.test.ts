/**
 * 文本扫描的单测（PLAN.md FR-A9、FR-A10、FR-A12、FR-A16）。
 *
 * FR-A9 要求"标注本地生词"，前提是**能在一整段文本里正确找出词的位置**。
 * 位置错了标注就落错地方，所以这里重点锁边界与偏移。
 */
import { describe, expect, it } from 'vitest';
import {scanWords } from './scan';

/** 只留文本，便于断言 */
const texts = (input: string) => scanWords(input).map((s) => s.text);

describe('扫描：基本切分', () => {
  it('一句话里的多个词都被找出', () => {
    expect(texts('The quick brown fox')).toEqual(['The', 'quick', 'brown', 'fox']);
  });

  it('标点作为边界，不混进词里', () => {
    expect(texts('Hello, world!')).toEqual(['Hello', 'world']);
    expect(texts('(run) [go] {stop}')).toEqual(['run', 'go', 'stop']);
  });

  it('句末的点号不并入词', () => {
    expect(texts('I run.')).toEqual(['I', 'run']);
    expect(texts('version 2.0 here')).toEqual(['version', 'here']);
  });
});

describe('扫描：词内连字符与撇号不被拆开', () => {
  it('连字符词整体保留', () => {
    expect(texts('a well-known fact')).toEqual(['a', 'well-known', 'fact']);
  });

  it('缩写与所有格整体保留', () => {
    expect(texts("don't stop")).toEqual(["don't", 'stop']);
    expect(texts("it's John's")).toEqual(["it's", "John's"]);
    expect(texts("students' books")).toEqual(["students'", 'books']);
  });

  it('数字混排保留', () => {
    expect(texts('the COVID-19 and 3D era')).toEqual(['the', 'COVID-19', 'and', '3D', 'era']);
  });
});

describe('扫描：中文正文里夹的英文', () => {
  it('中文是边界，只标出英文词', () => {
    expect(texts('这是一个word测试')).toEqual(['word']);
    expect(texts('中文 English 中文')).toEqual(['English']);
  });

  it('中英混排的位置偏移正确', () => {
    const input = '中文run中文';
    const spans = scanWords(input);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ text: 'run', from: 2, to: 5 });
  });
});

describe('扫描：偏移量正确（FR-A9 标注位置依赖它）', () => {
  it('偏移能原样切回那个词', () => {
    const input = 'The quick brown fox jumps';
    for (const span of scanWords(input)) {
      expect(input.slice(span.from, span.to)).toBe(span.text);
    }
  });

  it('含连字符与撇号时偏移仍能切回', () => {
    const input = "It's a well-known fact, isn't it?";
    for (const span of scanWords(input)) {
      expect(input.slice(span.from, span.to)).toBe(span.text);
    }
  });

  it('多个词按出现顺序返回', () => {
    const spans = scanWords('one two three');
    expect(spans.map((s) => s.from)).toEqual([0, 4, 8]);
  });
});

describe('扫描：与 judgeWord 共用同一套规则', () => {
  it('纯数字不会被当成词', () => {
    expect(texts('year 2024 was')).toEqual(['year', 'was']);
  });

  it('超长游程被判定拒绝（> 45 字符）', () => {
    const long = 'a'.repeat(46);
    expect(texts(`x ${long} y`)).toEqual(['x', 'y']);
  });

  it('空文本与纯标点', () => {
    expect(scanWords('')).toEqual([]);
    expect(scanWords('   ')).toEqual([]);
    expect(scanWords('!!! ... ???')).toEqual([]);
  });
});

/*
 * ⚠️ 这里原有 4 条 `scanKnownWords` 的用例，随该函数一起删除：
 * 它编码的判据（"只留词典认识的词"）是错的——FR-A9 要按**本地生词本**判定。
 * 现在那条路径的用例在 `controller.test.ts` 的
 * 「FR-A9：下划线按生词本判定，不是按词典」一组里。
 */
