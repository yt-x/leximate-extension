/**
 * `ecdict.csv` 导入的加工层（PLAN.md FR-B7）。
 *
 * **只产出 `DictEntry`（词典条目），不碰生词本**——`decisions/0031` 的教训：
 * 上一轮把词典写进 `words`，靠 `defSrc === 'imported'` 过滤区分，
 * 结果漏一处就"词典全变成生词"。
 *
 * 三步：
 * 1. `countEcdictPlan`：按档算"会导入多少条"（预演，不写库）；
 * 2. `collectEcdictBatch`：把解析行转成 `DictEntry`，按 lemma 去重；
 * 3. `writeEcdictEntries`：分批写 `dict` store，带进度与取消。
 *
 * 内置 3,004 条**不在这里处理**：它走随包分片（`public/dict/shard-core.json`），
 * 与 `dict` store 是两条并行的数据来源，查询时合并。
 */
import { clearDict, writeDictEntries, type WriteDictSummary } from '../dict/dict-store';
import { getMeta, setMeta } from '../db/kv';
import { buildDictEntry } from './ecdict-parse';
import type { DictEntry } from '../db/types';
import type { EcdictRow } from './ecdict-parse';

/** 导入档位（FR-B7：标准档默认、完整档可选） */
export type EcdictTier = 'standard' | 'full';

export interface EcdictPlanCount {
  /** 按档过滤后的条数 */
  total: number;
  /** 被档位过滤掉的行数 */
  skippedByTier: number;
}

export interface EcdictBatch {
  entries: DictEntry[];
  /** 同 lemma 重复时丢弃的条数 */
  skippedDuplicate: number;
}

/** 按档算预演条数：不碰数据库，纯函数 */
export function countEcdictPlan(rows: EcdictRow[], tier: EcdictTier): EcdictPlanCount {
  if (tier === 'full') {
    return { total: rows.length, skippedByTier: 0 };
  }
  let total = 0;
  for (const row of rows) {
    if (isStandardRow(row)) {
      total += 1;
    }
  }
  return { total, skippedByTier: rows.length - total };
}

function isStandardRow(row: EcdictRow): boolean {
  const tags = row.tag.split(/\s+/).filter(Boolean);
  return tags.length > 0;
}

/**
 * 解析行 → 词典条目（按档过滤 + 按 lemma 去重）。
 *
 * 不再需要"跳过内置词"：内置词表在分片里，与 `dict` store 不是同一份数据；
 * 查询时内置优先（`plan/b-dictionary.md` FR-B9/B10 的「库里已有 → 库里赢」）。
 */
export function collectEcdictBatch(rows: EcdictRow[], tier: EcdictTier): EcdictBatch {
  const entries: DictEntry[] = [];
  const seen = new Set<string>();
  let skippedDuplicate = 0;

  for (const row of rows) {
    if (tier === 'standard' && !isStandardRow(row)) {
      continue;
    }
    const entry = buildDictEntry(row);
    if (seen.has(entry.lemma)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(entry.lemma);
    entries.push(entry);
  }

  return { entries, skippedDuplicate };
}

const FORM_LABELS: Record<string, string> = {
  s: '复数形式',
  d: '过去式',
  p: '过去分词',
  i: '现在分词',
  '3': '第三人称单数形式',
  r: '比较级',
  t: '最高级',
};

/**
 * 从 `exchange` 串解析出「变形形式 → 形态名」。
 *
 * `0:` 是原形、`1:` 是本词形自己的类型——两者都不产生变形映射。
 */
export function exchangeForms(exchange: string): Array<{ surface: string; label: string }> {
  const out: Array<{ surface: string; label: string }> = [];
  if (!exchange) return out;
  for (const part of exchange.split('/')) {
    const [kind, value] = part.split(':');
    if (!kind || !value) continue;
    if (kind === '0' || kind === '1') continue;
    const label = FORM_LABELS[kind];
    if (!label) continue;
    for (const surface of value.split(',')) {
      const trimmed = surface.trim().toLowerCase();
      if (trimmed) out.push({ surface: trimmed, label });
    }
  }
  return out;
}

/**
 * 生成并写入导入词库的变形映射（FR-B7b）。
 *
 * 存在 `Meta.importedInflections`：`surface → { lemma, label }`。
 * 查词时先用它把变形还原成 lemma，再去 `dict` 取条目。
 */
export async function buildImportedInflections(entries: DictEntry[]): Promise<number> {
  const { importedInflections } = await getMeta();
  const next: Record<string, { lemma: string; label: string }> = { ...importedInflections };
  let added = 0;
  for (const entry of entries) {
    const lemma = entry.lemma.toLowerCase();
    for (const form of exchangeForms(entry.exchange)) {
      if (form.surface === lemma) continue;
      next[form.surface] = { lemma, label: form.label };
      added += 1;
    }
  }
  await setMeta({ importedInflections: next });
  return added;
}

/** 清空导入词库的变形映射（移除词库时调用） */
export async function clearImportedInflections(): Promise<void> {
  await setMeta({ importedInflections: {} });
}

export interface RunEcdictImportOptions {
  batchSize?: number;
  onProgress?: (written: number) => void;
  isCancelled?: () => boolean;
}

/**
 * **导入的原子入口**：写词典 + 建变形映射，一步到位。
 *
 * 为什么必须合成一个入口（用户实测 2026-10-22）：
 * 原来两个动作分开（`importFile` 里先 `writeDictEntries`、再在 `if (!cancelled)` 里
 * `buildImportedInflections`）。但完整档 77 万条写入约 2 分钟，用户在这期间
 * 关掉 / 刷新管理台页面，就留下「`dict` 有 77 万条、`Meta.importedInflections` 是空」的
 * 不一致状态——所有靠变形还原的词（`dispatched` / `dispatching` ...）从此查不到。
 *
 * 本函数把两步收进同一次调用，使调用方无法只做一半。
 * 取消判断仍发生在批与批之间；**取消时不写映射**，此时词典可能已有部分条目
 * （每条记录自身完整，重导幂等），但不会有悬空映射。
 */
export async function runEcdictImport(
  entries: DictEntry[],
  options: RunEcdictImportOptions = {},
): Promise<{ written: number; cancelled: boolean }> {
  const summary = await writeDictEntries(entries, {
    batchSize: options.batchSize,
    onProgress: options.onProgress,
    isCancelled: options.isCancelled,
  });
  if (!summary.cancelled) {
    await buildImportedInflections(entries);
  }
  return summary;
}

/**
 * 移除导入词库（FR-B7 的退路）。
 *
 * **只清 `dict` store，绝不碰 `words`**——用户生词本里的词一条都不动。
 * 同时清空变形映射。
 */
export async function removeImportedDictionary(): Promise<{ removed: number }> {
  const result = await clearDict();
  await clearImportedInflections();
  return result;
}

export type WriteEcdictSummary = WriteDictSummary;
