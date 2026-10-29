/**
 * 一轮同步：读远端 → 合并 → 写回（PLAN.md FR-H2 / FR-H3 / FR-H6）。
 *
 * 次序是刻意的：**先读后写**。反过来（先写后读）会在"远端比我新"的情况下
 * 用本地旧数据把远端覆盖掉，那正是同步最不该做的事。
 *
 * 所有 IO 都是注入的，因此"远端为空 / 远端是坏的 / 写失败时本地有没有被改"
 * 这些分支都能用用例驱动——它们恰好是"丢数据"最容易发生的地方。
 */
import { mergeScenes, mergeWords, rowsEqual } from './merge';
import { buildPayload, parsePayload, type SyncPayload } from './payload';
import { decryptPayload, encryptPayload, isEncryptedPayload } from './crypto';
import type { Scene, Word } from '../db/types';

export interface SyncEngineDeps {
  /**
   * FR-H5：可选口令。给了就**加密后上传**；远端是密文时用它解密。
   *
   * 解密失败（口令不对）按"远端不可用"处理——绝不解出乱码往下走。
   */
  passphrase?: string;
  /** 载荷的 schemaVersion（加密时写进密文头） */
  schemaVersion?: number;
  /** 读本地全量（含墓碑） */
  loadWords(): Promise<Word[]>;
  loadScenes(): Promise<Scene[]>;
  /** 写回本地（只写合并后与本地不同的行；实现方负责事务） */
  saveWords(rows: Word[]): Promise<void>;
  saveScenes(rows: Scene[]): Promise<void>;
  /** 读远端；没有返回 null */
  readRemote(): Promise<string | null>;
  writeRemote(body: string): Promise<void>;
  /** 记账：成功才更新 `Meta.lastSyncAt` */
  markSynced(at: number): Promise<void>;
  log?(entry: { level: 'info' | 'warn'; message: string; detail?: unknown }): void;
  now?(): number;
}

export type SyncOutcome =
  | { status: 'ok'; uploaded: boolean; pulled: number; pushed: number; added: number; updated: number }
  | { status: 'remote-broken'; reason: string }
  | { status: 'error'; error: string };

/**
 * 跑一轮同步。
 *
 * 三条行为约定：
 * 1. **远端坏（版本不符 / 不是同步文件）时一动不动**：既不改本地，也不覆盖远端。
 *    覆盖一个有问题的远端等于把它彻底弄丢。
 * 2. **需要上传时先写远端再写本地**：PUT 失败不产生本地副作用；PUT 后本地失败时，
 *    远端保留完整合并快照，下一轮幂等重试本地写入。
 * 3. 成功才 `markSynced`。失败时 `lastSyncAt` 不前移（否则用户以为成功了，见 FR-H6）。
 */
