/**
 * 结构层验证：store 与索引是否与 FR-E1 / FR-E2 一致，迁移与清空是否可靠。
 */
import { describe, expect, it } from 'vitest';
import { DB_NAME, openDb, req, resetDbHandle, STORE } from './schema';
import type { DictEntry, Word } from './types';
import { clearAllData } from './maintenance';
import { upsertWord, listWords } from './words';

/** 一条最小可用的词条记录（默认无墓碑） */
function makeWord(patch: Partial<Word> = {}): Word {
  return {
    id: 'a',
    lemma: 'run',
    surface: 'run',
    phoneticUs: '',
    phoneticUk: '',
    phoneticSrc: null,
    defSrc: null,
    defZh: [],
    pos: [],
    examTags: [],
    freqBnc: 0,
    freqCoca: 0,
    exchange: '',
    status: 'new',
    meetCount: 1,
    isLemmatized: false,
    inflectionOf: null,
    isUnlisted: false,
    origin: 'native',
    fallbackDef: [],
    llmDef: [],
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...patch,
  };
}

describe('IndexedDB 结构（FR-E1 / FR-E2）', () => {
  it('建出规格要求的 6 个 store，外加 logs 与词典 dict', async () => {
    const db = await openDb();
    const names = [...db.objectStoreNames].sort();
    expect(names).toEqual([
      STORE.dict,
      STORE.logs,
      STORE.meta,
      STORE.queue,
      STORE.scenes,
      STORE.settings,
      STORE.translations,
      STORE.words,
    ].sort());
  });

  it('words 带 lemma(唯一) / status / createdAt / meetCount / deletedAt 索引', async () => {
    const db = await openDb();
    const tx = db.transaction(STORE.words, 'readonly');
    const indexes = [...tx.objectStore(STORE.words).indexNames].sort();
    // deletedAt 是 v2 加的：角标计数要靠它排除墓碑（见 schema.ts 的 upgrade 注释）
    // v3：lemma 不再唯一（导入词库与用户词条可以同 lemma 共存），改为复合唯一
    expect(indexes).toEqual([
      'createdAt',
      'defSrc',
      'deletedAt',
      'lemma',
      'lemmaDefSrc',
      'meetCount',
      'status',
      'updatedAt',
    ]);
    // lemma 单独不再唯一：同一个词可以既有"用户收藏的"又有"导入词库的"
    expect(tx.objectStore(STORE.words).index('lemma').unique).toBe(false);
    // 复合索引唯一：同一 lemma 在同一种来源下只能有一条
    expect(tx.objectStore(STORE.words).index('lemmaDefSrc').unique).toBe(true);
  });

  it('domain 索引挂在 scenes 上（域名是例句的属性，不是词的）', async () => {
    const db = await openDb();
    const tx = db.transaction(STORE.scenes, 'readonly');
    const indexes = [...tx.objectStore(STORE.scenes).indexNames].sort();
    expect(indexes).toEqual(['capturedAt', 'contentHash', 'domain', 'wordId']);
  });

  it('同一 lemma 允许两种来源共存，但同来源内重复会被挡住（FR-B7）', async () => {
    const db = await openDb();
    const store = db.transaction(STORE.words, 'readwrite').objectStore(STORE.words);
    const base = {
      surface: 'run',
      phoneticUs: '',
      phoneticUk: '',
      phoneticSrc: null,
      defZh: [],
      pos: [],
      examTags: [],
      freqBnc: 0,
      freqCoca: 0,
      exchange: '',
      status: 'new' as const,
      meetCount: 1,
      isLemmatized: false,
      inflectionOf: null,
      isUnlisted: false,
      origin: 'native' as const,
      fallbackDef: [],
      llmDef: [],
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    // 同 lemma、不同来源：允许
    store.add({ ...base, id: 'user-run', lemma: 'run', defSrc: 'authored' });
    store.add({ ...base, id: 'imported-run', lemma: 'run', defSrc: 'imported', meetCount: 0 });

    // 同 lemma、同来源：ConstraintError
    const dup = store.add({ ...base, id: 'imported-run-2', lemma: 'run', defSrc: 'imported', meetCount: 0 });
    await expect(
      new Promise((resolve, reject) => {
        dup.onsuccess = () => resolve('unexpected');
        dup.onerror = () => reject(dup.error);
      }),
    ).rejects.toMatchObject({ name: 'ConstraintError' });
  });
});

describe('持久化与清空（FR-E5 / FR-E7）', () => {
  it('关闭连接后重新打开，数据仍在（版本未变不触发迁移）', async () => {
    await upsertWord({ lemma: 'persist', now: 1000 });
    const db = await openDb();
    db.close();
    resetDbHandle();

    const words = await listWords();
    expect(words.map((w) => w.lemma)).toEqual(['persist']);
  });

  it('clearAllData 之后库是空的', async () => {
    await upsertWord({ lemma: 'gone', now: 1000 });
    expect(await listWords()).toHaveLength(1);

    await clearAllData();

    expect(await listWords()).toHaveLength(0);
  });

  /**
   * FR-E5「升级后旧数据不丢」的可执行证据。
   *
   * 手工造一个 **v1** 的库（没有 `deletedAt` 索引、但已有一条记录），
   * 再用正式入口 `openDb()` 打开——它会走 v2 的迁移分支。
   * 断言两件事：索引补上了、那条记录还在。
   */
  it('v1 → v4 迁移：补 deletedAt、lemma 去唯一、建 dict、旧数据不丢', async () => {
    resetDbHandle();

    // 1. 造 v1 库：只有 v1 的索引集合，并写入一条记录
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const words = request.result.createObjectStore(STORE.words, { keyPath: 'id' });
        words.createIndex('lemma', 'lemma', { unique: true });
        words.createIndex('status', 'status');
        words.createIndex('createdAt', 'createdAt');
        words.createIndex('meetCount', 'meetCount');
        words.createIndex('updatedAt', 'updatedAt');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(STORE.words, 'readwrite');
        tx.objectStore(STORE.words).put(makeWord({ id: 'legacy', lemma: 'legacy' }));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    // 2. 走正式入口打开：触发 v1 → v4
    const db = await openDb();
    expect(db.version).toBe(4);
    expect(db.objectStoreNames.contains(STORE.dict)).toBe(true);

    const tx = db.transaction(STORE.words, 'readonly');
    const store = tx.objectStore(STORE.words);
    // v2 的成果：deletedAt 索引补上
    expect(store.indexNames.contains('deletedAt')).toBe(true);
    // v3 的成果：lemma 不再唯一、复合索引就位
    expect(store.index('lemma').unique).toBe(false);
    expect(store.indexNames.contains('lemmaDefSrc')).toBe(true);

    const rows = await req<Word[]>(store.getAll());
    expect(rows.map((w) => w.lemma)).toEqual(['legacy']);
  });

  it('v3 → v4 迁移：旧导入词典进入 dict，真实生词保留', async () => {
    resetDbHandle();

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 3);
      request.onupgradeneeded = () => {
        const words = request.result.createObjectStore(STORE.words, { keyPath: 'id' });
        words.createIndex('lemma', 'lemma');
        words.createIndex('lemmaDefSrc', ['lemma', 'defSrc'], { unique: true });
        words.createIndex('defSrc', 'defSrc');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(STORE.words, 'readwrite');
        const words = tx.objectStore(STORE.words);
        words.put(makeWord({
          id: 'old-dict',
          lemma: 'olddict',
          surface: 'OldDict',
          defSrc: 'imported',
          defZh: ['n. 旧词典释义'],
          fallbackDef: ['不应使用'],
          meetCount: 0,
          phoneticUs: "old'dict",
          phoneticSrc: 'imported',
          pos: ['n.'],
          examTags: ['cet6'],
          freqBnc: 12,
          freqCoca: 34,
          exchange: 's:olddicts',
        }));
        words.put(makeWord({
          id: 'old-fallback',
          lemma: 'oldfallback',
          defSrc: 'imported',
          defZh: [],
          fallbackDef: ['n. 旧导入兜底释义'],
          meetCount: 0,
        }));
        words.put(makeWord({
          id: 'real-word',
          lemma: 'realword',
          defSrc: 'imported',
          defZh: [],
          fallbackDef: ['真实生词释义'],
          meetCount: 2,
          status: 'known',
        }));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    const db = await openDb();
    expect(db.version).toBe(4);

    const dictRows = await req<DictEntry[]>(
      db.transaction(STORE.dict, 'readonly').objectStore(STORE.dict).getAll(),
    );
    expect(dictRows).toHaveLength(2);
    expect(dictRows.find((entry) => entry.lemma === 'olddict')).toEqual({
      lemma: 'olddict',
      surface: 'OldDict',
      phoneticUs: "old'dict",
      phoneticSrc: 'imported',
      defZh: ['n. 旧词典释义'],
      pos: ['n.'],
      examTags: ['cet6'],
      freqBnc: 12,
      freqCoca: 34,
      exchange: 's:olddicts',
      source: 'ecdict',
    });
    expect(dictRows.find((entry) => entry.lemma === 'oldfallback')?.defZh)
      .toEqual(['n. 旧导入兜底释义']);

    const words = await req<Word[]>(
      db.transaction(STORE.words, 'readonly').objectStore(STORE.words).getAll(),
    );
    expect(words.map((word) => word.id)).toEqual(['real-word']);
    expect(words[0]).toMatchObject({ meetCount: 2, status: 'known', fallbackDef: ['真实生词释义'] });
  });
});
