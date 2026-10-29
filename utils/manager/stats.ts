/**
 * 管理台顶部统计（PLAN.md FR-F8）。
 *
 * 纯函数从词表算，**不引图表库**（FR-F8 明确要求）。
 * "来源域名 Top N"的 N 与"遇见次数分布"的分档都在 `PLAN.md` §1.F 实现口径里定死：
 * N = 5；分布分档**直接复用 `meetCountTier`**——下划线呈现用的是同一个函数，
 * 因此不会出现"统计说 3 次、下划线却按 4 档画"的口径矛盾。
 */
import { meetCountTier } from '../content/highlight-plan';
import type { WordStatus } from '../db/types';
import type { ListRow } from './filter';

/** FR-F8：来源域名 Top N */
export const TOP_DOMAINS = 5;

/** 档位只有 5 档，与 `meetCountTier` 的值域一致 */
const TIER_MIN: Record<number, number> = { 1: 0, 2: 2, 3: 3, 4: 4, 5: 5 };

export interface MeetBucket {
  /** 档位序号 1~5，与下划线的粗细档一致 */
  tier: number;
  /** 下界（含） */
  from: number;
  /** 上界（含）；`null` 表示无上界 */
  to: number | null;
  count: number;
}

export interface ManagerStats {
  totalWords: number;
  /** 今日新增：按本地日历日切，不是"最近 24 小时" */
  newToday: number;
  knownCount: number;
  totalScenes: number;
  /** 域名 → 例句条数，降序取前 TOP_DOMAINS */
  topDomains: Array<{ domain: string; count: number }>;
  /** 遇见次数分布，分档与下划线呈现一致 */
  meetDistribution: MeetBucket[];
  /** 按状态分组的个数，用于概览 */
  byStatus: Record<WordStatus, number>;
}

const EMPTY_BY_STATUS = (): Record<WordStatus, number> => ({
  new: 0,
  known: 0,
  ignored: 0,
});

/** 本地日历日的起点。用本地时间而非 UTC——用户说的"今天"是本地今天 */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 五档的区间边界，供界面显示"2–2 次""5 次以上"这类标签 */
function buildBuckets(): MeetBucket[] {
  return [1, 2, 3, 4, 5].map((tier) => ({
    tier,
    from: TIER_MIN[tier]!,
    to: tier === 5 ? null : TIER_MIN[tier + 1]! - 1,
    count: 0,
  }));
}

export function computeStats(rows: readonly ListRow[], now: number): ManagerStats {
  const byStatus = EMPTY_BY_STATUS();
  const dayStart = startOfLocalDay(now);
  const domainCounts = new Map<string, number>();
  const meetDistribution = buildBuckets();

  let newToday = 0;
  let totalScenes = 0;
  let totalWords = 0;

  for (const row of rows) {
    // 软删除的词不进统计——否则"总词数"比列表里的行数多，用户会以为丢了数据
    if (row.word.deletedAt !== null) continue;

    const { word } = row;
    totalWords += 1;
    byStatus[word.status] += 1;
    totalScenes += row.sceneCount;

    if (word.createdAt >= dayStart) newToday += 1;

    // `meetCountTier` 返回 1~5，减 1 得下标
    meetDistribution[meetCountTier(word.meetCount) - 1]!.count += 1;

    // 按**例句数**合计。用 `domainCounts` 而不是 `domains.length`：
    // 后者是去重后的域名个数，一个站抓了 3 句只会算 1，Top N 会选错。
    for (const [domain, count] of Object.entries(row.domainCounts)) {
      if (domain === '') continue;
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + count);
    }
  }

  const topDomains = [...domainCounts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    // 条数相同时按域名升序，保证两次渲染顺序一致（与排序稳定性同一理由）
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, TOP_DOMAINS);

  return {
    totalWords,
    newToday,
    knownCount: byStatus.known,
    totalScenes,
    topDomains,
    meetDistribution,
    byStatus,
  };
}
