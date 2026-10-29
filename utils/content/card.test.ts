/**
 * 卡片内容模型的单测（PLAN.md FR-A5、FR-A6、FR-B3c、FR-B4）。
 *
 * FR-A5 把弹窗内容点名为"词形、美音音标、多词性中文释义、考试标签、词频、变形、发音按钮、
 * 遇见次数、来源例句"，因此这里逐项断言**四段结构里都要有位置**——
 * 断言的是内容模型，不是 DOM，因为"能不能显示"与"怎么画"是两件事。
 */
import { describe, expect, it } from 'vitest';
import type { DictEntry } from '../dict/types';
import type { LookupHit } from '../dict/lookup';
import {
  CARD_ACTIONS,
  cardFromHit,
  cardFromUnlisted,
  definitionText,
  visibleActions,
  type CardContext,
} from './card';

function entry(patch: Partial<DictEntry> = {}): DictEntry {
  return {
    lemma: 'run',
    phoneticUs: '/rʌn/',
    phoneticUk: '',
    pos: ['v.', 'n.'],
    defZh: ['跑', '奔跑'],
    ...patch,
  };
}

const emptyContext: CardContext = { meetCount: 0, firstSeenAt: null, examples: [] };

const hit = (patch: Partial<LookupHit> = {}): LookupHit => ({
  entry: entry(),
  via: 'direct',
  ...patch,
});

describe('FR-A5：四段内容齐备', () => {
  it('词形与美音音标', () => {
    const card = cardFromHit('run', hit(), emptyContext);
    expect(card.head.surface).toBe('run');
    expect(card.head.phoneticUs).toBe('/rʌn/');
    // 本期英音整列去掉
    expect(card.head).not.toHaveProperty('phoneticUk');
  });

  it('多词性中文释义按词性切分', () => {
    const card = cardFromHit('run', hit(), emptyContext);
    expect(card.senses).toEqual([
      { pos: 'v.', defZh: ['跑'] },
      { pos: 'n.', defZh: ['奔跑'] },
    ]);
  });

  it('遇见次数与首次日期', () => {
    const card = cardFromHit('run', hit(), { ...emptyContext, meetCount: 7, firstSeenAt: 1000 });
    expect(card.meta.meetCount).toBe(7);
    expect(card.meta.firstSeenAt).toBe(1000);
  });

  it('来源例句', () => {
    const card = cardFromHit('run', hit(), {
      ...emptyContext,
      examples: [{ text: 'I run daily.', source: 'example.com', at: 2000 }],
    });
    expect(card.examples).toHaveLength(1);
    expect(card.examples[0]!.source).toBe('example.com');
  });

  it('考试标签与词频本期为空（等 FR-B7 导入）', () => {
    const card = cardFromHit('run', hit(), emptyContext);
    expect(card.meta.tags).toEqual([]);
    expect(card.meta.rank).toBeNull();
  });

  it('导入后传入标签与排名能透传', () => {
    const card = cardFromHit('run', hit(), { ...emptyContext, tags: ['cet4'], rank: 512 });
    expect(card.meta.tags).toEqual(['cet4']);
    expect(card.meta.rank).toBe(512);
  });

  it('词性比释义多时不虚增条目（释义才是主数据）', () => {
    const card = cardFromHit(
      'x',
      hit({ entry: entry({ pos: ['n.', 'v.', 'adj.'], defZh: ['甲'] }) }),
      emptyContext,
    );
    // defZh 只有 1 条 → 只出 1 个 sense。
    // 旧实现按 pos 数造 3 条、缺的那条回退首个释义（虚增且重复），已改。
    expect(card.senses).toHaveLength(1);
    expect(card.senses![0]!.defZh[0]).toBe('甲');
  });
});

describe('FR-B3c / FR-B3：变形提示', () => {
  it('独立词条优先时不显示"原形 X"（避免误导）', () => {
    const card = cardFromHit('saw', hit(), emptyContext);
    expect(card.head.inflectionHint).toBeNull();
  });

  it('同形冲突附"see 的过去式"', () => {
    const card = cardFromHit(
      'saw',
      hit({ inflectionOf: { lemma: 'see', hint: '过去式' } }),
      emptyContext,
    );
    expect(card.head.inflectionHint).toBe('see 的过去式');
  });

  it('走还原时页面词形与原形都保留', () => {
    const card = cardFromHit(
      'running',
      hit({ entry: entry(), via: 'lemmatized', hint: '现在分词' }),
      emptyContext,
    );
    expect(card.head.surface).toBe('running');
    expect(card.head.lemma).toBe('run');
    expect(card.head.inflectionHint).toBe('原形 run');
  });
});

