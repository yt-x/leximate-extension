/**
 * 语料词频统计的单测（PLAN.md FR-B8）。
 *
 * FR-B8 的验收是"词表可由脚本从语料重算复现"。**可复现的前提是计数口径写死且可测**——
 * 口径只活在文档里的话，下一个人改一个正则就会让词表悄悄变样，而没有任何东西会红。
 *
 * 夹具按 BNC XML 的真实形态写（`<w c5="AJ0">quick</w>` 这种带属性的标签）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_EXCLUDED_POS,
  countFile,
  dominantTag,
  isCountable,
  isExcludedTag,
  normalizeToken,
  tokensOf,
  wordElementsOf,
  type FormStats,
} from './count-corpus';

describe('normalizeToken：哪些串算一个词', () => {
  it('小写化', () => {
    expect(normalizeToken('Running')).toBe('running');
  });

  it('词内撇号与连字符保留（它们是词的一部分）', () => {
    expect(normalizeToken("don't")).toBe("don't");
    expect(normalizeToken('well-known')).toBe('well-known');
  });

  it('两端撇号/连字符被清掉', () => {
    // ⚠️ `normalizeToken` 的入参是**正则已经匹配出来的词形**，
    // 因此引号、破折号这类"词外字符"根本到不了这里（它们在 `tokensOf` 那一层被切开）
    expect(normalizeToken("'cause'")).toBe('cause');
    expect(normalizeToken('-quick-')).toBe('quick');
    expect(normalizeToken('’quick’')).toBe('quick');
  });

  it('破折号是分隔符，不是词内字符（`em—dash` 是两个词）', () => {
    expect(normalizeToken('—')).toBeNull();
  });

  it('含数字不算（1994 / 3rd 不是要教的词）', () => {
    expect(normalizeToken('1994')).toBeNull();
    expect(normalizeToken('3rd')).toBeNull();
    expect(normalizeToken('a1')).toBeNull();
  });

  it('空串与纯符号不算', () => {
    expect(normalizeToken('')).toBeNull();
    expect(normalizeToken('---')).toBeNull();
    expect(normalizeToken("-'")).toBeNull();
  });
});

describe('tokensOf：从 BNC 的 XML 行里取词', () => {
  it('剥掉带属性的标签，只留词', () => {
    const line = '<w c5="AJ0">quick</w> <w c5="NN1">brown</w> <w c5="VVZ">runs</w>';
    expect(tokensOf(line)).toEqual(['quick', 'brown', 'runs']);
  });

  it('标签属性里的值不会被当成词（它们看起来很像词）', () => {
    // 属性值 AJ0 / NN1 若被计数，会污染入选边界，而肉眼看不出
    expect(tokensOf('<w c5="AJ0" hw="quick">quick</w>')).toEqual(['quick']);
  });

  it('XML 实体会被换掉，不会留下 amp / nbsp 这类假词', () => {
    expect(tokensOf('<w>fish</w> &amp; <w>chips</w>')).toEqual(['fish', 'and', 'chips']);
    expect(tokensOf('a&nbsp;b')).toEqual(['a', 'b']);
    expect(tokensOf('&unknown;word')).toEqual(['word']);
  });

  it('标点与句子边界不产出词', () => {
    expect(tokensOf('"Hello, world!" — she said.')).toEqual(['hello', 'world', 'she', 'said']);
  });

  it('连字符在词内保留、破折号当作分隔', () => {
    expect(tokensOf('a well-known em—dash case')).toEqual(['a', 'well-known', 'em', 'dash', 'case']);
  });

  it('多词性标注的括号内容（BNC 里是标签，不是文本）不影响', () => {
    expect(tokensOf('<w c5="PNP">it</w> <c c5="PUN">\'</c><w c5="VVZ">s</w>')).toEqual(['it', 's']);
  });
});

describe('isCountable：切分残留不是单词', () => {
  it('BNC 拆出来的缩写残留要剔掉（它们会挤进候选词表）', () => {
    // 实测：naive 计数里 `s` 排第 11、`n't` 排第 17
    for (const form of ["n't", 'nt', 're', 've', 'll', 'em']) {
      expect(isCountable(form), form).toBe(false);
    }
  });

  it('单个字母只留 a / i', () => {
    expect(isCountable('a')).toBe(true);
    expect(isCountable('i')).toBe(true);
    for (const form of ['s', 'd', 'm', 't', 'o', 'x']) {
      expect(isCountable(form), form).toBe(false);
    }
  });

  it('正常词一律保留（`not` 是正经常用词，不能被当残留误杀）', () => {
    for (const form of ['the', 'not', 'run', 'yeah', 'is']) {
      expect(isCountable(form), form).toBe(true);
    }
  });
});

describe('wordElementsOf：带词性标签取词', () => {
  it('取出词形、c5 标签与 hw 词元', () => {
    expect(wordElementsOf('<w c5="AJ0" hw="quick">quick</w> <w c5="NN1" hw="fox">fox</w>')).toEqual([
      { form: 'quick', pos: 'AJ0', lemma: 'quick' },
      { form: 'fox', pos: 'NN1', lemma: 'fox' },
    ]);
  });

  it('没有 c5 属性时 pos 为 null（不猜），没有 hw 时词元回落到表层词形', () => {
    expect(wordElementsOf('<w hw="run">running</w>')).toEqual([
      { form: 'running', pos: null, lemma: 'run' },
    ]);
    expect(wordElementsOf('<w c5="NN1">fox</w>')).toEqual([{ form: 'fox', pos: 'NN1', lemma: 'fox' }]);
  });

  it('一行里多个 <w> 都能取到', () => {
    expect(wordElementsOf('<w c5="PNP">it</w><w c5="VBZ">is</w><w c5="AT0">a</w>')).toHaveLength(3);
  });
});

/** 写一个临时语料文件（用 os.tmpdir，不碰仓库） */
function tempCorpus(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'leximate-corpus-'));
  const file = join(dir, 'sample.xml');
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('countFile：BNC 的 <w> 路径', () => {
  const xml = [
    '<w c5="AT0">the</w> <w c5="NN1">fox</w> <w c5="NP0">London</w>',
    '<w c5="XX0">not</w> <w c5="PNP">it</w><w c5="VBZ">s</w>',
    '<w c5="UNC">???</w> <w c5="ZZ0">x</w> <w c5="CRD">1994</w>',
  ].join('\n');

  it('默认排除专有名词/标点/无法判定/字母符号，并剔掉缩写残留', async () => {
    const counts = new Map<string, FormStats>();
    const tokens = await countFile(tempCorpus(xml), counts);

    // London(NP0) / ???(UNC) / x(ZZ0) 被排除；`s`（缩写残留，标签 VBZ）也被剔掉；
    // the / it / not / fox 留下
    expect([...counts.keys()].sort()).toEqual(['fox', 'it', 'not', 'the']);
    expect(tokens).toBe(4);
  });

  it('`not`（XX0）必须留下——它所在的类里还有 n\'t，不能整类排除', async () => {
    const counts = new Map<string, FormStats>();
    await countFile(tempCorpus(xml), counts);
    expect(counts.get('not')).toEqual({ count: 1, tags: new Map([['XX0', 1]]), surfaces: new Set(['not']) });
  });

  it('可以覆盖排除清单（把专有名词收回来）', async () => {
    const counts = new Map<string, FormStats>();
    await countFile(tempCorpus(xml), counts, { excludePos: [] });

    // `1994` 仍然不算：含数字的词形在 `normalizeToken` 就被挡掉了（与标签无关）
    expect([...counts.keys()].sort()).toEqual(['fox', 'it', 'london', 'not', 'the']);
  });

  it('纯文本语料（没有 <w>）退回逐行计数', async () => {
    const counts = new Map<string, FormStats>();
    const tokens = await countFile(tempCorpus('The quick brown fox.\nIt jumps.'), counts);

    expect(tokens).toBe(6);
    expect([...counts.keys()].sort()).toEqual(['brown', 'fox', 'it', 'jumps', 'quick', 'the']);
  });

  it('复合标签只要沾上被排除的类，整条排除（`NP0-NN1` 里的人名不能漏进来）', () => {
    const excluded = new Set(DEFAULT_EXCLUDED_POS);
    expect(isExcludedTag('NP0-NN1', excluded)).toBe(true);
    expect(isExcludedTag('NN1-NP0', excluded)).toBe(true);
    expect(isExcludedTag('NN1-VVB', excluded)).toBe(false);
    expect(isExcludedTag('AJ0', excluded)).toBe(false);
    expect(isExcludedTag('NP0', excluded)).toBe(true);
  });

  it('主导词性取次数最多的那个（同票按字母序，保证可复现）', () => {
    expect(dominantTag({ count: 3, tags: new Map([['NN1', 2], ['VVZ', 1]]), surfaces: new Set() })).toBe('NN1');
    expect(dominantTag({ count: 2, tags: new Map([['VVZ', 1], ['NN1', 1]]), surfaces: new Set() })).toBe('NN1');
    expect(dominantTag({ count: 1, tags: new Map(), surfaces: new Set() })).toBe('');
  });
});

