/**
 * 导入词库的查询（FR-B7 / FR-B7b，`decisions/0031`）。
 *
 * 查的是 `dict` store（纯词典），**不碰生词本**。
 *
 * 查询顺序先便宜后贵：
 * 1. `dict` 主键直查（O(log n)）；
 * 2. 变形映射（`Meta.importedInflections`）→ 拿到 lemma 再查一次。
 */
import { getDictEntry } from './dict-store';
import { getMeta } from '../db/kv';
import type { DictEntry } from '../db/types';

/** ECDICT 的 `1:` 标记 → 中文形态名 */
const FORM_LABELS: Record<string, string> = {
  s: '复数形式',
  d: '过去式',
  p: '过去分词',
  i: '现在分词',
  '3': '第三人称单数形式',
  r: '比较级',
  t: '最高级',
};

/** 从 exchange 串里取原形：`d:perceived/p:perceived/0:run/1:d` → `run` */
export function lemmaFromExchange(exchange: string): string | null {
  if (!exchange) return null;
  for (const part of exchange.split('/')) {
    const [kind, value] = part.split(':');
    if (kind === '0' && value) return value.toLowerCase();
  }
  return null;
}

export function formLabelFromExchange(exchange: string): string | null {
  if (!exchange) return null;
  for (const part of exchange.split('/')) {
    const [kind, value] = part.split(':');
    if (kind === '1' && value) return FORM_LABELS[value] ?? null;
  }
  return null;
}

export interface ImportedHit {
  entry: DictEntry;
  /** surface 与词条原形不同时给形态提示（如「复数形式」） */
  hint: string | null;
}

/**
 * 在导入词典里查一个 surface。
 *
 * 返回 `null` = 导入词典里也没有（调用方据此判 FR-B4 的「未收录」）。
 * **内置分片的优先级更高**，调用方应先查分片再调这里。
 */
export async function lookupImported(surface: string): Promise<ImportedHit | null> {
  const key = surface.trim().toLowerCase();
  if (!key) return null;

  const direct = await getDictEntry(key);
  if (direct) return { entry: direct, hint: null };

  const { importedInflections } = await getMeta();
  const mapped = importedInflections[key];
  if (!mapped) return null;
  const base = await getDictEntry(mapped.lemma);
  if (!base) return null;
  return { entry: base, hint: mapped.label };
}

/** 导入词典的条目数（设置页显示"已导入 N 条"） */
export async function countImportedWords(): Promise<number> {
  const { countDictEntries } = await import('./dict-store');
  return countDictEntries();
}