describe('FR-B4：未收录', () => {
  it('标记 unlisted 且无释义，但保留词形与统计', () => {
    const card = cardFromUnlisted('zzzz', { ...emptyContext, meetCount: 2 });
    expect(card.unlisted).toBe(true);
    expect(card.senses).toBeNull();
    expect(card.head.surface).toBe('zzzz');
    expect(card.meta.meetCount).toBe(2);
  });
});

describe('FR-A6：操作词汇表', () => {
  it('包含六个基础操作 + 手动收藏', () => {
    expect([...CARD_ACTIONS]).toEqual([
      'collect',
      'mark-known',
      'mark-new',
      'ignore',
      'speak',
      'copy-definition',
      'open-manager',
      'llm-define',
    ]);
  });
});

/**
 * 主操作三选一（FR-A6 的交互约定，手动收藏轮修订）：
 * - 未加入生词本 → 「加入生词本」（**默认必须手动点**，避免误选把词收进来）
 * - 已加入且 `new` → 「标记为已掌握」
 * - 已加入且 `known` / `ignored` → 「改回生词」
 */
describe('FR-A6：主操作三选一', () => {
  it('未加入生词本 → 「加入生词本」', () => {
    expect(visibleActions({ inBook: false, status: 'new' })[0]).toBe('collect');
  });

  it('已加入且是生词 → 「标记为已掌握」', () => {
    expect(visibleActions({ inBook: true, status: 'new' })[0]).toBe('mark-known');
  });

  it('已掌握 / 忽略 → 「改回生词」', () => {
    expect(visibleActions({ inBook: true, status: 'known' })[0]).toBe('mark-new');
    expect(visibleActions({ inBook: true, status: 'ignored' })[0]).toBe('mark-new');
  });

  it('未加入时不显示「忽略」（忽略一个不在生词本里的词没有意义）', () => {
    const actions = visibleActions({ inBook: false, status: 'new' });
    expect(actions).not.toContain('ignore');
    expect(actions).toContain('copy-definition');
    expect(actions).toContain('open-manager');
  });

  it('已加入时次要操作含「忽略」', () => {
    expect(visibleActions({ inBook: true, status: 'new' })).toContain('ignore');
  });

  it('FR-I3：没有可用语音时不出现发音按钮', () => {
    expect(visibleActions({ inBook: false, status: 'new' }, false)).not.toContain('speak');
  });

  it('FR-B4：未收录卡片提供 LLM 释义入口，已命中词条不显示', () => {
    expect(visibleActions({ inBook: false, status: 'new', unlisted: true })).toContain('llm-define');
    expect(visibleActions({ inBook: false, status: 'new', unlisted: false })).not.toContain('llm-define');
  });
});

describe('FR-A6：复制释义的文本', () => {
  it('含词形、音标与各行释义', () => {
    const card = cardFromHit('run', hit(), emptyContext);
    expect(definitionText(card)).toBe('run /rʌn/\nv. 跑\nn. 奔跑');
  });

  it('没有音标时不留多余空格', () => {
    const card = cardFromHit('run', hit({ entry: entry({ phoneticUs: '' }) }), emptyContext);
    expect(definitionText(card).split('\n')[0]).toBe('run');
  });

  it('未收录时退化为词形本身', () => {
    expect(definitionText(cardFromUnlisted('zzzz', emptyContext))).toBe('zzzz');
  });

  it('释义为空时不产生空行', () => {
    const card = cardFromHit('run', hit({ entry: entry({ defZh: [] }) }), emptyContext);
    const lines = definitionText(card).split('\n');
    expect(lines.every((l) => l.trim() !== '')).toBe(true);
  });

  it('导入词（defZh 自带词性）复制出来也不重复词性', () => {
    const card = cardFromHit(
      'goofy',
      hit({ entry: entry({ lemma: 'goofy', pos: ['a.'], defZh: ['a. 愚蠢的, 傻瓜的'] }) }),
      emptyContext,
    );
    expect(definitionText(card)).toBe('goofy /rʌn/\na. 愚蠢的, 傻瓜的');
  });
});
