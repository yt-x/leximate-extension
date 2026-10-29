/**
 * 执行导入计划（PLAN.md FR-J6）。
 *
 * 写入前在同一事务里重读当前词与例句 hash，合并预演之后发生的本地变化。
 * 统计仍原样返回预演结果（FR-J7），执行只解决并发覆盖与幂等写入。
 *
 * **一个事务里写完词与例句**：写到一半失败时不会留下"有词没例句"的半成品。
 * 规模口径与 `loadRows` 相同（一次全表读进内存）：539 词 / 623 句是一次事务的量级。
 */
import { req, STORE, writeTx } from '../db/schema';
import type { Scene, Word } from '../db/types';
import { sceneHash } from '../hash';
import type { ImportPlan, ImportStats } from './plan';

export async function applyImportPlan(plan: ImportPlan): Promise<ImportStats> {
  await writeTx([STORE.words, STORE.scenes], async (tx) => {
    const words = tx.objectStore(STORE.words);
    const scenes = tx.objectStore(STORE.scenes);

    for (const item of plan.words) {
      const planned = item.word;
      const current = (await req<Word | undefined>(words.get(planned.id)))
        ?? (await req<Word | undefined>(words.index('lemma').get(planned.lemma)));
      const wordId = current?.id ?? planned.id;
      const keepCurrentState = current !== undefined && (
        current.id !== planned.id || current.updatedAt !== item.currentUpdatedAt
      );
      const word = current === undefined ? planned : {
        ...planned,
        id: wordId,
        meetCount: Math.max(current.meetCount, planned.meetCount),
        status: keepCurrentState ? current.status : planned.status,
        updatedAt: Math.max(current.updatedAt, planned.updatedAt),
        deletedAt: keepCurrentState ? current.deletedAt : planned.deletedAt,
      };
      await req(words.put(word));
      for (const scene of item.scenes) {
        const contentHash = sceneHash(wordId, scene.text);
        const existing = await req<Scene | undefined>(
          scenes.index('contentHash').get(contentHash),
        );
        if (!existing) await req(scenes.add({ ...scene, wordId, contentHash }));
      }
    }
  });

  // 原样返回同一个 stats：预演显示的数字与导入之后的数字必须逐字段相等
  return plan.stats;
}
