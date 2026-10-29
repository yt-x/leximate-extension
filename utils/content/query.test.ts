/**
 * 划词查询管道的单测（PLAN.md FR-A1、FR-A2、FR-B3c、FR-B3d、FR-B4、FR-A16）。
 *
 * 这层是"判定 → 归一化 → 还原 → 查表"的接缝，几条规格的验收判定都落在这里：
 * - FR-A2：四类放宽形态能查到
 * - FR-B3：running / went / studies / bigger 能查到原形
 * - FR-B3c：saw / left / better / found 走独立词条，不被还原覆盖
 * - FR-B4：未收录要明确返回 unlisted，不静默失败
 * - FR-A16：判定先于归一化
 */
import { describe, expect, it, vi } from 'vitest';
import { createDictLookup } from '../dict/lookup';
import { buildReverseIndex, createLemmatizer } from '../dict/lemmatize';
import { createMemorySource } from '../dict/source';
import type { DictEntry, DictIndex, DictShard } from '../dict/types';
import { querySelection, querySelectionAsync } from './query';

function entry(lemma: string, defZh = '释义'): DictEntry {
  return { lemma, phoneticUs: '/test/', phoneticUk: '', pos: ['n.'], defZh: [defZh] };
}

/** core 分片 + 可选的首字母分片（模拟 §4.5 P3 的产物） */
function fixture(hot: DictEntry[], extra: Record<string, DictEntry[]> = {}): Record<string, string> {
  const shards: DictShard[] = [
    { name: 'core', words: Object.fromEntries(hot.map((e) => [e.lemma, e])) },
  ];
  for (const [name, list] of Object.entries(extra)) {
    shards.push({ name, words: Object.fromEntries(list.map((e) => [e.lemma, e])) });
  }
  const index: DictIndex = {
    version: '9.9.9',
    generatedAt: '2026-10-13T00:00:00.000Z',
    count: shards.reduce((sum, s) => sum + Object.keys(s.words).length, 0),
    shards: shards.map((s) => ({
      name: s.name,
      file: `shard-${s.name}.json`,
      count: Object.keys(s.words).length,
      bytes: 0,
    })),
  };
  const files: Record<string, string> = { 'index.json': JSON.stringify(index) };
  for (const shard of shards) files[`shard-${shard.name}.json`] = JSON.stringify(shard);
  return files;
}

/** 造一个带词形还原的查询器，形态与生产一致 */
async function makeDict(
  hot: DictEntry[],
  forms: Array<[string, string, string]>,
  extra: Record<string, DictEntry[]> = {},
) {
  const dict = createDictLookup(createMemorySource(fixture(hot, extra)), {
    lemmatize: (surface) => {
      const index = buildReverseIndex(
        forms.map(([lemma, form, feature]) => ({ lemma, form, feature })),
      );
      const candidate = createLemmatizer(index, (lemma) => hot.some((e) => e.lemma === lemma))(
        surface,
      );
      return candidate;
    },
  });
  await dict.warm();
  return dict;
}

describe('FR-F9：最短词长设置要真的生效', () => {
  /**
   * 设置页写着"短于该长度的选中词不处理"，`Settings.minWordLength` 默认 2。
   *
   * ⚠️ 这条此前是**死配置**：`judgeWord` 与查询管道都没读过它，
   * 于是单字母 `p` 也能一路走完并入库（用户报告的前缀风暴里，
   * `p` 就是其中一条）。
   */
  it('短于 minLength 的选中被拒，理由是可诊断的 too-short', async () => {
    const dict = await makeDict([entry('run'), entry('proof')], []);

    expect(querySelection('p', dict, { minLength: 2 })).toEqual({
      kind: 'rejected',
      reason: 'too-short',
    });
    // 下限是"至少这么长"：2 字符通过、3 字符下限时被拒
    expect(querySelection('pr', dict, { minLength: 3 })).toEqual({
      kind: 'rejected',
      reason: 'too-short',
    });
  });

  it('达到 minLength 就正常查（不被误伤）', async () => {
    const dict = await makeDict([entry('run'), entry('proof')], []);

    expect(querySelection('run', dict, { minLength: 2 }).kind).toBe('hit');
    expect(querySelection('proof', dict, { minLength: 2 }).kind).toBe('hit');
  });

  it('minLength 缺省时不设下限（保持判定规则表的原样：单字母也算词形）', async () => {
    const dict = await makeDict([entry('run')], []);

    expect(querySelection('p', dict).kind).toBe('unlisted');
  });

  it('长度按字符数算（含变音符号的词不被误伤）', async () => {
    const dict = await makeDict([entry('café')], []);

    expect(querySelection('café', dict, { minLength: 4 }).kind).toBe('hit');
  });
});

