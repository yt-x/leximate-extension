/**
 * 同步冲突合并（PLAN.md FR-H3）。
 *
 * 规则一句话：**按 `updatedAt` 后写胜出，墓碑参与同一场比较**。
 *
 * 为什么墓碑必须一起比而不能"有墓碑就删"：先删后改的词会被永久锁死——
 * 用户在 B 设备上把词加回来（`updatedAt` 更新），A 设备却因为手里那条墓碑
 * 把"删除"判成胜者，于是下一轮又删掉。这类 bug 在真机上表现为"改了的词自己消失"。
 *
 * 这一层是**纯函数**：不读库、不发请求，因此可以穷举矩阵断言。
 */
import type { Scene, Word } from '../db/types';
import { sceneHash } from '../hash';

/** 参与同步的最小行形状：只要时间与墓碑这两个判据 */
export interface SyncedRow {
  readonly id: string;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

export type MergeWinner = 'local' | 'remote';

export interface MergeDecision {
  winner: MergeWinner;
  /** 两者时间相同且状态不同时命中的"平局"分支，便于诊断 */
  tie: boolean;
}

/**
 * 一条记录该取哪一边。
 *
 * - 时间不同：晚的赢（后写胜出），**墓碑不单独构成理由**；
 * - 时间相同：墓碑赢（删除比保留更保守——留着会让用户以为删掉了却没删）；
 * - 完全相同：算 `local`，调用方据此可以跳过写入。
 */
export function decideMerge(local: SyncedRow | undefined, remote: SyncedRow | undefined): MergeDecision | null {
  if (!local && !remote) return null;
  if (!local) return { winner: 'remote', tie: false };
  if (!remote) return { winner: 'local', tie: false };

  if (local.updatedAt !== remote.updatedAt) {
    return { winner: local.updatedAt > remote.updatedAt ? 'local' : 'remote', tie: false };
  }

  // 时间相同：墓碑赢（保守）
  const localDeleted = local.deletedAt !== null;
  const remoteDeleted = remote.deletedAt !== null;
  if (localDeleted === remoteDeleted) return { winner: 'local', tie: true };
  return { winner: localDeleted ? 'local' : 'remote', tie: true };
}

export interface MergeOutcome<T extends SyncedRow> {
  /** 合并后的全量（含墓碑，因为调用方要写回库） */
  rows: T[];
  added: number;
  updated: number;
  /** 因远端更新而被改动的条数 */
  takenFromRemote: number;
}

/**
 * 把远端全量与本地全量合并。
 *
 * 双向**对称**：`merge(本地, 远端)` 与 `merge(远端, 本地)` 得到同一批行（时间相同时按墓碑规则），
 * 这正是"两端交替同步后趋向一致"的前提。
 */
export function mergeRows<T extends SyncedRow>(local: readonly T[], remote: readonly T[]): MergeOutcome<T> {
  const localById = new Map(local.map((row) => [row.id, row]));
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  const ids = new Set([...localById.keys(), ...remoteById.keys()]);

  const rows: T[] = [];
  let added = 0;
  let updated = 0;
  let takenFromRemote = 0;

  for (const id of ids) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    const decision = decideMerge(l, r);
    if (!decision) continue;

    if (decision.winner === 'remote' && r) {
      rows.push(r);
      // `takenFromRemote` 是"这一轮从远端拿到的条数"，新增也算——
      // 它给状态页用（"从另一台设备取回了 N 条"），少算新增会让这个数字骗人。
      takenFromRemote += 1;
      if (!l) added += 1;
      else if (l.updatedAt !== r.updatedAt || l.deletedAt !== r.deletedAt) {
        updated += 1;
      }
    } else if (l) {
      rows.push(l);
    }
  }

  return { rows, added, updated, takenFromRemote };
}

export interface WordMergeOutcome extends MergeOutcome<Word> {
  /** 被合并的旧 Word UUID → 保留下来的 Word UUID。 */
  idAliases: Record<string, string>;
  /** 规范行加上本地旧 UUID 的重定向墓碑；旧 UUID 不再作为活动词出现。 */
  localRows: Word[];
}

export interface SceneMergeOutcome {
  /** 上传用的规范 Scene：先按 id、再按重映射后的 contentHash 去重。 */
  rows: Scene[];
  /** put-only 本地落库：同 contentHash 复用已有本地 id，避免同步自身制造重复行。 */
  localRows: Scene[];
}

/**
 * Word 专用身份合并。通用 mergeRows 仍按 id 合并；这里额外把同 lemma 的 UUID 归成一组。
 * 内容仍由 updatedAt / 墓碑决定；同时间不同内容用稳定序列化作确定性平局裁决。
 */
