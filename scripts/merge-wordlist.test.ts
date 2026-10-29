/**
 * 合并新词进核心词表的单测（PLAN.md FR-B1，M1-9）。
 *
 * 这份脚本动的是**人工 review 的源文件**（`decisions/0002`）：格式一坏，
 * `build-dict.ts --check` 只会报"产物对不上"，不会指出哪一行坏了。
 * 因此插入规则每一条都要有用例。
 */
import { describe, expect, it } from 'vitest';
import { mergeWordlist, parseBatch, parseCoreTsv, validateRow, type WordRow } from './merge-wordlist';

const HEADER = 'lemma\tphoneticUs\tphoneticUk\tpos\tdefZh\n';

function core(...rows: string[]): string {
  return HEADER + rows.map((row) => `${row}\n`).join('');
}

function row(lemma: string, pos: string, defZh: string) {
  return { lemma, pos, defZh };
}

describe('parseCoreTsv', () => {
  it('解析现有词表（5 列、LF、末尾换行）', () => {
    const parsed = parseCoreTsv(core('run\t/rʌn/\t\tv.\t跑', 'the\t/ðə/\t\tart.\t这（那）个'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ lemma: 'run', phoneticUs: '/rʌn/', phoneticUk: '', pos: 'v.', defZh: '跑' });
  });

  it('表头不符就抛错（宁可停下，也不要默默写坏源文件）', () => {
    expect(() => parseCoreTsv('lemma\tpos\nrun\tv.\n')).toThrow(/表头不符/);
  });

  it('列数不是 5 就抛错，并指出行号', () => {
    expect(() => parseCoreTsv(core('run\tv.\t跑'))).toThrow(/第 2 行/);
  });
});

describe('validateRow：新行的硬性要求', () => {
  it('lemma 必须纯小写英文（允许词内撇号/连字符）', () => {
    expect(validateRow(row('run', 'v.', '跑'))).toBeNull();
    expect(validateRow(row('well-known', 'adj.', '有名的'))).toBeNull();
    expect(validateRow(row('Run', 'v.', '跑'))).toMatch(/纯小写/);
    expect(validateRow(row('r un', 'v.', '跑'))).toMatch(/纯小写/);
  });

  it('词性必须在白名单里（防止拼出 noun / vt. 这类不一致的写法）', () => {
    expect(validateRow(row('run', 'noun', '跑'))).toMatch(/词性取值非法/);
    expect(validateRow(row('run', '', '跑'))).toMatch(/词性取值非法/);
    expect(validateRow(row('run', 'int.', '嗯'))).toBeNull();
  });

  it('释义不能为空、不能带制表符、必须有中文', () => {
    expect(validateRow(row('run', 'v.', ''))).toMatch(/不能为空/);
    expect(validateRow(row('run', 'v.', '跑\t走'))).toMatch(/制表符/);
    expect(validateRow(row('run', 'v.', 'to move fast'))).toMatch(/没有中文/);
  });
});

describe('mergeWordlist', () => {
  const existing: WordRow[] = parseCoreTsv(core('run\t/rʌn/\t\tv.\t跑', 'the\t/ðə/\t\tart.\t这（那）个'));

  it('新词插入后仍按字节序升序，且音标两列留空（由音标管线填）', () => {
    const result = mergeWordlist(existing, [row('apple', 'n.', '苹果')]);
    const lines = result.tsv.split('\n');
    expect(lines[0]).toBe('lemma\tphoneticUs\tphoneticUk\tpos\tdefZh');
    expect(lines.slice(1, 4)).toEqual(['apple\t\t\tn.\t苹果', 'run\t/rʌn/\t\tv.\t跑', 'the\t/ðə/\t\tart.\t这（那）个']);
    expect(result.tsv.endsWith('\n')).toBe(true);
  });

  it('已有词被跳过，并给出原因（不覆盖人工写过的内容）', () => {
    const result = mergeWordlist(existing, [row('run', 'v.', '另一个释义')]);
    expect(result.added).toHaveLength(0);
    expect(result.skipped).toEqual([{ line: 'run\tv.\t另一个释义', reason: '词表里已有' }]);
    // 原有行逐字节不变
    expect(result.tsv).toBe(core('run\t/rʌn/\t\tv.\t跑', 'the\t/ðə/\t\tart.\t这（那）个'));
  });

  it('同一批次里的重复只进一条', () => {
    const result = mergeWordlist(existing, [row('apple', 'n.', '苹果'), row('apple', 'n.', '苹果')]);
    expect(result.added).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('词表里已有');
  });

  it('非法行被拦下，但同一批次里的合法行照常进', () => {
    const result = mergeWordlist(existing, [row('Bad', 'n.', '坏的'), row('good', 'adj.', '好的')]);
    expect(result.added.map((r) => r.lemma)).toEqual(['good']);
    expect(result.skipped[0]?.reason).toMatch(/纯小写/);
  });

  it('空批次不写盘（结果与原文一致）', () => {
    const original = core('run\t/rʌn/\t\tv.\t跑');
    const result = mergeWordlist(parseCoreTsv(original), []);
    expect(result.tsv).toBe(original);
    expect(result.added).toHaveLength(0);
  });
});

describe('parseBatch', () => {
  it('解析 `lemma pos defZh` 三列，忽略空行与注释行', () => {
    const parsed = parseBatch('# 第一批\napple\tn.\t苹果\n\nbanana\tn.\t香蕉\n');
    expect(parsed).toEqual([row('apple', 'n.', '苹果'), row('banana', 'n.', '香蕉')]);
  });
});
