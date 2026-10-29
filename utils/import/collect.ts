/**
 * 导入前要读的既有数据（PLAN.md FR-J5 / FR-J6）。
 *
 * 只读，**一个事务读完两张表**：
 * - 全部词（含墓碑——导入要复活它，因此必须知道它存在及其 id）
 * - 全部例句的 `contentHash`（幂等去重的判据）
 *
 * 为什么按 `contentHash` 而不是"逐词查例句"：导入是整份文件一次算完，
 * 逐词查是 N+1 次事务；而且 `sceneHash(wordId, text)` 正是 `addScene` 写入时用的键，
 * 用它比对与"再写一次试试"等价，但不必真的写。
 */
import { readTx, req, STORE } from '../db/schema';
import type { Scene, Word } from '../db/types';
import type { ExistingData } from './plan';

export async function loadExistingData(): Promise<ExistingData> {
  return readTx([STORE.words, STORE.scenes], async (tx) => {
    const words = await req<Word[]>(tx.objectStore(STORE.words).getAll());
    const scenes = await req<Scene[]>(tx.objectStore(STORE.scenes).getAll());
    return { words, sceneHashes: new Set(scenes.map((scene) => scene.contentHash)) };
  });
}
