/**
 * 列表的搜索 / 筛选 / 排序（PLAN.md FR-F3、FR-F4、FR-F5）。
 *
 * 全是纯函数：不碰 DOM、不碰 IndexedDB、不碰 React。
 * 这样 §1.F 的实现口径里那些语义（条件间 AND、条件内 OR、排序稳定性、
 * 子串匹配大小写不敏感）都能在无浏览器环境逐条断言。
 *
 * 数据规模口径沿用 `listWords`（`verification/M1-2.md` 实测 1 万词 < 300ms）：
 * 整表读进内存后在内存里筛。等真的上到十万级再换游标分页。
 */
import type { Word, WordStatus } from '../db/types';

/** FR-F5：四种排序 */
export type SortKey = 'createdAt' | 'meetCount' | 'freqBnc' | 'lemma';
export type SortDirection = 'asc' | 'desc';

export interface FilterCriteria {
  /** FR-F3：子串匹配，大小写不敏感 */
  search?: string;
  /** FR-F4：状态多选（**条件内 OR**，空数组表示不筛） */
  statuses?: WordStatus[];
  /** FR-F4：来源域名多选（条件内 OR） */
  domains?: string[];
  /** FR-F4：考试标签多选（条件内 OR） */
  examTags?: string[];
  /** FR-F4：创建时间闭区间 [from, to]；null 表示该端不设限 */
  createdFrom?: number | null;
  createdTo?: number | null;
  /** FR-F4：词频区间（按 freqBnc）闭区间 */
  freqFrom?: number | null;
  freqTo?: number | null;
  /** FR-F4：有无例句。true 只留例句数 > 0，false 只留 = 0，undefined 不筛 */
  hasScenes?: boolean;
  /** 默认排除软删除的词 */
  includeDeleted?: boolean;
}

export interface SortSpec {
  key: SortKey;
  direction: SortDirection;
}

export const DEFAULT_SORT: SortSpec = { key: 'createdAt', direction: 'desc' };

/** 一条列表行需要的外部数据（例句数与来源域名不在 `Word` 上） */
export interface ListRow {
  word: Word;
  /**
   * 该词的例句**条数**（同一域名下多条例句算多条）。
   * FR-F2 的"例句数"列显示的就是它。
   */
  sceneCount: number;
  /**
   * 该词例句涉及的域名，**已去重**（FR-F2 的"来源域名"列）。
   *
   * ⚠️ 去重是刻意的：列表与筛选项显示"来自哪些站"，
   * `a.com` 重复三遍没有意义。
   */
  domains: string[];
  /**
   * 域名 → 该域名下的例句条数（**不去重**的计数）。
   *
   * 与 `domains` 分开是因为两者的正确取值不同，且用一个糊弄另一个会出错：
   * - `domains` 回答"来自哪些站"（列表列、筛选项）
   * - `domainCounts` 回答"每个站抓了多少句"（FR-F8 的 Top N）
   *
   * 曾想用 `domains.length` 代替，但那样"一个站抓了 3 句"只算 1 次，
   * Top N 会选错。
   */
  domainCounts: Record<string, number>;
}

/**
 * FR-F3：子串匹配，大小写不敏感，同时看 `lemma` 与 `surface`。
 *
 * 明确**不做**拼音、不做编辑距离——那要引入依赖，且"为什么 `rnu` 能匹配到 `run`"
 * 对用户不可解释。`lemma` 与 `surface` 都看是因为列表展示的是 surface，
 * 用户会照着看到的字面去搜（`went` 显示为 `went`，但 lemma 是 `go`）。
 */
export function matchesSearch(row: ListRow, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;

  return (
    row.word.lemma.toLowerCase().includes(needle) ||
    row.word.surface.toLowerCase().includes(needle)
  );
}