describe('FR-A2：四类放宽形态都能查到', () => {
  it('连字符词、缩写、所有格、首字母大写', async () => {
    const dict = await makeDict(
      [entry('well-known'), entry('run'), entry('student'), entry('london')],
      [],
    );

    for (const word of ['well-known', "don't", "students'", 'London']) {
      const result = querySelection(word, dict);
      // don't / students' 不在词表里是预期的，这里只验证**判定通过**（不是 rejected）
      expect(result.kind).not.toBe('rejected');
    }
    expect(querySelection('London', dict).kind).toBe('hit');
  });
});

describe('FR-B3 / FR-B3d：划词直接经还原查到原形', () => {
  it('running → run，且带上变形提示', async () => {
    const dict = await makeDict(
      [entry('run', '跑')],
      [['run', 'running', 'Q10345583']],
    );
    const result = querySelection('running', dict);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.hit.entry.lemma).toBe('run');
      expect(result.hit.via).toBe('lemmatized');
      expect(result.hit.hint).toBe('现在分词');
      // surface 保留页面原形
      expect(result.surface).toBe('running');
    }
  });

  it('went → go、studies → study、bigger → big', async () => {
    const dict = await makeDict(
      [entry('go'), entry('study'), entry('big')],
      [
        ['go', 'went', 'Q1392475'],
        ['study', 'studies', 'Q3910936'],
        ['big', 'bigger', 'Q14169499'],
      ],
    );
    for (const [word, lemma] of [
      ['went', 'go'],
      ['studies', 'study'],
      ['bigger', 'big'],
    ] as const) {
      const result = querySelection(word, dict);
      expect(result.kind).toBe('hit');
      if (result.kind === 'hit') expect(result.hit.entry.lemma).toBe(lemma);
    }
  });
});

describe('FR-B3c：同形冲突走独立词条，不被还原覆盖', () => {
  it('saw 是独立词条时用它，并附变形提示', async () => {
    const dict = await makeDict(
      [entry('saw', '锯子'), entry('see', '看见')],
      [['see', 'saw', 'Q1392475']],
    );
    const result = querySelection('saw', dict);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.hit.via).toBe('direct');
      expect(result.hit.entry.defZh).toEqual(['锯子']); // 词义不被覆盖
      expect(result.hit.inflectionOf).toEqual({ lemma: 'see', hint: '过去式' });
    }
  });

  it('saw 不是独立词条时才走还原', async () => {
    const dict = await makeDict([entry('see', '看见')], [['see', 'saw', 'Q1392475']]);
    const result = querySelection('saw', dict);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.hit.via).toBe('lemmatized');
      expect(result.hit.entry.lemma).toBe('see');
    }
  });
});

describe('FR-A16：判定先于归一化', () => {
  it('纯数字直接 rejected，不会先归一化再查一次', async () => {
    const dict = await makeDict([entry('314')], []);
    const result = querySelection('3.14', dict);
    // 词库里真有 '314' 也不该命中——判定不过就不查表
    expect(result).toEqual({ kind: 'rejected', reason: 'no-letter' });
  });

  it('短语被拒绝（不查表）', async () => {
    const dict = await makeDict([entry('take')], []);
    const result = querySelection('take into account', dict);
    expect(result).toEqual({ kind: 'rejected', reason: 'not-a-word' });
  });

  it('超长文本被拒绝', async () => {
    const dict = await makeDict([], []);
    const result = querySelection('a'.repeat(46), dict);
    expect(result).toEqual({ kind: 'rejected', reason: 'too-long' });
  });
});

