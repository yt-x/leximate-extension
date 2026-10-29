/**
 * 导入器的对外入口（PLAN.md §1.J）。
 *
 * 分三层，边界面就是 import 语句：
 * - `parse.ts`：文件 → 规范化数据（纯）
 * - `plan.ts`：合并策略与统计（纯，预演与执行共用）
 * - `apply.ts` / `collect.ts`：碰 IndexedDB 的那两层（只读既有数据 / 一个事务写完）
 */
export type { ImportBundle, ImportFormat, ImportScene, ImportWord } from './parse';
export { detectFormat, parseImport, parseTime, safeSpan } from './parse';

export type {
  DictProbe,
  DictProbeEntry,
  ExistingData,
  ImportPlan,
  ImportSample,
  ImportStats,
  PlanOptions,
  WordPlan,
} from './plan';
export { planImport } from './plan';

export { applyImportPlan } from './apply';
export { loadExistingData } from './collect';