/** 判定一条行是否满足全部条件（**条件之间是 AND**） */
export function matchesFilter(row: ListRow, criteria: FilterCriteria): boolean {
  const { word } = row;

  // 软删除默认不显示；单独列出来是因为它是"数据完整性"而非"用户筛选"
  if (!criteria.includeDeleted && word.deletedAt !== null) return false;

  // FR-F3
  if (criteria.search !== undefined && !matchesSearch(row, criteria.search)) return false;

  // 以下多选条件内部都是 OR（空数组 = 不筛）
  const statuses = criteria.statuses ?? [];
  if (statuses.length > 0 && !statuses.includes(word.status)) return false;

  const domains = criteria.domains ?? [];
  if (domains.length > 0 && !domains.some((d) => row.domains.includes(d))) return false;

  const examTags = criteria.examTags ?? [];
  if (examTags.length > 0 && !examTags.some((t) => word.examTags.includes(t))) return false;

  // 闭区间；null / undefined 表示该端不设限
  if (criteria.createdFrom != null && word.createdAt < criteria.createdFrom) return false;
  if (criteria.createdTo != null && word.createdAt > criteria.createdTo) return false;
  // FR-F4：`freqBnc === 0` 是"没有排名"，不是"排名第 0"。
  // 设了任一端就把无排名词排除，否则"筛前 2 万词"会把一堆没排名的词也捞进来。
  const freqFiltered = criteria.freqFrom != null || criteria.freqTo != null;
  if (freqFiltered && word.freqBnc <= 0) return false;
  if (criteria.freqFrom != null && word.freqBnc < criteria.freqFrom) return false;
  if (criteria.freqTo != null && word.freqBnc > criteria.freqTo) return false;

  if (criteria.hasScenes === true && row.sceneCount <= 0) return false;
  if (criteria.hasScenes === false && row.sceneCount > 0) return false;

  return true;
}

/**
 * FR-F5：排序，**必须稳定**。
 *
 * "稳定"在这里的具体含义：主键相同时按 `lemma` 升序兜底。
 * 这不是锦上添花——虚拟滚动按索引切片渲染，同一次查询的两次渲染若顺序不同，
 * 用户滚动时会看到行内容跳动。
 *
 * 用 `lemma` 而不是"保持原顺序"做兜底，是因为后者依赖输入顺序，
 * 而输入顺序在筛选之后不保证一致（`Array.filter` 保序，但将来换数据源就不一定）。
 */
export function compareRows(a: ListRow, b: ListRow, spec: SortSpec): number {
  const dir = spec.direction === 'asc' ? 1 : -1;

  let primary = 0;
  switch (spec.key) {
    case 'createdAt':
      primary = a.word.createdAt - b.word.createdAt;
      break;
    case 'meetCount':
      primary = a.word.meetCount - b.word.meetCount;
      break;
    case 'freqBnc':
      primary = a.word.freqBnc - b.word.freqBnc;
      break;
    case 'lemma':
      primary = a.word.lemma.localeCompare(b.word.lemma);
      break;
  }
  if (primary !== 0) return primary * dir;

  // 兜底**不随方向翻转**：永远按 lemma 升序，保证同一次查询的确定性
  return a.word.lemma.localeCompare(b.word.lemma);
}

/**
 * 一次算完筛选 + 排序。
 *
 * 不修改入参（返回新数组）：调用方会把结果放进 React state，
 * 原地排序会让"数据变了但引用没变"从而不触发重渲染。
 */
export function selectRows(
  rows: readonly ListRow[],
  criteria: FilterCriteria,
  spec: SortSpec = DEFAULT_SORT,
): ListRow[] {
  return rows.filter((row) => matchesFilter(row, criteria)).sort((a, b) => compareRows(a, b, spec));
}

/**
 * 从结果集里抽出可选的筛选项（供界面渲染下拉框）。
 *
 * 从**当前数据**里抽而不是写死枚举：用户没见过的域名/标签不该出现在筛选项里。
 */
export function availableFacets(rows: readonly ListRow[]): {
  domains: string[];
  examTags: string[];
} {
  const domains = new Set<string>();
  const examTags = new Set<string>();

  for (const row of rows) {
    for (const d of row.domains) if (d !== '') domains.add(d);
    for (const t of row.word.examTags) if (t !== '') examTags.add(t);
  }

  return {
    domains: [...domains].sort((a, b) => a.localeCompare(b)),
    examTags: [...examTags].sort((a, b) => a.localeCompare(b)),
  };
}