describe('按 BNC 的 hw（词元）聚合', () => {
  const xml = [
    '<w c5="VVN" hw="say">said</w> <w c5="VVZ" hw="say">says</w>',
    '<w c5="NN2" hw="day">days</w> <w c5="PNP" hw="I">me</w> <w c5="PNP" hw="I">I</w>',
    '<w c5="XX0" hw="not">n\'t</w> <w c5="XX0" hw="not">not</w>',
  ].join('\n');

  it('屈折形式并进词元，并把表层词形记下来', async () => {
    const counts = new Map<string, FormStats>();
    const tokens = await countFile(tempCorpus(xml), counts);

    expect(tokens).toBe(7);
    expect(counts.get('say')).toMatchObject({ count: 2 });
    expect([...counts.get('say')!.surfaces].sort()).toEqual(['said', 'says']);
    expect(counts.get('day')).toMatchObject({ count: 1 });
  });

  it('代词**不**并进主格（`me` 与 `i` 必须各自成条）', async () => {
    const counts = new Map<string, FormStats>();
    await countFile(tempCorpus(xml), counts);

    expect(counts.get('me')).toMatchObject({ count: 1 });
    expect(counts.get('i')).toMatchObject({ count: 1 });
  });

  it('缩写残留并进它的词元（`n\'t` → `not`），不留下假词', async () => {
    const counts = new Map<string, FormStats>();
    await countFile(tempCorpus(xml), counts);

    expect(counts.has("n't")).toBe(false);
    expect(counts.get('not')).toMatchObject({ count: 2 });
    expect([...counts.get('not')!.surfaces].sort()).toEqual(["n't", 'not']);
  });

  it('可以按表层词形聚合（--no-lemma 的等价行为）', async () => {
    const counts = new Map<string, FormStats>();
    await countFile(tempCorpus(xml), counts, { useLemma: false });

    // 表层模式下 `n't` 是残留，直接丢掉；屈折不再归并
    expect([...counts.keys()].sort()).toEqual(['days', 'i', 'me', 'not', 'said', 'says']);
  });
});
