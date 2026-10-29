/**
 * 词库导入区的真实依赖（`entrypoints/manager/DictionarySection.tsx` 的装配层）。
 *
 * 与组件分开的理由：组件只做状态与渲染，可注入假依赖在 jsdom 里验；
 * 这里把文件文本、解析、分档、入库、移除接到真实实现上。
 *
 * **导入进的是 `dict` store（词典），不是 `words`（生词本）**——`decisions/0031`。
 */
import {
  collectEcdictBatch,
  countEcdictPlan,
  removeImportedDictionary,
  runEcdictImport,
} from '@/utils/import/ecdict-apply';
import { countDictEntries } from '@/utils/dict/dict-store';
import { rebuildImportedInflections } from '@/utils/dict/rebuild-inflections';
import { parseEcdictRows } from '@/utils/import/ecdict-parse';
import type { DictionaryDeps, DictionaryPreview, DictionaryTier } from './DictionarySection';

/** 完整档写入 77 万条约 2 分钟（实测 121.5 s），因此批大小取 5000 */
const BATCH_SIZE = 5000;

export function browserDictionaryDeps(): DictionaryDeps {
  return {
    readImportedCount: () => countDictEntries(),

    async parseAndCount(text: string, tier: DictionaryTier): Promise<DictionaryPreview> {
      const parsed = parseEcdictRows(text);
      if (!parsed.headerOk) {
        throw new Error(
          parsed.reason ?? '不是 ECDICT 的 ecdict.csv：表头不是预期的 13 列',
        );
      }
      if (parsed.rows.length === 0) {
        throw new Error('文件里没有可用的词条');
      }
      const count = countEcdictPlan(parsed.rows, tier);
      const standard = countEcdictPlan(parsed.rows, 'standard');
      return {
        total: count.total,
        skippedBadRows: parsed.skipped,
        standardTier: standard.total,
      };
    },

    async importFile(text, tier, hooks) {
      const parsed = parseEcdictRows(text);
      if (!parsed.headerOk) {
        throw new Error(parsed.reason ?? '表头不符');
      }
      const batch = collectEcdictBatch(parsed.rows, tier);
      // 写词典 + 建变形映射合成一次调用——两步分开时，用户在 77 万条写入期间
      // 关掉页面就会留下"词典有、映射无"的不一致（见 changes/leximate-dispatching-lookup.md）
      return runEcdictImport(batch.entries, {
        batchSize: BATCH_SIZE,
        isCancelled: hooks.isCancelled,
        onProgress: hooks.onProgress,
      });
    },

    removeImported: () => removeImportedDictionary(),

    async rebuildInflections() {
      const mappings = await rebuildImportedInflections();
      return { mappings };
    },
  };
}
