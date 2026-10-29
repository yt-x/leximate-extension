/**
 * 存储维护（PLAN.md FR-E3 持久化、FR-E7 一键清空、FR-L5 / FR-L6 数据健康）。
 */
import { openDb, resetDbHandle, STORE, writeTx, readTx, type StoreName } from './schema';
import { getMeta, setMeta } from './kv';
import { countScenes, countWords } from './words';

/**
 * 申请持久化存储，降低被浏览器在空间紧张时清掉的概率（FR-E3）。
 *
 * 需要在有用户手势的上下文里调用更容易获批；扩展页面通常直接返回结果。
 * 无论结果如何都记进 meta，设置页据此显示「已受保护」。
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage) return false;

  try {
    let granted = false;
    if (typeof navigator.storage.persisted === 'function') {
      granted = await navigator.storage.persisted();
    }
    if (!granted && typeof navigator.storage.persist === 'function') {
      granted = await navigator.storage.persist();
    }
    await setMeta({ persistGranted: granted });
    return granted;
  } catch {
    // 拿不到配额信息不该让调用方崩掉
    return false;
  }
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
    return null;
  }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/** 用户数据的 store。`settings` 与 `meta` 不在其列——见 `clearAllData` 的注释 */
const DATA_STORES: StoreName[] = [
  STORE.words,
  STORE.scenes,
  STORE.translations,
  STORE.queue,
  STORE.logs,
];

export interface ClearDataOptions {
  /**
   * 是否保留设置。**默认 true**，与 FR-E7 的验收原话一致
   * （"清空后所有 store 为空**且设置保留**"）。
   *
   * 传 `false` 是"彻底重置"：连设置与 meta 一起清掉。
   * 测试夹具要一个干净起点时用它。
   */
  keepSettings?: boolean;
}

/**
 * 一键清空所有本地数据（FR-E7）。
 *
 * 验收原话：**"清空后所有 store 为空且设置保留；未确认时不执行"**。
 *
 * ⚠️ 旧实现是 `indexedDB.deleteDatabase()`——**整库删掉，设置也跟着没了**，
 * 与"设置保留"直接冲突；而且删库会被其它标签页的连接阻塞，
 * 用户得先关掉所有 Leximate 页面。现在改成**逐 store `clear()`**：
 *
 * - 数据 store（`words`/`scenes`/`translations`/`queue`/`logs`）清空；
 * - `settings` **保留**（验收要求）；
 * - `meta` 也保留：`schemaVersion`/`installedAt`/`persistGranted` 是**结构信息**，
 *   不是用户数据。清掉 `persistGranted` 会让"已受保护"显示错，
 *   而重算 `installedAt` 会让"首次安装时间"变成一个假值。
 * - 库不删、连接不丢 → 清空后立刻可以继续用，也**不会被其它标签页阻塞**。
 *
 * 调用方必须自己做完二次确认——这里不做任何拦截，清了就没了。
 */
export async function clearAllData(options: ClearDataOptions = {}): Promise<void> {
  const { keepSettings = true } = options;
  const stores: StoreName[] = keepSettings
    ? DATA_STORES
    : [...DATA_STORES, STORE.settings, STORE.meta];

  await writeTx(stores, (tx) => {
    for (const name of stores) tx.objectStore(name).clear();
  });
}

/**
 * 数据健康快照（FR-L5 / FR-L6 的事实来源）。
 *
 * 每一项都取**真实值**，不做估计、不编默认：
 * - `lastExportAt` 来自 `meta`（导出面板每次成功导出都会写）；
 * - `latestChangeAt` 取 `words.updatedAt` 与 `scenes.capturedAt` 两个索引的最大值
 *   ——所以它是**索引游标**（O(log n)），不是全表扫描；
 * - `usage` / `quota` 来自 `navigator.storage.estimate()`，拿不到就是 `null`；
 * - `persistGranted` 来自 `meta`（FR-E3）。
 *
 * 为什么 `latestChangeAt` 要用"两个索引取最大"而不是加一个 `meta.dataChangedAt`：
 * 那要给每一条写入路径都加一次写（收藏、改状态、删词、加例句、导入……），
 * 漏一处提醒就失灵——而漏掉的那处不会报错。取舍见 `decisions/0021`。
 */
export interface DataHealth {
  lastExportAt: number | null;
  latestChangeAt: number | null;
  words: number;
  scenes: number;
  usage: number | null;
  quota: number | null;
  persistGranted: boolean;
}

/** 取某个索引的最大值；索引为空返回 `null` */
async function maxOfIndex(
  store: StoreName,
  indexName: string,
  field: string,
): Promise<number | null> {
  return readTx(store, (tx) =>
    new Promise<number | null>((resolve, reject) => {
      const request = tx.objectStore(store).index(indexName).openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(null);
          return;
        }
        const value = (cursor.value as Record<string, unknown>)[field];
        resolve(typeof value === 'number' && Number.isFinite(value) ? value : null);
      };
      request.onerror = () => reject(request.error ?? new Error('读取最大时间失败'));
    }),
  );
}

export async function readDataHealth(): Promise<DataHealth> {
  const [meta, words, scenes, changeWords, changeScenes, estimate] = await Promise.all([
    getMeta(),
    countWords(),
    countScenes(),
    maxOfIndex(STORE.words, 'updatedAt', 'updatedAt'),
    maxOfIndex(STORE.scenes, 'capturedAt', 'capturedAt'),
    estimateStorage(),
  ]);

  const candidates = [changeWords, changeScenes].filter(
    (value): value is number => value !== null,
  );

  return {
    lastExportAt: meta.lastExportAt,
    latestChangeAt: candidates.length > 0 ? Math.max(...candidates) : null,
    words,
    scenes,
    usage: estimate?.usage ?? null,
    quota: estimate?.quota ?? null,
    persistGranted: meta.persistGranted,
  };
}
