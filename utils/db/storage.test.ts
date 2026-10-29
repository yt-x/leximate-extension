/**
 * 行为验证：词与例句的读写语义、设置合并、以及 1 万词列表的性能预算（FR-E2）。
 */
import { describe, expect, it } from 'vitest';
import {
  addScene,
  countScenes,
  countWords,
  listNewWords,
  domainOf,
  getSettings,
  getWordByLemma,
  getWordCard,
  listScenesByWord,
  listWords,
  normalizeLemma,
  openDb,
  setMeta,
  getMeta,
  setSettings,
  softDeleteWord,
  STORE,
  updateWordStatus,
  upsertWord,
  writeTx,
  readTx,
  req,
  DEFAULT_SETTINGS,
} from './index';

describe('生词写入', () => {
  it('首次遇见建一条，meetCount 为 1', async () => {
    const { word, created } = await upsertWord({ lemma: 'run', surface: 'run', now: 100 });
    expect(created).toBe(true);
    expect(word.meetCount).toBe(1);
    expect(word.status).toBe('new');
    expect(word.origin).toBe('native');
    expect(word.createdAt).toBe(100);
    expect(word.deletedAt).toBeNull();
  });


  it('再次遇见同词只累加次数，不新建记录', async () => {
    const first = await upsertWord({ lemma: 'run', now: 100 });
    const second = await upsertWord({ lemma: 'run', now: 200 });

    expect(second.created).toBe(false);
    expect(second.word.id).toBe(first.word.id);
    expect(second.word.meetCount).toBe(2);
    expect(second.word.updatedAt).toBe(200);
    expect(second.word.createdAt).toBe(100);
    expect(await countWords()).toBe(1);
  });

  it('原形归一为小写；仅大小写差异不算词形还原', async () => {
    const { word } = await upsertWord({ lemma: '  Running ', surface: 'Running', now: 1 });
    expect(word.lemma).toBe('running');
    expect(word.surface).toBe('Running');
    expect(word.isLemmatized).toBe(false);
  });

  it('surface 是变形时标记为词形还原', async () => {
    const { word } = await upsertWord({ lemma: 'run', surface: 'Runs', now: 1 });
    expect(word.lemma).toBe('run');
    expect(word.surface).toBe('Runs');
    expect(word.isLemmatized).toBe(true);
  });

  it('surface 保留首次遇见的形态，不被后来的遇见改写', async () => {
    await upsertWord({ lemma: 'run', surface: 'running', now: 1 });
    const { word } = await upsertWord({ lemma: 'run', surface: 'ran', now: 2 });
    expect(word.surface).toBe('running');
  });

  it('只补齐空字段，不覆盖已有释义', async () => {
    await upsertWord({
      lemma: 'run',
      defZh: ['跑'],
      defSrc: 'authored',
      phoneticUs: '/rʌn/',
      phoneticSrc: 'pipeline',
      now: 1,
    });
    const { word } = await upsertWord({
      lemma: 'run',
      defZh: ['覆盖我不该生效'],
      defSrc: 'imported',
      phoneticUs: '/别的/',
      phoneticSrc: 'imported',
      phoneticUk: '/rʌn uk/',
      examTags: ['cet4'],
      now: 2,
    });

    expect(word.defZh).toEqual(['跑']);
    expect(word.phoneticUs).toBe('/rʌn/');
    expect(word.phoneticUk).toBe('/rʌn uk/');
    expect(word.examTags).toEqual(['cet4']);
    // 来源标记跟着字段一起保留——已有来源不该被后来一次查询改写
    expect(word.defSrc).toBe('authored');
    expect(word.phoneticSrc).toBe('pipeline');
  });

  it('FR-B9：带了音标却不给来源，直接拒绝而不是写出一条无来源标记的音标', async () => {
    await expect(upsertWord({ lemma: 'run', phoneticUs: '/rʌn/' })).rejects.toThrow(
      '没有 phoneticSrc',
    );
  });

  it('FR-B10：带了释义却不给来源，同样拒绝', async () => {
    await expect(upsertWord({ lemma: 'run', defZh: ['跑'] })).rejects.toThrow('没有 defSrc');
  });

  it('FR-B9/B10：没有音标也没有释义时，来源为空是合法的', async () => {
    const { word } = await upsertWord({ lemma: 'run' });
    expect(word.phoneticSrc).toBeNull();
    expect(word.defSrc).toBeNull();
  });

  it('FR-B3c：inflectionOf 只在空着时补，不覆盖已有提示', async () => {
    await upsertWord({ lemma: 'see', now: 1 });
    const first = await upsertWord({ lemma: 'see', inflectionOf: 'see', now: 2 });
    expect(first.word.inflectionOf).toBe('see');
    const second = await upsertWord({ lemma: 'see', inflectionOf: '别的', now: 3 });
    expect(second.word.inflectionOf).toBe('see');
  });

  it('lemma 为空直接拒绝', async () => {
    await expect(upsertWord({ lemma: '   ' })).rejects.toThrow('lemma 不能为空');
  });

  it('normalizeLemma 与 domainOf 的边界', () => {
    expect(normalizeLemma('  COVID-19 ')).toBe('covid-19');
    expect(normalizeLemma('Naïve')).toBe('naïve');
    expect(domainOf('https://www.example.com/a/b?c=1')).toBe('www.example.com');
    expect(domainOf('not a url')).toBe('');
  });
});