export async function syncOnce(deps: SyncEngineDeps): Promise<SyncOutcome> {
  const now = deps.now ?? Date.now;

  try {
    const [localWords, localScenes, remoteRaw] = await Promise.all([
      deps.loadWords(),
      deps.loadScenes(),
      deps.readRemote(),
    ]);

    // 远端还没有文件：第一次同步，直接把本地推上去
    if (remoteRaw === null) {
      const payload = buildPayload({ words: localWords, scenes: localScenes, now: now() });
      await deps.writeRemote(await serialize(payload, deps));
      await deps.markSynced(now());
      deps.log?.({ level: 'info', message: '同步：远端为空，已上传本地数据' });
      return { status: 'ok', uploaded: true, pulled: 0, pushed: localWords.length, added: 0, updated: 0 };
    }

    // FR-H5：远端是密文就先解密。口令不对**不往下走**——解出乱码会写坏整库
    let remoteText = remoteRaw;
    const remoteWasEncrypted = isEncryptedPayload(remoteRaw);
    if (remoteWasEncrypted) {
      if (!deps.passphrase) {
        deps.log?.({ level: 'warn', message: '同步：远端是密文但没配口令' });
        return { status: 'remote-broken', reason: 'encrypted-without-passphrase' };
      }
      const decrypted = await decryptPayload(remoteRaw, deps.passphrase);
      if (!decrypted.ok) {
        deps.log?.({ level: 'warn', message: '同步：密文解密失败', detail: decrypted });
        return { status: 'remote-broken', reason: decrypted.reason };
      }
      remoteText = decrypted.plaintext;
    }

    const parsed = parsePayload(remoteText);
    if (!parsed.ok) {
      deps.log?.({ level: 'warn', message: '同步：远端载荷不可用，本轮不改动任何一侧', detail: parsed });
      return { status: 'remote-broken', reason: parsed.reason };
    }

    const remote = parsed.payload;
    const wordOutcome = mergeWords(localWords, remote.words, remote.idAliases);
    const sceneOutcome = mergeScenes(localScenes, remote.scenes, wordOutcome.idAliases);

    // 哪些行真的变了（避免把整库重写一遍）
    const changedWords = changedRows(localWords, wordOutcome.localRows);
    const changedScenes = changedRows(localScenes, sceneOutcome.localRows);

    // 合并结果（包括字段与身份别名）与远端不同才需要上传
    const needsPush =
      payloadDiffers(wordOutcome.rows, remote.words) ||
      payloadDiffers(sceneOutcome.rows, remote.scenes) ||
      aliasesDiffer(wordOutcome.idAliases, remote.idAliases) ||
      (!remoteWasEncrypted && Boolean(deps.passphrase));
    if (needsPush) {
      const payload = buildPayload({
        words: wordOutcome.rows,
        scenes: sceneOutcome.rows,
        idAliases: wordOutcome.idAliases,
        now: now(),
      });
      await deps.writeRemote(await serialize(payload, deps));
    }

    // PUT 失败时上面已中断，本地一行未写。PUT 成功而本地失败时，远端保有完整
    // 合并快照；下一轮即使无需 PUT，也会在这里幂等重试本地写入，成功才记账。
    if (changedWords.length > 0) await deps.saveWords(changedWords);
    if (changedScenes.length > 0) await deps.saveScenes(changedScenes);

    await deps.markSynced(now());
    deps.log?.({
      level: 'info',
      message: '同步完成',
      detail: { pulled: wordOutcome.takenFromRemote, pushed: needsPush ? wordOutcome.rows.length : 0 },
    });

    return {
      status: 'ok',
      uploaded: needsPush,
      pulled: wordOutcome.takenFromRemote,
      pushed: needsPush ? wordOutcome.rows.length : 0,
      added: wordOutcome.added,
      updated: wordOutcome.updated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.({ level: 'warn', message: '同步失败', detail: { error: message } });
    return { status: 'error', error: message };
  }
}

/** 按是否配了口令决定写出去的是明文还是密文（FR-H5） */
async function serialize(payload: SyncPayload, deps: SyncEngineDeps): Promise<string> {
  if (!deps.passphrase) return JSON.stringify(payload);
  const encrypted = await encryptPayload(JSON.stringify(payload), deps.passphrase, {
    schemaVersion: deps.schemaVersion ?? payload.schemaVersion,
  });
  return JSON.stringify(encrypted);
}

/** 挑出"合并后被改动的那些本地行"（只写这些，不整库重写） */
function changedRows<T extends { id: string }>(before: readonly T[], after: readonly T[]): T[] {
  const beforeById = new Map(before.map((row) => [row.id, row]));
  return after.filter((row) => {
    const previous = beforeById.get(row.id);
    return !previous || !rowsEqual(previous, row);
  });
}

/** 合并结果是否与远端的任何字段不同（决定要不要上传） */
function payloadDiffers<T extends { id: string }>(merged: readonly T[], remote: readonly T[]): boolean {
  if (merged.length !== remote.length) return true;
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  return merged.some((row) => {
    const other = remoteById.get(row.id);
    return !other || !rowsEqual(other, row);
  });
}

function aliasesDiffer(
  merged: Readonly<Record<string, string>>,
  remote: Readonly<Record<string, string>>,
): boolean {
  return !rowsEqual(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(remote).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export type { SyncPayload };