describe('FR-A16：重音符号双向回退', () => {
  it('页面写 naïve 而词库只有 naive 时，仍能命中', async () => {
    const dict = await makeDict([entry('naive', '天真的')], []);
    const result = querySelection('naïve', dict);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.hit.entry.lemma).toBe('naive');
      expect(result.surface).toBe('naïve'); // 显示保留原形
    }
  });

  it('页面写 naive 而词库只有 naïve 时，仍能命中', async () => {
    const dict = await makeDict([entry('naïve', '天真的')], []);
    const result = querySelection('naive', dict);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.hit.entry.lemma).toBe('naïve');
      expect(result.surface).toBe('naive');
    }
  });

  it('多个不同词条去变音后相同，页面写 naive 时不猜测', async () => {
    const dict = await makeDict([entry('naïve', '天真的'), entry('naivé', '另一个')], []);
    expect(querySelection('naive', dict)).toEqual({ kind: 'unlisted', surface: 'naive' });
  });

  it('词库有原样写法时优先用原样，不回退', async () => {
    const dict = await makeDict([entry('naïve', '天真的'), entry('naive', '另一个')], []);
    const result = querySelection('naïve', dict);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') expect(result.hit.entry.defZh).toEqual(['天真的']);
  });

  it('回退被使用时通知诊断钩子', async () => {
    const dict = await makeDict([entry('naive')], []);
    const onDiacriticFallback = vi.fn();
    querySelection('naïve', dict, { onDiacriticFallback });
    expect(onDiacriticFallback).toHaveBeenCalledWith('naïve', 'naive');
  });
});

describe('FR-B4：未收录明确返回，不静默失败', () => {
  it('判定通过但词库没有 → unlisted', async () => {
    const dict = await makeDict([entry('run')], []);
    const result = querySelection('zzzz', dict);
    expect(result).toEqual({ kind: 'unlisted', surface: 'zzzz' });
  });
});

describe('§4.5 P3：未命中时补拉首字母分片（异步版）', () => {
  it('词在未加载的分片里时，异步版能补拉并命中', async () => {
    // z 开头的词不在 core，放在字母分片里
    const dict = await makeDict([entry('run')], [], { z: [entry('zebra', '斑马')] });

    // 同步版查不到（分片还没拉）
    expect(querySelection('zebra', dict).kind).toBe('unlisted');
    // 且这次查询不该有副作用
    expect(dict.loadedShards()).toEqual(['core']);

    // 异步版会补拉
    const result = await querySelectionAsync('zebra', dict);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') expect(result.hit.entry.defZh).toEqual(['斑马']);
    expect(dict.loadedShards()).toEqual(['core', 'z']);
  });

  it('补拉后仍未命中，仍返回 unlisted（不假装查到）', async () => {
    const dict = await makeDict([entry('run')], [], { z: [entry('zebra')] });
    const result = await querySelectionAsync('zzzz', dict);
    expect(result).toEqual({ kind: 'unlisted', surface: 'zzzz' });
  });

  it('判定不过时不触发任何分片加载', async () => {
    const dict = await makeDict([entry('run')], [], { z: [entry('zebra')] });
    const result = await querySelectionAsync('123', dict);
    expect(result.kind).toBe('rejected');
    expect(dict.loadedShards()).toEqual(['core']);
  });
});

