/**
 * 候选词表构建的单测（PLAN.md FR-B8）。
 *
 * 这一层决定"哪些词进词表、进多少"——它错了整份词表就错了，
 * 而错误形态很隐蔽（把查不到的转录拼写收进来、词性全空、把已收录的词重算一遍）。
 */
import { describe, expect, it } from 'vitest';
import {
  BNC_TO_POS,
  FILLED_PAUSES,
  SPOKEN_SPELLING_ARTIFACTS,
  americanize,
  buildWordlist,
  posOfTag,
  type FreqRow,
} from './build-wordlist';

function freq(rows: Array<[string, number, string]>): FreqRow[] {
  return rows.map(([lemma, count, tag]) => ({ lemma, count, tag, surfaces: 1 }));
}

const NO_CORE: ReadonlySet<string> = new Set();

describe('posOfTag：BNC 标签 → 项目词性词表', () => {
  it('名词 / 动词 / 形容词 / 副词', () => {
    expect(posOfTag('NN1')).toBe('n.');
    expect(posOfTag('NN2')).toBe('n.');
    expect(posOfTag('VVD')).toBe('v.');
    expect(posOfTag('VBZ')).toBe('v.');
    expect(posOfTag('VM0')).toBe('v.');
    expect(posOfTag('AJ0')).toBe('adj.');
    expect(posOfTag('AV0')).toBe('adv.');
  });

  it('功能词按现有 920 条的人工口径映射', () => {
    // 逐条核对过既有词表：the=art.、this/which=pron.、there=adv.、not=adv.、
    // of=prep.、if=conj.、one=num.
    expect(posOfTag('AT0')).toBe('art.');
    expect(posOfTag('DT0')).toBe('pron.');
    expect(posOfTag('PNP')).toBe('pron.');
    expect(posOfTag('EX0')).toBe('adv.');
    expect(posOfTag('XX0')).toBe('adv.');
    expect(posOfTag('PRF')).toBe('prep.');
    expect(posOfTag('CJS')).toBe('conj.');
    expect(posOfTag('CRD')).toBe('num.');
  });

  it('复合标签取第一段（BNC 的疑似标签形如 AJ0-NN1）', () => {
    expect(posOfTag('AJ0-NN1')).toBe('adj.');
    expect(posOfTag('NN1-VVB')).toBe('n.');
  });

  it('未知标签返回空串（不猜、不默认成名词）', () => {
    expect(posOfTag('')).toBe('');
    expect(posOfTag('XXX')).toBe('');
  });

  it('映射表覆盖了本项目词性词表里的全部取值', () => {
    const values = new Set(Object.values(BNC_TO_POS));
    for (const expected of ['n.', 'v.', 'adj.', 'adv.', 'pron.', 'prep.', 'conj.', 'num.', 'art.', 'int.']) {
      expect([...values], expected).toContain(expected);
    }
  });
});