describe('列表查询（FR-E2 / FR-F1）', () => {
  it('按 createdAt 倒序是默认行为', async () => {
    await upsertWord({ lemma: 'a', now: 1 });
    await upsertWord({ lemma: 'b', now: 2 });
    await upsertWord({ lemma: 'c', now: 3 });
    expect((await listWords()).map((w) => w.lemma)).toEqual(['c', 'b', 'a']);
    expect((await listWords({ direction: 'asc' })).map((w) => w.lemma)).toEqual(['a', 'b', 'c']);
  });

  it('按 lemma 排序与按 meetCount 排序', async () => {
    await upsertWord({ lemma: 'zebra', now: 1 });
    await upsertWord({ lemma: 'apple', now: 2 });
    await upsertWord({ lemma: 'apple', now: 3 });

    expect((await listWords({ orderBy: 'lemma', direction: 'asc' })).map((w) => w.lemma)).toEqual([
      'apple',
      'zebra',
    ]);
    expect((await listWords({ orderBy: 'meetCount' })).map((w) => w.lemma)).toEqual([
      'apple',
      'zebra',
    ]);
  });

  it('状态过滤走索引，搜索匹配原形与 surface', async () => {
    await upsertWord({ lemma: 'keep', now: 1 });
    await upsertWord({ lemma: 'drop', now: 2 });
    await upsertWord({ lemma: 'other', surface: 'Otherly', now: 3 });
    const drop = await getWordByLemma('drop');
    await updateWordStatus(drop!.id, 'ignored');

    expect(await countWords({ status: 'new' })).toBe(2);
    expect((await listWords({ status: 'ignored' })).map((w) => w.lemma)).toEqual(['drop']);
    expect((await listWords({ search: 'other' })).map((w) => w.lemma)).toEqual(['other']);
    expect((await listWords({ search: 'THERLY' })).map((w) => w.lemma)).toEqual(['other']);
  });

  it('分页', async () => {
    for (let i = 0; i < 5; i++) await upsertWord({ lemma: `w${i}`, now: i });
    expect((await listWords({ limit: 2 })).map((w) => w.lemma)).toEqual(['w4', 'w3']);
    expect((await listWords({ limit: 2, offset: 2 })).map((w) => w.lemma)).toEqual(['w2', 'w1']);
  });
});

describe('软删除与复活', () => {
  it('软删除后默认不出现，includeDeleted 时可见', async () => {
    const { word } = await upsertWord({ lemma: 'bye', now: 1 });
    expect(await softDeleteWord(word.id)).toBe(true);

    expect(await listWords()).toHaveLength(0);
    expect(await listWords({ includeDeleted: true })).toHaveLength(1);
    expect((await getWordByLemma('bye'))!.deletedAt).toBeTypeOf('number');
  });

  it('删除后再次遇见会复活墓碑', async () => {
    const { word } = await upsertWord({ lemma: 'revive', now: 1 });
    await softDeleteWord(word.id);
    const again = await upsertWord({ lemma: 'revive', now: 2 });

    expect(again.word.id).toBe(word.id);
    expect(again.word.deletedAt).toBeNull();
    expect(await listWords()).toHaveLength(1);
  });

  it('软删除不存在的词返回 false', async () => {
    expect(await softDeleteWord('nope')).toBe(false);
  });
});

/**
 * 角标文案的第二条分句是"0 时不显示角标"（FR-A14），
 * 而角标数来自 `countWords()`。
 *
 * ⚠️ 墓碑（`deletedAt`）是**给同步用的删除标记**，不是"遇见的词"。
 * 用户批量删完生词之后角标如果不掉，看的就是墓碑的数量。
 */