export function mergeWords(
  local: readonly Word[],
  remote: readonly Word[],
  existingAliases: Readonly<Record<string, string>> = {},
): WordMergeOutcome {
  const groups = new Map<string, Array<{ row: Word; remote: boolean }>>();
  for (const [isRemote, rows] of [[false, local], [true, remote]] as const) {
    for (const row of isRemote ? remote : local) {
      const group = groups.get(row.lemma) ?? [];
      group.push({ row, remote: isRemote });
      groups.set(row.lemma, group);
    }
  }

  const rows: Word[] = [];
  const idAliases: Record<string, string> = Object.assign(Object.create(null), existingAliases);
  let added = 0;
  let updated = 0;
  let takenFromRemote = 0;
  const localById = new Map(local.map((row) => [row.id, row]));

  for (const [lemma, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const winner = group.reduce((best, candidate) =>
      compareWordPriority(candidate.row, best.row) < 0 ? candidate : best,
    );
    const canonical = winner.row;
    rows.push(canonical);
    // 本组出现较新的离线编辑时允许胜者改变，但必须移除旧方向，不能留下 A↔B。
    for (const { row } of group) delete idAliases[row.id];
    for (const { row } of group) {
      if (row.id !== canonical.id) idAliases[row.id] = canonical.id;
    }

    const previous = localById.get(canonical.id);
    if (!previous) added += 1;
    else if (!rowsEqual(previous, canonical)) updated += 1;
    if (winner.remote && (!previous || !rowsEqual(previous, canonical))) takenFromRemote += 1;
  }

  const canonicalById = new Map(rows.map((row) => [row.id, row]));
  const localRows = [...rows];
  for (const row of local) {
    const target = resolveAlias(row.id, idAliases);
    const canonical = target === row.id ? undefined : canonicalById.get(target);
    if (!canonical || row.deletedAt !== null) continue;
    // 这是身份重定向，不是用户的一次新删除：版本必须略旧于规范行，
    // 否则下一轮同时间墓碑会反过来删除刚收敛的活动词。
    localRows.push({
      ...row,
      updatedAt: Math.min(row.updatedAt, canonical.updatedAt - 1),
      deletedAt: canonical.updatedAt,
    });
  }

  return { rows, localRows, idAliases, added, updated, takenFromRemote };
}

/** Scene 专用合并：重映射 Word 身份，重算受影响 hash，并按 id/contentHash 去重。 */
export function mergeScenes(
  local: readonly Scene[],
  remote: readonly Scene[],
  idAliases: Readonly<Record<string, string>>,
): SceneMergeOutcome {
  const localRows = local.map((row) => remapScene(row, idAliases));
  const remoteRows = remote.map((row) => remapScene(row, idAliases));
  const byId = new Map<string, Scene>();
  for (const row of localRows) byId.set(row.id, row);
  for (const row of remoteRows) {
    const existing = byId.get(row.id);
    byId.set(row.id, existing ? preferScene(existing, row) : row);
  }

  const byHash = new Map<string, Scene>();
  for (const row of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const existing = byHash.get(row.contentHash);
    byHash.set(row.contentHash, existing ? preferScene(existing, row) : row);
  }
  const rows = [...byHash.values()].sort((a, b) => a.id.localeCompare(b.id));

  const localById = new Map(localRows.map((row) => [row.id, row]));
  const localByHash = new Map(localRows.map((row) => [row.contentHash, row]));
  const materialized = rows.map((row) => {
    if (localById.has(row.id)) return row;
    const reusable = localByHash.get(row.contentHash);
    return reusable ? { ...row, id: reusable.id } : row;
  });
  return { rows, localRows: materialized };
}

function preferScene(a: Scene, b: Scene): Scene {
  // Scene 没有 updatedAt；非空译文是新增信息，不能被旧空值覆盖。
  if ((a.translation !== null) !== (b.translation !== null)) return a.translation !== null ? a : b;
  // 其余字段（以及双方都有不同译文）没有可用时间戳，用全行稳定顺序保证可交换、幂等。
  return compareCodeUnits(stableStringify(a), stableStringify(b)) <= 0 ? a : b;
}

function compareWordPriority(a: Word, b: Word): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  const aDeleted = a.deletedAt !== null;
  const bDeleted = b.deletedAt !== null;
  if (aDeleted !== bDeleted) return aDeleted ? -1 : 1;
  if (a.deletedAt !== b.deletedAt) return (b.deletedAt ?? 0) - (a.deletedAt ?? 0);
  return compareCodeUnits(stableStringify(a), stableStringify(b));
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function remapScene(row: Scene, idAliases: Readonly<Record<string, string>>): Scene {
  const wordId = resolveAlias(row.wordId, idAliases);
  if (wordId === row.wordId) return row;
  return { ...row, wordId, contentHash: sceneHash(wordId, row.text) };
}

function resolveAlias(id: string, aliases: Readonly<Record<string, string>>): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    if (!Object.hasOwn(aliases, current)) break;
    const next = aliases[current];
    if (!next || next === current) break;
    seen.add(current);
    current = next;
  }
  return current;
}

/** 全字段相等性：同步不能只看时间而漏掉同时间的字段差异。 */
export function rowsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
