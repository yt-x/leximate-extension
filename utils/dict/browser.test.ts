import { describe, expect, it } from 'vitest';
import { cardFromHit } from '../content/card';
import { createBrowserDictLookup } from './browser';
import { createMemorySource } from './source';
import type { DictEntry } from './types';

function entry(lemma: string, defZh: string): DictEntry {
  return { lemma, phoneticUs: '/test/', phoneticUk: '', pos: ['n.'], defZh: [defZh] };
}

describe('浏览器词库生产装配', () => {
  it('运行时中文 hint 经还原候选保留，saw 卡片显示 see 的过去式', async () => {
    const words = { saw: entry('saw', '锯子'), see: entry('see', '看见') };
    const source = createMemorySource({
      'index.json': JSON.stringify({
        version: '9.9.9',
        generatedAt: '2026-10-28T00:00:00.000Z',
        count: 2,
        shards: [{ name: 'core', file: 'shard-core.json', count: 2, bytes: 0 }],
      }),
      'shard-core.json': JSON.stringify({ name: 'core', words }),
      'inflections.json': JSON.stringify({
        version: 1,
        dictVersion: '9.9.9',
        source: 'Wikidata Lexeme (CC0)',
        count: 1,
        entries: { saw: [{ lemma: 'see', hint: '过去式' }] },
      }),
    });

    const dict = await createBrowserDictLookup(source);
    await dict.warm();
    const hit = dict.lookup('saw');
    expect(hit?.via).toBe('direct');
    expect(hit?.entry.defZh).toEqual(['锯子']);

    const card = cardFromHit('saw', hit!, { meetCount: 0, firstSeenAt: null, examples: [] });
    expect(card.head.inflectionHint).toBe('see 的过去式');
    expect(hit?.inflectionOf).toEqual({ lemma: 'see', hint: '过去式' });
  });
});