/**
 * §4.5 P3 的"生词集合由 SW 一次性下发"：内容脚本靠这份集合判断
 * "页面上的这个词该不该画下划线"。因此它必须**只含生词、不含墓碑**，
 * 并带上遇见次数（FR-A11 的分档要用）。
 */
describe('FR-A9：下划线集合（listNewWords）', () => {
  it('只含 status = new 的词，带遇见次数', async () => {
    await upsertWord({ lemma: 'alpha', now: 1 });
    await upsertWord({ lemma: 'alpha', now: 2 }); // 遇见两次
    await upsertWord({ lemma: 'beta', now: 3 });
    const gamma = await upsertWord({ lemma: 'gamma', now: 4 });
    await updateWordStatus(gamma.word.id, 'known');

    const list = await listNewWords();

    expect(list.sort((a, b) => a.word.localeCompare(b.word))).toEqual([
      { word: 'alpha', meetCount: 2 },
      { word: 'beta', meetCount: 1 },
    ]);
  });


  it('不含墓碑（删掉的词不该继续被画下划线）', async () => {
    const gone = await upsertWord({ lemma: 'gone', now: 1 });
    await softDeleteWord(gone.word.id);

    expect(await listNewWords()).toEqual([]);
  });

  it('被忽略的词也不在集合里（FR-A10：忽略后下划线消失）', async () => {
    const ignored = await upsertWord({ lemma: 'ignored', now: 1 });
    await updateWordStatus(ignored.word.id, 'ignored');

    expect(await listNewWords()).toEqual([]);
  });

  it('空库时返回空数组（不是 undefined）', async () => {
    expect(await listNewWords()).toEqual([]);
  });
});

describe('FR-A14：计数不含墓碑', () => {
  it('软删除后计数减少，需要数墓碑时显式要 includeDeleted', async () => {
    const alpha = await upsertWord({ lemma: 'alpha', now: 1 });
    await upsertWord({ lemma: 'beta', now: 2 });
    expect(await countWords()).toBe(2);

    await softDeleteWord(alpha.word.id);

    expect(await countWords()).toBe(1);
    expect(await countWords({ includeDeleted: true })).toBe(2);
  });

  it('按状态计数时同样排除墓碑', async () => {
    const alpha = await upsertWord({ lemma: 'alpha', now: 1 });
    await upsertWord({ lemma: 'beta', now: 2 });
    await softDeleteWord(alpha.word.id);

    expect(await countWords({ status: 'new' })).toBe(1);
  });

  it('全部删除后计数为 0（角标该消失）', async () => {
    const only = await upsertWord({ lemma: 'only', now: 1 });
    await softDeleteWord(only.word.id);

    expect(await countWords()).toBe(0);
  });
});

