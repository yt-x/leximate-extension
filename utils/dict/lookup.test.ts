import { describe, expect, it } from 'vitest';
import { createDictLookup, normalizeSurface } from './lookup';
import { createMemorySource } from './source';
import type { DictEntry, DictIndex, DictShard } from './types';

function entry(lemma: string, defZh = '释义'): DictEntry {
  return { lemma, phoneticUs: '/test/', phoneticUk: '', pos: ['n.'], defZh: [defZh] };
}

/** 造一个 core + 若干字母分片的词表，模拟构建脚本的产物 */
function fixture(
  hot: DictEntry[],
  extra: Record<string, DictEntry[]> = {},
): Record<string, string> {
  const files: Record<string, string> = {};

  const shards: DictShard[] = [{ name: 'core', words: Object.fromEntries(hot.map((e) => [e.lemma, e])) }];
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

  files['index.json'] = JSON.stringify(index);
  for (const shard of shards) files[`shard-${shard.name}.json`] = JSON.stringify(shard);
  return files;
}

describe('划词归一化', () => {
  it('去掉首尾引号与标点、统一大小写与全角撇号', () => {
    expect(normalizeSurface('  "Running," ')).toBe('running');
    expect(normalizeSurface('(don’t)')).toBe("don't");
    expect(normalizeSurface('Word.')).toBe('word');
    expect(normalizeSurface('  ')).toBe('');
  });
});

describe('查询层', () => {
  it('warm 之后常驻词条可同步查到，且带上词表版本', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run', '跑')])));
    expect(dict.isWarm()).toBe(false);

    await dict.warm();

    expect(dict.isWarm()).toBe(true);
    expect(dict.entryCount()).toBe(1);
    expect(dict.dictVersion()).toBe('9.9.9');
    expect(dict.lookup('run')?.entry.defZh).toEqual(['跑']);
  });

  it('查不到返回 undefined，不抛错', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run')])));
    await dict.warm();
    expect(dict.lookup('zzzz')).toBeUndefined();
    expect(dict.lookup('')).toBeUndefined();
  });

  it('未 warm 时查询只返回 undefined，不炸', () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run')])));
    expect(dict.lookup('run')).toBeUndefined();
  });

  it('大小写与标点噪声不影响命中', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run', '跑')])));
    await dict.warm();
    // 只清噪声、不还原词形：Running 归一后是 running，那是 M1-4 的活儿
    expect(dict.lookup('Run,')?.entry.lemma).toBe('run');
    expect(dict.lookup('"RUN"')?.entry.lemma).toBe('run');
  });

  it('只差词形（未接入还原器）时老实报未收录，不乱猜', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run', '跑')])));
    await dict.warm();
    expect(dict.lookup('Running')).toBeUndefined();
  });

  it('接入词形还原后，变形能查到原形（FR-B3）', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run', '跑')])), {
      lemmatize: (surface) => (surface === 'running' ? { lemma: 'run', hint: '现在分词' } : null),
    });
    await dict.warm();

    expect(dict.lookup('running')?.entry.defZh).toEqual(['跑']);
    // 还原不出来就老实返回未收录
    expect(dict.lookup('ran')).toBeUndefined();
  });

  it('未接入词形还原时不做任何猜测', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run')])));
    await dict.warm();
    expect(dict.lookup('running')).toBeUndefined();
  });
});

