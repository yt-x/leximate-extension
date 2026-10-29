/**
 * 翻译缓存与队列（PLAN.md FR-D4 / FR-D6）。真实 IndexedDB（fake-indexeddb）。
 *
 * 这里验的是**幂等与状态机**，不是网络：
 * 同句只进缓存一次、同一 scene 不重复入队、失败计数、重试归零。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbHandle, STORE } from './schema';
import { readTx, req, writeTx } from './schema';
import {
  completeQueueItem,
  enqueueTranslation,
  getCachedTranslation,
  keyOf,
  putTranslation,
  queueStats,
  retryAllFailed,
  retryQueueItem,
  setQueueState,
  takePending,
} from './translations';
import type { QueueItem } from './types';

async function clearAll(): Promise<void> {
  for (const store of [STORE.translations, STORE.queue] as const) {
    await writeTx(store, (tx) => req(tx.objectStore(store).clear()));
  }
}

beforeEach(async () => {
  resetDbHandle();
  await clearAll();
});

describe('FR-D4：翻译缓存', () => {
  const key = { text: 'hello world', targetLang: 'zh-CN', engine: 'llm' as const, model: 'gpt-4o-mini' };

  it('写进去能读出来', async () => {
    await putTranslation(key, '你好世界');
    expect(await getCachedTranslation(key)).toBe('你好世界');
  });

  it('没写过 → undefined，不抛错', async () => {
    expect(await getCachedTranslation(key)).toBeUndefined();
  });

  it('换模型或换引擎就不再命中（那是另一份结果）', async () => {
    await putTranslation(key, '你好世界');
    expect(await getCachedTranslation({ ...key, model: 'other' })).toBeUndefined();
    expect(await getCachedTranslation({ ...key, engine: 'api' })).toBeUndefined();
    expect(await getCachedTranslation({ ...key, targetLang: 'ja' })).toBeUndefined();
  });

  it('同键重写是覆盖，不会攒出两份', async () => {
    await putTranslation(key, '旧译文');
    await putTranslation(key, '新译文');
    expect(await getCachedTranslation(key)).toBe('新译文');

    const rows = await readTx(STORE.translations, (tx) =>
      req<unknown[]>(tx.objectStore(STORE.translations).getAll()),
    );
    expect(rows).toHaveLength(1);
  });

  it('keyOf 与写入用的是同一把钥匙（防止读写各算一遍算错）', async () => {
    await putTranslation(key, 'x');
    const row = await readTx(STORE.translations, (tx) =>
      req<{ id: string } | undefined>(tx.objectStore(STORE.translations).get(keyOf(key))),
    );
    expect(row?.id).toBe(keyOf(key));
  });
});

describe('FR-D6：队列', () => {
  const base = { wordId: 'w1', sceneId: 's1', textHash: 'h1', targetLang: 'zh-CN' };

  it('入队后是 pending，attempts 为 0', async () => {
    const item = await enqueueTranslation(base);
    expect(item.state).toBe('pending');
    expect(item.attempts).toBe(0);
    expect((await takePending(10, 3)).map((i) => i.id)).toEqual([item.id]);
  });

  it('同一 scene + 文本 + 语言不重复入队', async () => {
    const a = await enqueueTranslation(base);
    const b = await enqueueTranslation(base);
    expect(b.id).toBe(a.id);
    expect(await takePending(10, 3)).toHaveLength(1);
  });

  it('不同 scene 各自入队', async () => {
    await enqueueTranslation(base);
    await enqueueTranslation({ ...base, sceneId: 's2', textHash: 'h2' });
    expect(await takePending(10, 3)).toHaveLength(2);
  });

  it('takePending 只取还能再试的：达到上限的 failed 不再自动重试', async () => {
    const item = await enqueueTranslation(base);
    await setQueueState(item.id, 'failed', { error: 'boom', bumpAttempts: true });
    expect(await takePending(10, 3)).toHaveLength(1); // 1 次失败仍可重试

    await setQueueState(item.id, 'failed', { error: 'boom', bumpAttempts: true });
    await setQueueState(item.id, 'failed', { error: 'boom', bumpAttempts: true });
    expect(await takePending(10, 3)).toHaveLength(0); // 3 次到顶，停下
  });

  it('计数把"还能再试"和"到顶停下"分开报', async () => {
    const a = await enqueueTranslation(base);
    const b = await enqueueTranslation({ ...base, sceneId: 's2', textHash: 'h2' });
    await setQueueState(b.id, 'failed', { error: 'x', bumpAttempts: true });

    expect(await queueStats(3)).toEqual({ pending: 1, failed: 1, exhausted: 0, waiting: 2 });

    for (let i = 0; i < 3; i += 1) {
      await setQueueState(b.id, 'failed', { error: 'x', bumpAttempts: true });
    }
    expect(await queueStats(3)).toEqual({ pending: 1, failed: 0, exhausted: 1, waiting: 1 });
    expect(a.id).not.toBe(b.id);
  });

  it('成功后离开队列', async () => {
    const item = await enqueueTranslation(base);
    await completeQueueItem(item.id);
    expect(await takePending(10, 3)).toHaveLength(0);
    expect(await queueStats(3)).toEqual({ pending: 0, failed: 0, exhausted: 0, waiting: 0 });
  });

  it('手动重试把 failed 打回 pending 并清零尝试次数（到顶的也能救回来）', async () => {
    const item = await enqueueTranslation(base);
    for (let i = 0; i < 5; i += 1) {
      await setQueueState(item.id, 'failed', { error: 'x', bumpAttempts: true });
    }
    expect(await takePending(10, 3)).toHaveLength(0);

    await retryQueueItem(item.id);
    const rows = await takePending(10, 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.lastError).toBeNull();
  });

  it('retryAllFailed 一次救回全部（含到顶的）', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const item = await enqueueTranslation({ ...base, sceneId: `s${i}`, textHash: `h${i}` });
      await setQueueState(item.id, 'failed', { error: 'x', bumpAttempts: true });
      ids.push(item.id);
    }

    expect(await retryAllFailed()).toBe(3);
    const rows = await readTx(STORE.queue, (tx) => req<QueueItem[]>(tx.objectStore(STORE.queue).getAll()));
    expect(rows.every((item) => item.state === 'pending' && item.attempts === 0)).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('成功后 lastError 被清掉（不会留着上一次的错）', async () => {
    const item = await enqueueTranslation(base);
    await setQueueState(item.id, 'failed', { error: 'boom', bumpAttempts: true });
    await setQueueState(item.id, 'running');

    const row = await readTx(STORE.queue, (tx) =>
      req<QueueItem | undefined>(tx.objectStore(STORE.queue).get(item.id)),
    );
    expect(row?.lastError).toBeNull();
  });
});