describe('例句', () => {
  it('同词同句只存一条', async () => {
    const { word } = await upsertWord({ lemma: 'run', now: 1 });
    const first = await addScene({
      wordId: word.id,
      text: 'I run every day.',
      highlightFrom: 2,
      highlightTo: 5,
      sourceUrl: 'https://example.com/post',
    });
    const second = await addScene({
      wordId: word.id,
      text: 'I run every day.',
      highlightFrom: 2,
      highlightTo: 5,
      sourceUrl: 'https://example.com/other',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.scene.id).toBe(first.scene.id);
    expect(await countScenes()).toBe(1);
  });

  it('不同词的同名句子各自保留', async () => {
    const a = await upsertWord({ lemma: 'alpha', now: 1 });
    const b = await upsertWord({ lemma: 'beta', now: 2 });
    await addScene({ wordId: a.word.id, text: 'same text', highlightFrom: 0, highlightTo: 4, sourceUrl: 'https://x.com' });
    await addScene({ wordId: b.word.id, text: 'same text', highlightFrom: 0, highlightTo: 4, sourceUrl: 'https://x.com' });
    expect(await countScenes()).toBe(2);
  });

  it('例句带上域名，非法 URL 不炸', async () => {
    const { word } = await upsertWord({ lemma: 'dom', now: 1 });
    const ok = await addScene({
      wordId: word.id,
      text: 'from a real page',
      highlightFrom: 0,
      highlightTo: 4,
      sourceUrl: 'https://news.ycombinator.com/item?id=1',
    });
    const bad = await addScene({
      wordId: word.id,
      text: 'from nowhere',
      highlightFrom: 0,
      highlightTo: 4,
      sourceUrl: 'nonsense',
    });

    expect(ok.scene.domain).toBe('news.ycombinator.com');
    expect(bad.scene.domain).toBe('');
  });

  it('按词取例句时按捕获时间升序', async () => {
    const { word } = await upsertWord({ lemma: 'order', now: 1 });
    await addScene({ wordId: word.id, text: 'third', highlightFrom: 0, highlightTo: 5, sourceUrl: 'https://a.com', capturedAt: 300 });
    await addScene({ wordId: word.id, text: 'first', highlightFrom: 0, highlightTo: 5, sourceUrl: 'https://a.com', capturedAt: 100 });
    await addScene({ wordId: word.id, text: 'second', highlightFrom: 0, highlightTo: 6, sourceUrl: 'https://a.com', capturedAt: 200 });

    expect((await listScenesByWord(word.id)).map((s) => s.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('getWordCard 一次拿到词与它的全部例句', async () => {
    await upsertWord({ lemma: 'card', defZh: ['卡片'], defSrc: 'authored', now: 1 });
    const word = (await getWordByLemma('card'))!;
    await addScene({ wordId: word.id, text: 'a card', highlightFrom: 2, highlightTo: 6, sourceUrl: 'https://a.com' });

    const card = await getWordCard('CARD');
    expect(card!.word.lemma).toBe('card');
    expect(card!.scenes).toHaveLength(1);
    expect(card!.scenes[0]!.highlightTo).toBe(6);
    expect(await getWordCard('missing')).toBeUndefined();
  });
});

describe('设置与元数据', () => {
  it('没有记录时返回默认值', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('patch 一层与两层都能合并，且不丢其他字段', async () => {
    await setSettings({ underlineStyle: 'wavy' });
    const merged = await setSettings({ ui: { ...DEFAULT_SETTINGS.ui, pageSize: 100 } });

    expect(merged.underlineStyle).toBe('wavy');
    expect(merged.ui.pageSize).toBe(100);
    // FR-L1：默认改成 uto（跟随浏览器），解析在 utils/i18n
    expect(merged.ui.language).toBe('auto');
    expect(merged.translation.targetLang).toBe('zh-CN');
  });

  it('值为 undefined 的键不会把已有设置抹成空', async () => {
    await setSettings({ underlineColor: '#123456' });
    const after = await setSettings({ underlineColor: undefined });
    expect(after.underlineColor).toBe('#123456');
  });

  it('老版本写下的残缺设置由默认值补齐', async () => {
    await writeTx(STORE.settings, (tx) =>
      req(tx.objectStore(STORE.settings).put({ key: 'app', value: { underlineStyle: 'solid' } })),
    );
    const settings = await getSettings();
    expect(settings.underlineStyle).toBe('solid');
    expect(settings.translation).toEqual(DEFAULT_SETTINGS.translation);
    expect(settings.minWordLength).toBe(2);
  });

  it('meta 默认值带 schemaVersion 与 installedAt', async () => {
    const meta = await getMeta();
    expect(meta.schemaVersion).toBe(1);
    expect(meta.installedAt).toBeTypeOf('number');
    expect(meta.persistGranted).toBe(false);
  });

  it('meta 可以局部更新', async () => {
    await setMeta({ installedAt: 42 });
    const meta = await setMeta({ lastExportAt: 99 });
    expect(meta.installedAt).toBe(42);
    expect(meta.lastExportAt).toBe(99);
  });
});

describe('性能预算（FR-E2：1 万词列表 < 300ms）', () => {
  it('1 万词整表读取加排序不超预算', async () => {
    const db = await openDb();
    const tx = db.transaction(STORE.words, 'readwrite');
    const store = tx.objectStore(STORE.words);
    for (let i = 0; i < 10_000; i++) {
      store.put({
        id: `seed-${i}`,
        lemma: `word${i}`,
        surface: `word${i}`,
        phoneticUs: '',
        phoneticUk: '',
        defZh: [],
        pos: [],
        examTags: [],
        freqBnc: 0,
        freqCoca: 0,
        exchange: '',
        status: 'new',
        meetCount: 1,
        isLemmatized: false,
        isUnlisted: false,
        origin: 'native',
        fallbackDef: [],
        llmDef: [],
        createdAt: i,
        updatedAt: i,
        deletedAt: null,
      });
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    expect(await countWords()).toBe(10_000);

    const started = performance.now();
    const page = await listWords({ limit: 50 });
    const elapsed = performance.now() - started;

    expect(page).toHaveLength(50);
    expect(page[0]!.lemma).toBe('word9999');
    // fake-indexeddb 是进程内实现，与实际 Chromium 的绝对耗时不同，这里只防退化
    expect(elapsed).toBeLessThan(300);
  });
});
