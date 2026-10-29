/**
 * 单词判定单测（PLAN.md FR-A2、FR-A16）。
 *
 * FR-A16 的验收判定是「规则表逐条有单元测试」，因此本文件按**规则表的行**组织用例，
 * 一行一组，逐条对上。FR-A2 点名的四类形态各自有用例。
 */
import { describe, expect, it } from 'vitest';
import {
  isWholeWordSelection,
  judgeWord,
  lookupCandidates,
  MAX_WORD_LENGTH,
  normalizeForLookup,
  stripDiacritics,
} from './word';

/**
 * FR-A16 的「完整性」行：选区必须**覆盖整个词**。
 *
 * 判据是选区两端紧邻的字符——用户在 `proof` 里只拖到 `proo`，
 * 终点后一个字符是 `f`（词字符）→ 这不是"选中了一个词"。
 */
describe('FR-A16 完整性：选区必须覆盖整个词', () => {
  it('两端都是空白/标点 → 完整', () => {
    expect(isWholeWordSelection(' ', ' ')).toBe(true);
    expect(isWholeWordSelection('', '')).toBe(true);
    expect(isWholeWordSelection('(', ')')).toBe(true);
    expect(isWholeWordSelection('.', ',')).toBe(true);
  });

  it('前面还有词字符 → 是词的后半段（不完整）', () => {
    expect(isWholeWordSelection('o', '')).toBe(false); // 从 proof 里选了 of
    expect(isWholeWordSelection('3', ' ')).toBe(false); // 3D 里选了 D
  });

  it('后面还有词字符 → 是词的前半段（不完整）', () => {
    // 用户报告的形态：proof 里只拖到 proo
    expect(isWholeWordSelection(' ', 'f')).toBe(false);
    expect(isWholeWordSelection('', 'f')).toBe(false);
  });

  it('词内连字符也算词字符（well-known 里选 well 是半截）', () => {
    expect(isWholeWordSelection(' ', '-')).toBe(false);
    expect(isWholeWordSelection('-', ' ')).toBe(false);
  });

  it('撇号**不算**边界字符：带引号的整词选择必须成立', () => {
    // 'proof' / “proof” 这几种写法都要能被完整选中
    expect(isWholeWordSelection("'", "'")).toBe(true);
    expect(isWholeWordSelection('“', '”')).toBe(true);
    // 选到 students 而撇号留在选区外（students' 的所有格），仍算完整
    expect(isWholeWordSelection(' ', "'")).toBe(true);
  });

  it('中文/日文等非拉丁字符是边界（中文正文里夹的英文单词要能选）', () => {
    expect(isWholeWordSelection('中', '文')).toBe(true);
  });
});

describe('FR-A2：四类放宽形态都能弹出', () => {
  it('连字符词 well-known', () => {
    expect(judgeWord('well-known')).toEqual({ ok: true, word: 'well-known' });
  });

  it('缩写 don\'t / it\'s', () => {
    expect(judgeWord("don't")).toEqual({ ok: true, word: "don't" });
    expect(judgeWord("it's")).toEqual({ ok: true, word: "it's" });
  });

  it('所有格 students\'', () => {
    expect(judgeWord("students'")).toEqual({ ok: true, word: "students'" });
  });

  it('首字母大写词', () => {
    expect(judgeWord('London')).toEqual({ ok: true, word: 'London' });
    expect(judgeWord('Running')).toEqual({ ok: true, word: 'Running' });
  });
});

