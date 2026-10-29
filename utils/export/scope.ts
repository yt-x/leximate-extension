/**
 * 导出范围（PLAN.md FR-G1）：全部 / 当前筛选结果 / 选中项。
 *
 * 纯函数，且**三个范围的语义各不相同**，很容易写错成同一个：
 *
 * - `all`：库里活着的全部词（`loadRows` 已排除墓碑），**与当前筛选无关**；
 * - `filtered`：当前筛选 + 搜索后的结果（管理台算好的那个数组）；
 * - `selected`：勾选集里仍在库中的词（用 `rows` 而不是 `filtered` 取，
 *   否则"先筛 A 勾几个、再筛 B 勾几个"会漏掉换筛选前勾的词，FR-F6 明确要求跨筛选生效）。
 */
import type { ListRow } from '../manager/filter';
import type { Selection } from '../manager/selection';

export type ExportScope = 'all' | 'filtered' | 'selected';

export interface ScopeMeta {
  value: ExportScope;
  label: string;
}

export const EXPORT_SCOPES: readonly ScopeMeta[] = [
  { value: 'all', label: '全部生词' },
  { value: 'filtered', label: '当前筛选结果' },
  { value: 'selected', label: '选中项' },
];

export interface ScopeInput {
  /** 库里活着的全部词（列表装载的结果） */
  rows: readonly ListRow[];
  /** 当前筛选 + 搜索后的结果 */
  filtered: readonly ListRow[];
  scope: ExportScope;
  selection: Selection;
}

/** 三种范围分别会导出多少条（面板上直接显示，免得用户猜） */
export function scopeCounts(input: Omit<ScopeInput, 'scope'>): Record<ExportScope, number> {
  return {
    all: input.rows.length,
    filtered: input.filtered.length,
    selected: input.rows.filter((row) => input.selection.has(row.word.id)).length,
  };
}

export function pickRows({ rows, filtered, scope, selection }: ScopeInput): ListRow[] {
  switch (scope) {
    case 'all':
      return [...rows];
    case 'filtered':
      return [...filtered];
    case 'selected':
      // 顺序取列表顺序（不是勾选顺序）：导出文件的顺序因此与用户在界面上看到的一致
      return rows.filter((row) => selection.has(row.word.id));
  }
}
