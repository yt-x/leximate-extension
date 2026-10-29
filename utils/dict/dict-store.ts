/**
 * 导入词库的读写（`dict` store，`decisions/0031`）。
 *
 * **这是词典，不是生词本。** 两者在存储层就分开：
 * - `dict`：只读的静态词典条目（77 万条），永远被替换/清空，不参与备份/同步/计数；
 * - `words`：用户收藏的生词，有状态、有例句、会导出。
 *
 * 为什么必须分开（`decisions/0031` 记录的教训）：上一轮把词典写进 `words`，
 * 靠 `defSrc === 'imported'` 过滤区分，结果漏一处就"词典全变成生词"。
 * 现在查询生词本的任何接口都**看不到** `dict`，不需要任何运行时过滤。
 */
import { STORE, readTx, req, writeTx } from '../db/schema';
import type { DictEntry } from '../db/types';

/** 每批写入条数。实测 77 万条在 fake-indexeddb 里用 5000/批约 2 分钟 */
const DEFAULT_BATCH = 2000;

/** 按 lemma 取一条词典条目（同步语义的异步包装：IndexedDB 本身是异步的） */
export async function getDictEntry(lemma: string): Promise<DictEntry | undefined> {
  const key = lemma.trim().toLowerCase();
  if (!key) return undefined;
  return readTx(STORE.dict, (tx) => req<DictEntry | undefined>(tx.objectStore(STORE.dict).get(key)));
}

/** 词典条目数（设置页显示"已导入 N 条"） */
export async function countDictEntries(): Promise<number> {
  return readTx(STORE.dict, (tx) => req<number>(tx.objectStore(STORE.dict).count()));
}

export interface WriteDictOptions {
  batchSize?: number;
  onProgress?: (written: number) => void;
  /** 每批开始前问一次；true 则停止并恢复调用前的词典 */
  isCancelled?: () => boolean;
}

export interface WriteDictSummary {
  written: number;
  cancelled: boolean;
}

/**
 * 分批写入词典。**每批一个事务**：批内要么全进要么全不进。
 * 取消发生在批与批之间；取消或任一批失败都会跨批回滚。
 * 回滚只保存本次输入覆盖的旧条目，不复制整库。
 */
export async function writeDictEntries(
  entries: DictEntry[],
  options: WriteDictOptions = {},
): Promise<WriteDictSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const previous: DictEntry[] = [];
  if (await countDictEntries() > 0) {
    for (let start = 0; start < entries.length; start += batchSize) {
      const keys = entries.slice(start, start + batchSize).flatMap((entry) =>
        typeof entry.lemma === 'string' ? [entry.lemma] : [],
      );
      previous.push(...await getDictEntries(keys));
    }
  }

  let written = 0;
  const rollback = async (): Promise<void> => {
    const applied = entries.slice(0, written);
    for (let start = 0; start < applied.length; start += batchSize) {
      const slice = applied.slice(start, start + batchSize);
      await writeTx(STORE.dict, (tx) => {
        const store = tx.objectStore(STORE.dict);
        for (const entry of slice) store.delete(entry.lemma);
      });
    }
    for (let start = 0; start < previous.length; start += batchSize) {
      const slice = previous.slice(start, start + batchSize);
      await writeTx(STORE.dict, (tx) => {
        const store = tx.objectStore(STORE.dict);
        for (const entry of slice) store.put(entry);
      });
    }
  };

  try {
    for (let start = 0; start < entries.length; start += batchSize) {
      if (options.isCancelled?.()) {
        await rollback();
        return { written, cancelled: true };
      }
      const slice = entries.slice(start, start + batchSize);
      await writeTx(STORE.dict, (tx) => {
        const store = tx.objectStore(STORE.dict);
        for (const entry of slice) store.put(entry);
      });
      written += slice.length;
      options.onProgress?.(written);
    }
    return { written, cancelled: false };
  } catch (error) {
    await rollback();
    throw error;
  }
}

/** 清空词典（「移除导入词库」）。绝不碰 `words`。 */
export async function clearDict(): Promise<{ removed: number }> {
  const before = await countDictEntries();
  await writeTx(STORE.dict, (tx) => {
    tx.objectStore(STORE.dict).clear();
  });
  return { removed: before };
}

/** 取全部词典条目（用于建立内存变形映射；77 万条会占内存，只在需要时调） */
export async function listDictEntries(): Promise<DictEntry[]> {
  return readTx(STORE.dict, (tx) => req<DictEntry[]>(tx.objectStore(STORE.dict).getAll()));
}

/**
 * 批量取一批 lemma 的词典条目（划词时只查需要的那几条）。
 *
 * 用 `getAll` 逐个键读而不是全表扫：`dict` 的主键是 lemma，
 * 一次 `get` 就是一次 B 树查找。
 */
export async function getDictEntries(lemmas: readonly string[]): Promise<DictEntry[]> {
  const keys = lemmas.map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (keys.length === 0) return [];
  return readTx(STORE.dict, async (tx) => {
    const store = tx.objectStore(STORE.dict);
    const out: DictEntry[] = [];
    for (const key of keys) {
      const hit = await req<DictEntry | undefined>(store.get(key));
      if (hit) out.push(hit);
    }
    return out;
  });
}
