/**
 * 翻译缓存与待翻译队列（PLAN.md FR-D4 / FR-D6）。
 *
 * 两个 store 在 M1 就建好了（`utils/db/schema.ts`），这里只补读写。
 *
 * 缓存键是 `translationId(text, lang, engine, model)`——**四元组**而不是"句子+语言"：
 * 换引擎或换模型之后，旧译文不该被当成同一份结果（那会让人以为"换了模型没效果"）。
 */
import { translationId } from '../hash';
import { readTx, req, STORE, writeTx } from './schema';
import type { QueueItem, QueueState, Translation, TranslationEngine } from './types';

export interface TranslationKey {
  text: string;
  targetLang: string;
  engine: TranslationEngine;
  model: string;
}

/** 缓存的 id（与写入时同一把钥匙，避免读的时候另算一遍算错） */
export function keyOf(key: TranslationKey): string {
  return translationId(key.text, key.targetLang, key.engine, key.model);
}

/**
 * 查缓存（FR-D4：同一句永不重复翻译）。
 *
 * 命中直接返回译文；未命中返回 `undefined`——**不抛错**，让调用方决定要不要入队。
 */
export async function getCachedTranslation(key: TranslationKey): Promise<string | undefined> {
  const id = keyOf(key);
  const row = await readTx(STORE.translations, (tx) =>
    req<Translation | undefined>(tx.objectStore(STORE.translations).get(id)),
  );
  return row?.result;
}

/** 写一条缓存。同键覆盖（译文可能因为模型升级而更好，重翻一次就该更新） */
export async function putTranslation(key: TranslationKey, result: string): Promise<Translation> {
  const row: Translation = {
    id: keyOf(key),
    textHash: translationId(key.text, '', '', ''),
    targetLang: key.targetLang,
    engine: key.engine,
    model: key.model,
    result,
    createdAt: Date.now(),
  };
  await writeTx(STORE.translations, (tx) => req(tx.objectStore(STORE.translations).put(row)));
  return row;
}

// ---------------- 队列（FR-D6） ----------------

/** 入队。同一 (sceneId, textHash, targetLang) 已在队列里就不重复入队 */
export async function enqueueTranslation(input: {
  wordId: string;
  sceneId: string;
  textHash: string;
  targetLang: string;
}): Promise<QueueItem> {
  return writeTx(STORE.queue, async (tx) => {
    const store = tx.objectStore(STORE.queue);
    const all = await req<QueueItem[]>(store.getAll());
    const existing = all.find(
      (item) =>
        item.sceneId === input.sceneId &&
        item.textHash === input.textHash &&
        item.targetLang === input.targetLang,
    );
    if (existing) return existing;

    const item: QueueItem = {
      id: `${input.sceneId}\u0000${input.textHash}\u0000${input.targetLang}`,
      wordId: input.wordId,
      sceneId: input.sceneId,
      textHash: input.textHash,
      targetLang: input.targetLang,
      state: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: Date.now(),
    };
    await req(store.put(item));
    return item;
  });
}

/** 取待办：`pending` 优先，其次是还能重试的 `failed` */
export async function takePending(limit: number, maxAttempts: number): Promise<QueueItem[]> {
  return readTx(STORE.queue, async (tx) => {
    const all = await req<QueueItem[]>(tx.objectStore(STORE.queue).getAll());
    const usable = all
      .filter((item) => item.state === 'pending' || (item.state === 'failed' && item.attempts < maxAttempts))
      .sort((a, b) => a.createdAt - b.createdAt);
    return usable.slice(0, Math.max(0, limit));
  });
}

/** 改队列项状态 */
export async function setQueueState(
  id: string,
  state: QueueState,
  options: { error?: string | null; bumpAttempts?: boolean } = {},
): Promise<void> {
  await writeTx(STORE.queue, async (tx) => {
    const store = tx.objectStore(STORE.queue);
    const current = await req<QueueItem | undefined>(store.get(id));
    if (!current) return;
    await req(
      store.put({
        ...current,
        state,
        lastError: options.error ?? (state === 'failed' ? current.lastError : null),
        attempts: options.bumpAttempts ? current.attempts + 1 : current.attempts,
      }),
    );
  });
}

/** 翻译成功：从队列移除 */
export async function completeQueueItem(id: string): Promise<void> {
  await writeTx(STORE.queue, (tx) => req(tx.objectStore(STORE.queue).delete(id)));
}

/**
 * 队列计数（FR-D6 的"管理台显示待翻译 N 条"）。
 *
 * `waiting` 是**还能再试**的条数（`pending` + 未达上限的 `failed`），
 * `exhausted` 是连续失败到上限、停在队列里的条数——两者分开报，
 * 否则用户看到的数字永远不会归零，会以为程序卡住了。
 */
export async function queueStats(maxAttempts: number): Promise<{
  pending: number;
  failed: number;
  exhausted: number;
  waiting: number;
}> {
  return readTx(STORE.queue, async (tx) => {
    const all = await req<QueueItem[]>(tx.objectStore(STORE.queue).getAll());
    const pending = all.filter((item) => item.state === 'pending').length;
    const failedItems = all.filter((item) => item.state === 'failed');
    const exhausted = failedItems.filter((item) => item.attempts >= maxAttempts).length;
    const failed = failedItems.length - exhausted;
    return { pending, failed, exhausted, waiting: pending + failed };
  });
}

/** 重试：把队列项打回 `pending` 并清零失败计数（用户手动点"重试"时用） */
export async function retryQueueItem(id: string): Promise<void> {
  await writeTx(STORE.queue, async (tx) => {
    const store = tx.objectStore(STORE.queue);
    const current = await req<QueueItem | undefined>(store.get(id));
    if (!current) return;
    await req(store.put({ ...current, state: 'pending', attempts: 0, lastError: null }));
  });
}

/** 把停在 `failed` 的项全部打回待办（`exhausted` 的也一起，用户明确要求重试） */
export async function retryAllFailed(): Promise<number> {
  return writeTx(STORE.queue, async (tx) => {
    const store = tx.objectStore(STORE.queue);
    const all = await req<QueueItem[]>(store.getAll());
    const failed = all.filter((item) => item.state === 'failed');
    for (const item of failed) {
      await req(store.put({ ...item, state: 'pending', attempts: 0, lastError: null }));
    }
    return failed.length;
  });
}
