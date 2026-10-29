/**
 * 从现有 `dict` 重建变形映射（一次性修复工具，不重新导入词典）。
 *
 * 用于修复「dict 有数据、Meta.importedInflections 为空」的不一致状态：
 * 遍历 dict 里所有条目的 exchange 字段，重建映射表。77 万条约需几秒。
 */
import { STORE, readTx, req } from '../db/schema';
import type { DictEntry } from '../db/types';
import { getMeta, setMeta } from '../db/kv';

const FORM_LABELS: Record<string, string> = {
  s: '复数形式',
  d: '过去式',
  p: '过去分词',
  i: '现在分词',
  '3': '第三人称单数形式',
  r: '比较级',
  t: '最高级',
};

function formsFromExchange(exchange: string): Array<{ surface: string; label: string }> {
  const out: Array<{ surface: string; label: string }> = [];
  if (!exchange) return out;
  for (const part of exchange.split('/')) {
    const [kind, value] = part.split(':');
    if (!kind || !value || kind === '0' || kind === '1') continue;
    const label = FORM_LABELS[kind];
    if (!label) continue;
    for (const surface of value.split(',')) {
      const s = surface.trim().toLowerCase();
      if (s) out.push({ surface: s, label });
    }
  }
  return out;
}

/**
 * 扫全部 dict 条目，重建 `Meta.importedInflections`。返回写入的映射条数。
 *
 * 只在 dict 非空时有意义；dict 为空时清空映射并返回 0。
 */
export async function rebuildImportedInflections(): Promise<number> {
  const entries = await readTx(STORE.dict, (tx) => req<DictEntry[]>(tx.objectStore(STORE.dict).getAll()));
  const next: Record<string, { lemma: string; label: string }> = {};
  for (const entry of entries) {
    const lemma = entry.lemma.toLowerCase();
    for (const form of formsFromExchange(entry.exchange)) {
      if (form.surface === lemma) continue;
      next[form.surface] = { lemma, label: form.label };
    }
  }
  await setMeta({ importedInflections: next });
  return Object.keys(next).length;
}