describe('FR-B7：内置分片未命中时问导入词库', () => {
  it('导入词库里有时返回命中，且带释义与词性', async () => {
    const dict = await makeDict([entry('run')], []);
    const imported = vi.fn(async (surface: string) =>
      surface === 'constraint'
        ? {
            lemma: 'constraint',
            hint: null,
            word: {
              phoneticUs: "kәn'streint",
              pos: ['n.'],
              defZh: ['n. 强制, 约束', '[计] 约束'],
              fallbackDef: [],
              examTags: ['cet6', 'toefl', 'gre'],
            },
          }
        : null,
    );

    const result = await querySelectionAsync('constraint', dict, {}, imported);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.hit.entry.lemma).toBe('constraint');
      expect(result.hit.entry.defZh).toEqual(['n. 强制, 约束', '[计] 约束']);
      expect(result.hit.entry.pos).toEqual(['n.']);
      expect(result.hit.via).toBe('direct');
    }
    expect(imported).toHaveBeenCalledWith('constraint');
  });

  it('变形形式命中时走 lemmatized 并带提示', async () => {
    const dict = await makeDict([entry('run')], []);
    const imported = async (surface: string) =>
      surface === 'constraints'
        ? {
            lemma: 'constraint',
            hint: '复数形式',
            word: {
              phoneticUs: '',
              pos: ['n.'],
              defZh: ['n. 约束'],
              fallbackDef: [],
              examTags: [],
            },
          }
        : null;

    const result = await querySelectionAsync('constraints', dict, {}, imported);
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.hit.entry.lemma).toBe('constraint');
      expect(result.hit.via).toBe('lemmatized');
      expect(result.hit.hint).toBe('复数形式');
    }
  });

  it('导入词库也没有时仍返回 unlisted（不假装查到）', async () => {
    const dict = await makeDict([entry('run')], []);
    const imported = async () => null;
    const result = await querySelectionAsync('zzzz', dict, {}, imported);
    expect(result).toEqual({ kind: 'unlisted', surface: 'zzzz' });
  });

  it('内置命中时不问导入词库（省一次消息）', async () => {
    const dict = await makeDict([entry('run')], []);
    const imported = vi.fn(async () => null);
    const result = await querySelectionAsync('run', dict, {}, imported);
    expect(result.kind).toBe('hit');
    expect(imported).not.toHaveBeenCalled();
  });

  it('没注入导入查询时行为与之前完全一致', async () => {
    const dict = await makeDict([entry('run')], []);
    const result = await querySelectionAsync('constraint', dict);
    expect(result).toEqual({ kind: 'unlisted', surface: 'constraint' });
  });
});

describe('FR-A16 完整性：选区两端多带了空白（用户实测反馈）', () => {
  it('尾部多一个空格：不应因此判成 partial', async () => {
    const dict = await makeDict([entry('adventure')], []);
    // 页面上是 "...adventure of..."，用户拖选成 "adventure "（多选一个空格）。
    // 从"整个词的边界"看，词的右边是空格，空格右边才是下一个词——
    // 也就是说 after 应该按"跳过空白后看下一个字符"来判，而不是直接取空格后一位。
    // adjacentChars 看到"选区自身尾部是空白"就返回空串（边界干净）
    const verdict = querySelection('adventure ', dict, { before: ' ', after: '' });
    expect(verdict.kind).toBe('hit');
  });

  it('头部多一个空格：同理不应判 partial', async () => {
    const dict = await makeDict([entry('adventure')], []);
    // 选区自身头部是空白 → before 返回空串
    const verdict = querySelection(' adventure', dict, { before: '', after: ' ' });
    expect(verdict.kind).toBe('hit');
  });

  it('真·切在词中间仍然拒绝（不能因为放宽而误伤）', async () => {
    const dict = await makeDict([entry('adventure')], []);
    const verdict = querySelection('adventur', dict, { before: ' ', after: 'e' });
    expect(verdict).toMatchObject({ kind: 'rejected', reason: 'partial' });
  });
});

describe('FR-A16：连字符词只选一半（机制，不是缺陷）', () => {
  it('daisy-chain 只选 daisy（右侧紧邻 -）判 partial', async () => {
    const dict = await makeDict([entry('daisy-chain')], []);
    const verdict = querySelection('daisy', dict, { before: ' ', after: '-' });
    expect(verdict).toMatchObject({ kind: 'rejected', reason: 'partial' });
  });

  it('daisy-chain 只选 chain（左侧紧邻 -）判 partial', async () => {
    const dict = await makeDict([entry('daisy-chain')], []);
    const verdict = querySelection('chain', dict, { before: '-', after: ' ' });
    expect(verdict).toMatchObject({ kind: 'rejected', reason: 'partial' });
  });

  it('整个 daisy-chain 选中就命中', async () => {
    const dict = await makeDict([entry('daisy-chain')], []);
    const verdict = querySelection('daisy-chain', dict, { before: ' ', after: ' ' });
    expect(verdict.kind).toBe('hit');
  });
});