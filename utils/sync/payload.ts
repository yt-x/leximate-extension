/**
 * 同步载荷：打包与校验（PLAN.md FR-H2 / FR-H7）。
 *
 * 与"导出备份"的区别要有意识地说清：导出是**给用户看的、可回灌的**，
 * 同步载荷是**给另一台设备合并且必须带上墓碑的**（否则删掉的词会复活，见 `decisions/0019`）。
 *
 * 两个硬约束：
 *  - `schemaVersion` 不符就**整体拒绝**，不做"尽力而为导一半"——半份数据比没有更糟；
 *  - **凭据绝不入载荷**：这里显式挑字段，而不是"把整条 Settings 塞进去"。
 */
import type { Scene, Word } from '../db/types';

/** 当前载荷版本。加字段不改它；改语义才 +1 */
export const SYNC_SCHEMA_VERSION = 1;

export interface SyncPayload {
  kind: 'leximate-sync';
  schemaVersion: number;
  /** 载荷生成时间（毫秒）。用于"远端是否比我新"的快速判断，不参与逐条冲突 */
  updatedAt: number;
  words: Word[];
  scenes: Scene[];
  /** 同 lemma 合并后，旧 Word UUID 指向保留 UUID。 */
  idAliases: Record<string, string>;
}

export interface BuildPayloadInput {
  words: readonly Word[];
  scenes: readonly Scene[];
  idAliases?: Readonly<Record<string, string>>;
  now?: number;
}

/**
 * 打包。**显式挑字段**：`Word` 与 `Scene` 都是白名单式的结构，
 * 但调用方若误传了带额外键的对象也不会把凭据带出去（下面会重建对象）。
 */
export function buildPayload(input: BuildPayloadInput): SyncPayload {
  return {
    kind: 'leximate-sync',
    schemaVersion: SYNC_SCHEMA_VERSION,
    updatedAt: input.now ?? Date.now(),
    words: input.words.map(pickWord),
    scenes: input.scenes.map(pickScene),
    idAliases: { ...input.idAliases },
  };
}

function pickWord(word: Word): Word {
  return {
    id: word.id,
    lemma: word.lemma,
    surface: word.surface,
    phoneticUs: word.phoneticUs,
    phoneticUk: word.phoneticUk,
    phoneticSrc: word.phoneticSrc,
    defSrc: word.defSrc,
    defZh: [...word.defZh],
    pos: [...word.pos],
    examTags: [...word.examTags],
    freqBnc: word.freqBnc,
    freqCoca: word.freqCoca,
    exchange: word.exchange,
    status: word.status,
    meetCount: word.meetCount,
    isLemmatized: word.isLemmatized,
    inflectionOf: word.inflectionOf,
    isUnlisted: word.isUnlisted,
    origin: word.origin,
    fallbackDef: [...word.fallbackDef],
    llmDef: [...word.llmDef],
    createdAt: word.createdAt,
    updatedAt: word.updatedAt,
    // 墓碑必须带走：它是同步语义的一部分（FR-H3 / decisions/0019）
    deletedAt: word.deletedAt,
  };
}

function pickScene(scene: Scene): Scene {
  return {
    id: scene.id,
    wordId: scene.wordId,
    text: scene.text,
    highlightFrom: scene.highlightFrom,
    highlightTo: scene.highlightTo,
    translation: scene.translation,
    sourceUrl: scene.sourceUrl,
    sourceTitle: scene.sourceTitle,
    domain: scene.domain,
    capturedAt: scene.capturedAt,
    contentHash: scene.contentHash,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isWord(value: unknown): value is Word {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.lemma === 'string' &&
    typeof value.surface === 'string' &&
    typeof value.phoneticUs === 'string' &&
    typeof value.phoneticUk === 'string' &&
    (value.phoneticSrc === null || value.phoneticSrc === 'pipeline' || value.phoneticSrc === 'imported') &&
    (value.defSrc === null || value.defSrc === 'authored' || value.defSrc === 'imported' || value.defSrc === 'llm') &&
    isStringArray(value.defZh) &&
    isStringArray(value.pos) &&
    isStringArray(value.examTags) &&
    isNumber(value.freqBnc) &&
    isNumber(value.freqCoca) &&
    typeof value.exchange === 'string' &&
    (value.status === 'new' || value.status === 'known' || value.status === 'ignored') &&
    isNumber(value.meetCount) &&
    typeof value.isLemmatized === 'boolean' &&
    isNullableString(value.inflectionOf) &&
    typeof value.isUnlisted === 'boolean' &&
    (value.origin === 'native' || value.origin === 'migrated') &&
    isStringArray(value.fallbackDef) &&
    isStringArray(value.llmDef) &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt) &&
    isNullableNumber(value.deletedAt)
  );
}

function isScene(value: unknown): value is Scene {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.wordId === 'string' &&
    typeof value.text === 'string' &&
    isNumber(value.highlightFrom) &&
    isNumber(value.highlightTo) &&
    isNullableString(value.translation) &&
    typeof value.sourceUrl === 'string' &&
    typeof value.sourceTitle === 'string' &&
    typeof value.domain === 'string' &&
    isNumber(value.capturedAt) &&
    typeof value.contentHash === 'string'
  );
}

export type ParsePayloadResult =
  | { ok: true; payload: SyncPayload }
  | { ok: false; reason: 'not-json' | 'not-sync' | 'version' | 'shape' };

/**
 * 校验并解析远端载荷。
 *
 * 版本不符返回 `version` 而不是"尽力解析"：跨版本字段语义可能已经变了，
 * 强行合并会写出两边都读不懂的行。
 */
export function parsePayload(raw: string): ParsePayloadResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not-json' };
  }

  if (typeof data !== 'object' || data === null) return { ok: false, reason: 'shape' };
  const record = data as Record<string, unknown>;
  if (record.kind !== 'leximate-sync') return { ok: false, reason: 'not-sync' };
  if (record.schemaVersion !== SYNC_SCHEMA_VERSION) return { ok: false, reason: 'version' };

  const words = record.words;
  const scenes = record.scenes;
  if (!Array.isArray(words) || !Array.isArray(scenes)) return { ok: false, reason: 'shape' };
  if (!isNumber(record.updatedAt)) return { ok: false, reason: 'shape' };

  if (!words.every(isWord) || !scenes.every(isScene)) return { ok: false, reason: 'shape' };
  if (
    record.idAliases !== undefined &&
    (!isRecord(record.idAliases) || !Object.values(record.idAliases).every((value) => typeof value === 'string'))
  ) {
    return { ok: false, reason: 'shape' };
  }

  return {
    ok: true,
    payload: {
      kind: 'leximate-sync',
      schemaVersion: SYNC_SCHEMA_VERSION,
      updatedAt: record.updatedAt,
      words: words as Word[],
      scenes: scenes as Scene[],
      idAliases:
        typeof record.idAliases === 'object' && record.idAliases !== null && !Array.isArray(record.idAliases)
          ? (record.idAliases as Record<string, string>)
          : {},
    },
  };
}

/**
 * 载荷里出现凭据键就会在用例里被抓住——这里提供一个**显式检查**，
 * 供"导出不含凭据"那类断言复用（FR-H7）。
 */
export const CREDENTIAL_KEYS = ['password', 'apiKey', 'authorization', 'username', 'headers'] as const;

export function findCredentialLeak(payload: unknown): string[] {
  const hits: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if ((CREDENTIAL_KEYS as readonly string[]).includes(key)) hits.push(`${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(payload, '$');
  return hits;
}
