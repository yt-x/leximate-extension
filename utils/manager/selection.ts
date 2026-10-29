/**
 * 批量操作的选中集（PLAN.md FR-F6）。
 *
 * 存**词 id 集合**而不是"当前页的行下标"——这是 §1.F 里定下的语义：
 * 切换筛选或排序后，仍被选中的词保持选中。
 * 若存下标，换一次排序就会选中完全不同的词，而界面上看不出来。
 *
 * 纯函数，不碰 React 状态。
 */
import type { WordStatus } from '../db/types';

export type Selection = ReadonlySet<string>;

export function emptySelection(): Selection {
  return new Set<string>();
}

/**
 * 全选当前结果集。
 *
 * 语义是**并集**而非替换：用户可能先筛 A 勾几个、再筛 B 勾几个，
 * FR-F6 要求"全选与跨筛选多选都生效"。
 */
export function selectAll(current: Selection, ids: readonly string[]): Selection {
  const next = new Set(current);
  for (const id of ids) next.add(id);
  return next;
}

export function deselectAll(current: Selection, ids: readonly string[]): Selection {
  const next = new Set(current);
  for (const id of ids) next.delete(id);
  return next;
}

export function toggleOne(current: Selection, id: string): Selection {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function clearSelection(): Selection {
  return new Set<string>();
}

export function isAllSelected(current: Selection, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  return ids.every((id) => current.has(id));
}

/**
 * 选中集里**当前仍存在**的那些 id。
 *
 * 用途：用户勾了一批词，然后在别处删掉其中几个——下载/导出/改状态前
 * 要用这个过滤，避免拿着已消失的 id 去操作（那会静默少几条，或报错）。
 * 界面上的勾选数也应显示这个值，否则用户会以为"选了 10 个"实际只有 8 个。
 */
export function liveIds(selection: Selection, existingIds: readonly string[]): string[] {
  const existing = new Set(existingIds);
  return [...selection].filter((id) => existing.has(id));
}

/** 选中集里已被删除（不在当前数据中）的 id，供界面提示"有 N 项已失效" */
export function staleIds(selection: Selection, existingIds: readonly string[]): string[] {
  const existing = new Set(existingIds);
  return [...selection].filter((id) => !existing.has(id));
}

/** 把选中集里的词的 id 抽出来，供批量改状态使用 */
export function idsOf(rows: ReadonlyArray<{ word: { id: string } }>): string[] {
  return rows.map((r) => r.word.id);
}

/**
 * FR-F6：批量改状态的合法目标。
 *
 * `ignored` 也在其中——用户可能把误标的词批量改成忽略。
 * 排除 `ignored` 反而会让"批量取消忽略"没有入口。
 */
export const BULK_STATUSES: readonly WordStatus[] = ['new', 'known', 'ignored'];

/**
 * FR-F6：删除的二次确认文案。
 *
 * §1.F 定的是"展示将要删除的条数并要求再点一次"，**不用 `window.confirm`**
 * （`confirm` 在扩展页会被部分环境拦截，且无法单测）。
 * 文案由纯函数生成，因此可断言"确认框里确实带着条数"。
 */
export function deleteConfirmText(count: number): string {
  if (count <= 0) return '';
  return `确认删除 ${count} 个单词及其全部例句？此操作不可撤销。`;
}