describe('FR-B3c：独立词条优先于词形还原', () => {
  it('surface 本身是词条时用独立词义，不被还原覆盖', async () => {
    // saw 既是"锯子"（独立词条）又是 see 的过去式
    const dict = createDictLookup(createMemorySource(fixture([entry('saw', '锯子'), entry('see', '看见')])), {
      lemmatize: (surface) => (surface === 'saw' ? { lemma: 'see', hint: '过去式' } : null),
    });
    await dict.warm();

    const hit = dict.lookup('saw');
    expect(hit?.via).toBe('direct');
    expect(hit?.entry.defZh).toEqual(['锯子']); // 独立词义没被覆盖
    // 但变形线索仍然给出，供卡片附一行"see 的过去式"
    expect(hit?.inflectionOf).toEqual({ lemma: 'see', hint: '过去式' });
  });

  it('surface 不是词条时才走还原', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('see', '看见')])), {
      lemmatize: (surface) => (surface === 'saw' ? { lemma: 'see', hint: '过去式' } : null),
    });
    await dict.warm();

    const hit = dict.lookup('saw');
    expect(hit?.via).toBe('lemmatized');
    expect(hit?.entry.defZh).toEqual(['看见']);
    expect(hit?.hint).toBe('过去式');
    expect(hit?.inflectionOf).toBeUndefined();
  });

  it('独立词条存在且没有变形线索时不带 inflectionOf', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run', '跑')])), {
      lemmatize: () => null,
    });
    await dict.warm();

    const hit = dict.lookup('run');
    expect(hit?.via).toBe('direct');
    expect(hit?.inflectionOf).toBeUndefined();
  });

  it('还原出的原形不在词库时，不假装查到', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run', '跑')])), {
      lemmatize: (surface) => (surface === 'went' ? { lemma: 'go', hint: '过去式' } : null),
    });
    await dict.warm();
    // go 不在这份词表里 → 未收录，走 FR-B4
    expect(dict.lookup('went')).toBeUndefined();
  });

  it('低频词在按需分片里，ensureFor 拉下来的才能查到', async () => {
    const dict = createDictLookup(
      createMemorySource(fixture([entry('the')], { z: [entry('zebra', '斑马')] })),
    );
    await dict.warm();

    expect(dict.loadedShards()).toEqual(['core']);
    expect(dict.lookup('zebra')).toBeUndefined();

    expect(await dict.ensureFor('zebra')).toBe(true);
    expect(dict.loadedShards()).toEqual(['core', 'z']);
    expect(dict.lookup('zebra')?.entry.defZh).toEqual(['斑马']);

    // 已加载过就不再重复拉
    expect(await dict.ensureFor('zebra')).toBe(false);
  });

  it('该首字母本来就没有分片时，ensureFor 返回 false 而不是报错', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('the')])));
    await dict.warm();
    expect(await dict.ensureFor('zebra')).toBe(false);
  });

  it('清单里没有常驻分片时，warm 明确报错而不是静默少词', async () => {
    const files = fixture([entry('run')]);
    files['index.json'] = JSON.stringify({
      version: '1.0.0',
      generatedAt: '',
      count: 0,
      shards: [],
    } satisfies DictIndex);

    const dict = createDictLookup(createMemorySource(files));
    await expect(dict.warm()).rejects.toThrow('没有常驻分片 core');
  });

  it('分片文件缺失时报错里带上文件名', async () => {
    const dict = createDictLookup(createMemorySource({ 'index.json': fixture([entry('run')])['index.json']! }));
    await expect(dict.warm()).rejects.toThrow('shard-core.json');
  });

  it('重复 warm 不会把词条数翻倍', async () => {
    const dict = createDictLookup(createMemorySource(fixture([entry('run')])));
    await dict.warm();
    await dict.warm();
    expect(dict.entryCount()).toBe(1);
  });
});

describe('性能预算', () => {
  const words: DictEntry[] = Array.from({ length: 1000 }, (_, i) => entry(`word${i}`));

  it('单次查询 < 5ms（FR-B2）', async () => {
    const dict = createDictLookup(createMemorySource(fixture(words)));
    await dict.warm();

    const started = performance.now();
    for (let i = 0; i < 1000; i++) dict.lookup('word500');
    const perLookup = (performance.now() - started) / 1000;

    expect(perLookup).toBeLessThan(5);
  });

  it('首屏标注 1000 词 < 50ms（M1-3 验收）', async () => {
    const dict = createDictLookup(createMemorySource(fixture(words)));
    await dict.warm();

    const started = performance.now();
    let hits = 0;
    for (const w of words) if (dict.lookup(w.lemma)) hits++;
    const elapsed = performance.now() - started;

    expect(hits).toBe(1000);
    expect(elapsed).toBeLessThan(50);
  });
});
