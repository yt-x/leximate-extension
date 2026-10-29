/**
 * IndexedDB 打开与版本迁移（PLAN.md FR-E1 / FR-E2 / FR-E5）。
 *
 * 设计要点：
 * - 只在 `onupgradeneeded` 里改结构，迁移代码按 `oldVersion` 逐级补齐，旧数据不丢；
 * - 事务封装 `withTx` 要求回调内**同步**发出请求，否则 IndexedDB 会自动提交事务；
 * - 打开失败后清空缓存的 Promise，允许重试，不把一次失败固化。
 */
import type { Word, Scene, Translation, QueueItem, Settings, Meta, LogEntry, DictEntry } from './types';

export const DB_NAME = 'leximate';

/** 结构版本。改动 store 或索引时必须 +1，并在 upgrade 里补一段迁移。 */
export const DB_VERSION = 4;

export const STORE = {
  words: 'words',
  scenes: 'scenes',
  translations: 'translations',
  queue: 'queue',
  settings: 'settings',
  meta: 'meta',
  logs: 'logs',
  /** 导入的完整词库（只读词典条目，与生词本无关，见 decisions/0031） */
  dict: 'dict',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

/** 各 store 的行类型，供 `req()` 推断返回值 */
export interface StoreRowMap {
  [STORE.words]: Word;
  [STORE.scenes]: Scene;
  [STORE.translations]: Translation;
  [STORE.queue]: QueueItem;
  [STORE.settings]: { key: string; value: Settings };
  [STORE.meta]: { key: string; value: Meta };
  [STORE.logs]: LogEntry;
  [STORE.dict]: DictEntry;
}

/**
 * 建库与迁移。
 *
 * v1：`words`（lemma 唯一）/ `scenes` / `translations` / `queue` / `settings` / `meta`，外加 §2 数据模型里的 `logs`。
 * FR-E2 要求的 `domain` 索引挂在 `scenes` 上 —— domain 是例句的来源域名，不是词的属性。
 *
 * v2：给 `words` 加 **`deletedAt` 索引**。
 *
 * 为什么需要它：FR-A14 的角标数必须**排除墓碑**（`deletedAt` 是删除标记，
 * 不是"遇见过的词"）。`deletedAt === null` 不是合法的 IndexedDB 键，
 * 因此**没有墓碑的记录根本不会进这个索引**——`index('deletedAt').count()`
 * 直接就是墓碑数，"总数 − 墓碑数"是两次 B 树计数，而不是逐条读游标。
 *
 * 为什么不能省（用游标过滤也一样对）：`countWords()` 在**每一次划词**
 * 都会因刷新角标而调用一次，1 万词逐条读游标实测把测试套件从 1.8s 拖到 13s。
 * 能用索引解决的事不该用遍历解决。
 */
export function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  if (oldVersion < 1) {
    const words = db.createObjectStore(STORE.words, { keyPath: 'id' });
    words.createIndex('lemma', 'lemma', { unique: true });
    words.createIndex('status', 'status');
    words.createIndex('createdAt', 'createdAt');
    words.createIndex('meetCount', 'meetCount');
    words.createIndex('updatedAt', 'updatedAt');

    const scenes = db.createObjectStore(STORE.scenes, { keyPath: 'id' });
    scenes.createIndex('wordId', 'wordId');
    scenes.createIndex('domain', 'domain');
    scenes.createIndex('contentHash', 'contentHash');
    scenes.createIndex('capturedAt', 'capturedAt');

    const translations = db.createObjectStore(STORE.translations, { keyPath: 'id' });
    translations.createIndex('textHash', 'textHash');
    translations.createIndex('createdAt', 'createdAt');

    const queue = db.createObjectStore(STORE.queue, { keyPath: 'id' });
    queue.createIndex('state', 'state');
    queue.createIndex('wordId', 'wordId');
    queue.createIndex('createdAt', 'createdAt');

    db.createObjectStore(STORE.settings, { keyPath: 'key' });
    db.createObjectStore(STORE.meta, { keyPath: 'key' });

    const logs = db.createObjectStore(STORE.logs, { keyPath: 'id', autoIncrement: true });
    logs.createIndex('at', 'at');
    logs.createIndex('level', 'level');

    // 词典（导入的完整词库）。只读静态数据，与生词本互不相干。
    const dict = db.createObjectStore(STORE.dict, { keyPath: 'lemma' });
    dict.createIndex('source', 'source');
  }

  if (oldVersion < 2) {
    // 从 v1 升上来的库：store 已存在，只补索引。**不动已有记录**（FR-E5：升级不丢数据）
    const words = tx.objectStore(STORE.words);
    if (!words.indexNames.contains('deletedAt')) {
      words.createIndex('deletedAt', 'deletedAt');
    }
  }

  if (oldVersion < 3) {
    // v3（FR-B7）：`lemma` 不再是唯一索引。
    //
    // 为什么必须改：导入完整词库后，同一个 lemma 会有两条记录——
    // 一条是用户划词收藏的（`meetCount > 0`），一条是导入来的词典条目
    // （`meetCount = 0`、`defSrc = 'imported'`）。唯一索引会让导入在冲突处
    // 直接 abort 整个事务（实测报「IndexedDB 事务失败」）。
    //
    // 换成复合唯一 `[lemma, defSrc]`：同 lemma 允许"用户条 + 导入条"共存，
    // 但同一来源内不允许重复——这正好表达"一个词在每种来源里只有一条"。
    const words = tx.objectStore(STORE.words);
    if (words.indexNames.contains('lemma')) {
      words.deleteIndex('lemma');
    }
    words.createIndex('lemma', 'lemma');
    if (!words.indexNames.contains('lemmaDefSrc')) {
      words.createIndex('lemmaDefSrc', ['lemma', 'defSrc'], { unique: true });
    }
    // `defSrc` 索引：用于"数导入词条"（`index('defSrc').count('imported')`），
    // 让角标与生词集合能**用 B 树计数**排除导入词，而不是逐条扫 77 万条。
    if (!words.indexNames.contains('defSrc')) {
      words.createIndex('defSrc', 'defSrc');
    }
  }

  if (oldVersion < 4) {
    // v4（`decisions/0031`）：**词典独立成 store**，与生词本彻底分离。
    //
    // v3 的错误建模：把导入的 77 万条词典条目写进了 `words`（生词本表），
    // 靠 `defSrc = 'imported' && meetCount = 0` 打标记 + 各处运行时过滤来区分。
    // 结果是词典被当成生词——角标、管理台列表、下划线集合全被污染。
    //
    // v4 的做法：
    // 1. 建 `dict` store（主键 lemma）；
    // 2. 把 `words` 里的词典条目转换为 `DictEntry` 写入 `dict`，再删除旧行；
    //    用户的真实生词（`meetCount > 0`，或 `defSrc !== 'imported'`）一律保留。
    if (!db.objectStoreNames.contains(STORE.dict)) {
      const dict = db.createObjectStore(STORE.dict, { keyPath: 'lemma' });
      dict.createIndex('source', 'source');
    }
    const words = tx.objectStore(STORE.words);
    const dict = tx.objectStore(STORE.dict);
    const cursorReq = words.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const word = cursor.value as Word;
      const isDictEntry = word.defSrc === 'imported' && word.meetCount === 0;
      if (isDictEntry) {
        const entry: DictEntry = {
          lemma: word.lemma,
          surface: word.surface,
          phoneticUs: word.phoneticUs,
          phoneticSrc: word.phoneticSrc,
          defZh: word.defZh.length > 0 ? word.defZh : word.fallbackDef,
          pos: word.pos,
          examTags: word.examTags,
          freqBnc: word.freqBnc,
          freqCoca: word.freqCoca,
          exchange: word.exchange,
          source: 'ecdict',
        };
        dict.put(entry);
        cursor.delete();
      }
      cursor.continue();
    };
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      // 升级事务只能从 request 上拿（`onupgradeneeded` 期间 db.transaction 不可用）
      const tx = request.transaction;
      if (tx) upgrade(request.result, event.oldVersion, tx);
    };
    request.onsuccess = () => {
      const db = request.result;
      // 另一个标签页要升级时，本连接必须让路，否则升级被阻塞
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
    request.onblocked = () => reject(new Error('IndexedDB 升级被占用中的旧连接阻塞'));
  });

  // 一次失败不该固化成永久失败
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

/** 测试与「一键清空」用：丢弃缓存的连接 */
export function resetDbHandle(): void {
  dbPromise = null;
}

export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
  });
}

/**
 * 事务封装。
 *
 * `run` 内可以 `await req(...)` —— 等待 IndexedDB 请求本身不会让事务提前提交，
 * 因为请求未结时事务保持活动。但**不得** await 与 IndexedDB 无关的异步（fetch、定时器），
 * 那会让事务在微任务队列排空后自动提交。
 */
export async function withTx<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(stores, mode);
  const done = txDone(tx);
  try {
    const result = await run(tx);
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // 事务可能已经结束，无法中止 —— 忽略
    }
    void done.catch(() => {});
    throw error;
  }
}

/** 读事务的简写 */
export function readTx<T>(
  stores: StoreName | StoreName[],
  run: (tx: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  return withTx(stores, 'readonly', run);
}

/** 写事务的简写 */
export function writeTx<T>(
  stores: StoreName | StoreName[],
  run: (tx: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  return withTx(stores, 'readwrite', run);
}
