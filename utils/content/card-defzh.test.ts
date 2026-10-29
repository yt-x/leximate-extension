/**
 * 卡片释义组装：`pos` 为空但有 `defZh` 时不能丢释义。
 *
 * 用户实测 2026-10-22：划 `dispatching` 显示未收录 / 无释义。
 * dict 里它有 defZh=`["[计] 调度的, 发送的"]`，但 `pos` 为空
 * （ECDICT 的 `[计]` 前缀不是标准词性标记 → posFromTranslation 返回 []）。
 * 原实现 `senses: entry.pos.map(...)` 在 pos 为空时产出空数组 → 卡片无释义。
 */
import { describe, expect, it } from 'vitest';

import { cardFromHit } from './card';
import type { DictEntry } from '../dict/types';
import type { LookupHit } from '../dict/lookup';

function entry(fields: Partial<DictEntry> & { lemma: string }): DictEntry {
  return {
    phoneticUs: '',
    phoneticUk: '',
    pos: [],
    defZh: [],
    ...fields,
  };
}

const context = {
  tags: [],
  rank: null,
  meetCount: 0,
  firstSeenAt: null,
  status: 'new' as const,
  inBook: false,
  examples: [],
  canSpeak: true,
};

function hit(e: DictEntry): LookupHit {
  return { entry: e, via: 'direct' as const };
}

describe('cardFromHit：释义组装不能依赖 pos', () => {
  it('pos 为空但 defZh 有值（dispatching 的情形）→ senses 必须有释义', () => {
    const card = cardFromHit(
      'dispatching',
      hit(entry({ lemma: 'dispatching', defZh: ['[计] 调度的, 发送的'], pos: [] })),
      context,
    );
    expect(card.senses).not.toBeNull();
    expect(card.senses!.length).toBeGreaterThan(0);
    const allDefs = card.senses!.flatMap((s) => s.defZh).filter(Boolean);
    expect(allDefs.join('|')).toContain('调度的');
  });

  it('pos 与 defZh 一一对应时，senses 按词性分组', () => {
    const card = cardFromHit(
      'run',
      hit(entry({ lemma: 'run', pos: ['v.', 'n.'], defZh: ['跑', '奔跑'] })),
      context,
    );
    expect(card.senses).toEqual([
      { pos: 'v.', defZh: ['跑'] },
      { pos: 'n.', defZh: ['奔跑'] },
    ]);
  });

  it('pos 有值但 defZh 比 pos 多时，多出的释义不丢', () => {
    const card = cardFromHit(
      'x',
      hit(entry({ lemma: 'x', pos: ['n.'], defZh: ['释义一', '释义二'] })),
      context,
    );
    const allDefs = card.senses!.flatMap((s) => s.defZh).filter(Boolean);
    expect(allDefs).toContain('释义一');
    expect(allDefs).toContain('释义二');
  });

  it('defZh 为空时 senses 为空/null（真的没有释义）', () => {
    const card = cardFromHit('y', hit(entry({ lemma: 'y', pos: [], defZh: [] })), context);
    expect((card.senses ?? []).flatMap((s) => s.defZh).filter(Boolean)).toHaveLength(0);
  });
});

/**
 * 用户实测 2026-10-24：划 `goofy` 卡片显示 `a. a. 愚蠢的, 傻瓜的`——词性重复了两次。
 *
 * 根因：ECDICT 的 `translation` **每行本身就带词性前缀**（`a. 愚蠢的`），
 * `posFromTranslation` 只做「抽取」不做「剥离」，`defZh` 原样保留了前缀，
 * 渲染时又把 `pos` 拼在释义前面，于是 `pos` + `defZh` = `a.` + `a. 愚蠢的`。
 * 内置词表的 defZh 不带前缀（`data/core-words.tsv` 里 `abandon` 是 `放弃；抛弃`），
 * 所以这个问题只在导入词典的词上出现。
 */
describe('cardFromHit：defZh 自带词性前缀时不能与 pos 重复显示', () => {
  it('ECDICT 的 `a. 愚蠢的` + pos `a.` → 只显示一次词性', () => {
    const card = cardFromHit(
      'goofy',
      hit(entry({ lemma: 'goofy', pos: ['a.'], defZh: ['a. 愚蠢的, 傻瓜的'] })),
      context,
    );
    expect(card.senses).toEqual([{ pos: 'a.', defZh: ['愚蠢的, 傻瓜的'] }]);
  });

  it('多行各自带前缀时逐行剥离', () => {
    const card = cardFromHit(
      'x',
      hit(entry({ lemma: 'x', pos: ['n.', 'v.'], defZh: ['n. 名词义', 'v. 动词义'] })),
      context,
    );
    expect(card.senses).toEqual([
      { pos: 'n.', defZh: ['名词义'] },
      { pos: 'v.', defZh: ['动词义'] },
    ]);
  });

  it('pos 阵列虽为空但行内有前缀 → 从行里拆出词性，不丢也不重复', () => {
    const card = cardFromHit(
      'x',
      hit(entry({ lemma: 'x', pos: [], defZh: ['a. 愚蠢的'] })),
      context,
    );
    expect(card.senses).toEqual([{ pos: 'a.', defZh: ['愚蠢的'] }]);
  });

  it('释义里恰好以同样字母开头但没有点号时不误剥（`ad hoc`）', () => {
    const card = cardFromHit(
      'adhoc',
      hit(entry({ lemma: 'adhoc', pos: ['a.'], defZh: ['ad hoc 临时的'] })),
      context,
    );
    expect(card.senses).toEqual([{ pos: 'a.', defZh: ['ad hoc 临时的'] }]);
  });

  /**
   * `posFromTranslation` 会**跳过**没有词性前缀的行（`continue`），而 `defZh` 保留全部行，
   * 所以 `pos[i]` 与 `defZh[i]` 不保证一一对应。首行没有前缀时，直接按索引取 pos
   * 会把下一行的词性错标到首行释义上，同时把首行释义归到错误的词性下。
   */
  it('首行没有词性前缀时，不能把下一行的词性错标给它', () => {
    const card = cardFromHit(
      'x',
      hit(entry({ lemma: 'x', pos: ['n.'], defZh: ['泛指某种东西', 'n. 名词义'] })),
      context,
    );
    expect(card.senses).toEqual([
      { pos: '', defZh: ['泛指某种东西'] },
      { pos: 'n.', defZh: ['名词义'] },
    ]);
  });
});