describe('FR-A16 规则表：逐行验收', () => {
  it('长度上限 45 字符，超出不弹窗', () => {
    const at45 = 'a'.repeat(MAX_WORD_LENGTH);
    const at46 = 'a'.repeat(MAX_WORD_LENGTH + 1);
    expect(judgeWord(at45).ok).toBe(true);
    expect(judgeWord(at46)).toEqual({ ok: false, reason: 'too-long' });
  });

  it('数字混排允许，但整段至少含一个字母', () => {
    // 允许：数字在词内或词尾
    expect(judgeWord('COVID-19')).toEqual({ ok: true, word: 'COVID-19' });
    expect(judgeWord('3D')).toEqual({ ok: true, word: '3D' });
    expect(judgeWord('mp3')).toEqual({ ok: true, word: 'mp3' });
    // 拒绝：纯数字。`3.14` 同时满足"含点号"与"无字母"，先报更具体的 no-letter
    expect(judgeWord('2024')).toEqual({ ok: false, reason: 'no-letter' });
    expect(judgeWord('3.14')).toEqual({ ok: false, reason: 'no-letter' });
    // 含字母但形态不合法（点号在词内）才报 not-a-word
    expect(judgeWord('version2.0')).toEqual({ ok: false, reason: 'not-a-word' });
  });

  it('连字符整体作为一个词，不做左右拆分', () => {
    const verdict = judgeWord('well-known');
    expect(verdict).toEqual({ ok: true, word: 'well-known' });
    // 不能只返回左边或右边
    if (verdict.ok) expect(verdict.word).toBe('well-known');
  });

  it('撇号整体查表，不做词尾剥离', () => {
    const verdict = judgeWord("students'");
    if (verdict.ok) expect(verdict.word).toBe("students'");
    expect(judgeWord("don't")).toEqual({ ok: true, word: "don't" });
  });

  it('明确不做短语拆分：含空格的整段不算词', () => {
    expect(judgeWord('take into account')).toEqual({ ok: false, reason: 'not-a-word' });
    expect(judgeWord('New York')).toEqual({ ok: false, reason: 'not-a-word' });
  });

  it('明确不做词干化：quickly 原样返回，不还原成 quick', () => {
    expect(judgeWord('quickly')).toEqual({ ok: true, word: 'quickly' });
  });

  it('空输入与纯空白', () => {
    expect(judgeWord('')).toEqual({ ok: false, reason: 'empty' });
    expect(judgeWord('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(judgeWord('\n\t')).toEqual({ ok: false, reason: 'empty' });
  });

  it('首尾空白会被 trim，不影响判定', () => {
    expect(judgeWord('  run  ')).toEqual({ ok: true, word: 'run' });
  });

  it('标点与符号不算词', () => {
    expect(judgeWord('—')).toEqual({ ok: false, reason: 'no-letter' });
    expect(judgeWord('!!!')).toEqual({ ok: false, reason: 'no-letter' });
    expect(judgeWord('...')).toEqual({ ok: false, reason: 'no-letter' });
  });
});

describe('FR-A16：归一化与重音符号', () => {
  it('查表统一转小写，但判定保留原形', () => {
    expect(judgeWord('London')).toEqual({ ok: true, word: 'London' });
    expect(normalizeForLookup('London')).toBe('london');
  });

  it('NFC 归一化：组合形式与预组合形式等价（仅用于查表）', () => {
    // café 的两种写法：预组合 U+00E9 与 分解 e + U+0301
    const precomposed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';
    expect(normalizeForLookup(precomposed)).toBe(normalizeForLookup(decomposed));
    expect(normalizeForLookup(decomposed)).toBe('café');
  });

  it('NFC 用于判定，但返回值保留页面原始 surface', () => {
    const surface = 'cafe\u0301';
    expect(judgeWord(surface)).toEqual({ ok: true, word: surface });
  });

  it('stripDiacritics：去变音符', () => {
    expect(stripDiacritics('naïve')).toBe('naive');
    expect(stripDiacritics('café')).toBe('cafe');
    // 无变音符时原样返回
    expect(stripDiacritics('run')).toBe('run');
  });

  it('查表候选：原样优先，去变音符在后', () => {
    expect(lookupCandidates('naïve')).toEqual(['naïve', 'naive']);
    expect(lookupCandidates('café')).toEqual(['café', 'cafe']);
  });

  it('查表候选：无变音符时只有一个候选（不重复）', () => {
    expect(lookupCandidates('run')).toEqual(['run']);
    expect(lookupCandidates('London')).toEqual(['london']);
  });

  it('双向成立：页面写 naive 时也能查到词库里的 naïve', () => {
    // 候选里必须有 naive 本身；"页面 naive → 词库 naïve"靠的是
    // 词库侧同时收录两种写法，或用同样的去变音符规则建索引。
    // 这里锁住的是候选生成的契约：naive 的候选就是 ['naive']。
    expect(lookupCandidates('naive')).toEqual(['naive']);
    // 而去变音符后 naive 与 naïve 落到同一个键——这保证了反向也能命中
    expect(stripDiacritics(normalizeForLookup('naïve'))).toBe(stripDiacritics(normalizeForLookup('naive')));
  });

  it('变音字母本身算字母，不会被 no-letter 误杀', () => {
    expect(judgeWord('naïve')).toEqual({ ok: true, word: 'naïve' });
    expect(judgeWord('café')).toEqual({ ok: true, word: 'café' });
  });
});