describe('挑选口径', () => {
  it('剔除口语转录拼写（cos/na/gon），并把丢掉的 token 量报出来', () => {
    const result = buildWordlist(
      freq([
        ['the', 1000, 'AT0'],
        ['cos', 2793, 'CJS'],
        ['na', 2605, 'TO0'],
        ['gon', 2037, 'VVG'],
      ]),
      { target: 10, coreLemmas: NO_CORE },
    );

    expect(result.ranked.map((row) => row.lemma)).toEqual(['the']);
    expect(result.dropped.spokenArtifacts.map((row) => row.lemma)).toEqual(['cos', 'na', 'gon']);
    expect(result.dropped.spokenArtifacts.reduce((sum, row) => sum + row.count, 0)).toBe(7435);
  });

  it('剔除填充停顿（mm/er/uh），但保留真感叹词（yeah/oh）', () => {
    const result = buildWordlist(
      freq([
        ['yeah', 14371, 'ITJ'],
        ['oh', 11143, 'ITJ'],
        ['mm', 5692, 'ITJ'],
        ['er', 900, 'ITJ'],
        ['uh', 800, 'ITJ'],
      ]),
      { target: 10, coreLemmas: NO_CORE },
    );

    expect(result.ranked.map((row) => row.lemma)).toEqual(['yeah', 'oh']);
    expect(result.dropped.filledPauses.map((row) => row.lemma).sort()).toEqual(['er', 'mm', 'uh']);
    expect(FILLED_PAUSES.has('mm')).toBe(true);
    expect(SPOKEN_SPELLING_ARTIFACTS.has('cos')).toBe(true);
  });

  it('按次数降序取到 target 为止，并列按字母序', () => {
    const result = buildWordlist(
      freq([
        ['beta', 5, 'NN1'],
        ['alpha', 5, 'NN1'],
        ['gamma', 9, 'NN1'],
      ]),
      { target: 2, coreLemmas: NO_CORE },
    );

    expect(result.candidates.map((row) => row.lemma)).toEqual(['gamma', 'alpha']);
    expect(result.ranked).toHaveLength(3); // 全量表仍完整
  });

  it('已收录的词被标出来，needNew 扣掉它们', () => {
    const result = buildWordlist(
      freq([
        ['the', 1000, 'AT0'],
        ['run', 500, 'VVI'],
        ['zebra', 10, 'NN1'],
      ]),
      { target: 3, coreLemmas: new Set(['the', 'run']) },
    );

    expect(result.candidates.filter((row) => row.inCore).map((row) => row.lemma)).toEqual(['the', 'run']);
    expect(result.needNew).toBe(1);
  });

  it('CMUdict 里没有读音的词直接不收（拿不到音标就不能进词表）', () => {
    const result = buildWordlist(freq([['zebra', 10, 'NN1'], ['zzz', 9, 'NN1']]), {
      target: 10,
      coreLemmas: NO_CORE,
      cmudict: new Set(['zebra']),
    });

    expect(result.candidates.map((row) => row.lemma)).toEqual(['zebra']);
    expect(result.dropped.noPronunciation.map((row) => row.lemma)).toEqual(['zzz']);
    // 不收之后，候选里自然没有"缺读音"的条目
    expect(result.stats.cmudictMissingAmongNew).toBe(0);
  });

  it('不给 CMUdict 时不做这个过滤（便于离线看全量）', () => {
    const result = buildWordlist(freq([['zzz', 9, 'NN1']]), { target: 10, coreLemmas: NO_CORE });

    expect(result.candidates.map((row) => row.lemma)).toEqual(['zzz']);
    expect(result.dropped.noPronunciation).toEqual([]);
  });

  it('标签没映射到词性的行照常进表，但会被计入 unmappedPos 以便补规则', () => {
    const result = buildWordlist(freq([['weirdo', 10, 'XXX']]), { target: 10, coreLemmas: NO_CORE });

    expect(result.candidates[0]).toMatchObject({ lemma: 'weirdo', pos: '' });
    expect(result.dropped.unmappedPos.map((row) => row.lemma)).toEqual(['weirdo']);
  });

  it('统计数字自洽：候选数 ≤ 词元数，token 总和等于输入总和', () => {
    const rows = freq([['the', 100, 'AT0'], ['cos', 50, 'CJS'], ['run', 10, 'VVI']]);
    const result = buildWordlist(rows, { target: 10, coreLemmas: NO_CORE });

    expect(result.candidates.length).toBeLessThanOrEqual(result.stats.freqLemmas);
    expect(result.stats.tokens).toBe(160);
  });

  it('英式拼写归一成美式，并把次数并进美式那条（`centre` → `center`）', () => {
    const result = buildWordlist(
      freq([
        ['center', 100, 'NN1'],
        ['centre', 60, 'NN1'],
        ['colour', 40, 'NN1'],
      ]),
      { target: 10, coreLemmas: new Set(['center']) },
    );

    expect(result.ranked.map((row) => `${row.lemma}:${row.count}`)).toEqual(['center:160', 'color:40']);
    expect(result.stats.britishMerged).toBe(2);
    // `center` 已收录 → 不重复进新词
    expect(result.candidates.find((row) => row.lemma === 'center')?.inCore).toBe(true);
    expect(result.candidates.find((row) => row.lemma === 'color')?.inCore).toBe(false);
  });

  it('不碰 `practise`（现有词表收的就是英式那条，改了会与已收录条目打架）', () => {
    const result = buildWordlist(freq([['practise', 30, 'VVI']]), { target: 10, coreLemmas: NO_CORE });
    expect(result.ranked[0]?.lemma).toBe('practise');
  });

  it('查表要防原型链：`constructor` / `toString` 这类词不能变成函数', () => {
    // 语料里真的有 `constructor`（实测 BNC Baby 出现过），
    // `TABLE[key] ?? fallback` 会从 Object.prototype 返回函数，随后排在排序里炸掉
    expect(americanize('constructor')).toBe('constructor');
    expect(americanize('toString')).toBe('toString');
    expect(americanize('__proto__')).toBe('__proto__');
    expect(posOfTag('constructor')).toBe('');

    const result = buildWordlist(
      freq([
        ['constructor', 5, 'NN2'],
        ['tostring', 4, 'NN1'],
      ]),
      { target: 10, coreLemmas: NO_CORE },
    );
    // 输入契约：词元表由 count-corpus 产出，已经是小写
    expect(result.candidates.map((row) => `${row.lemma}:${row.pos}`)).toEqual([
      'constructor:n.',
      'tostring:n.',
    ]);
  });
});
