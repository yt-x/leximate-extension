/**
 * 数据健康：备份提醒与体积自检（PLAN.md FR-L5、FR-L6）。
 *
 * R10 风险的原话是"卸载扩展或清理浏览器数据会清除 IndexedDB，用户再次丢数据——
 * 重演原始痛点"。这两条 FR 是它的应对：**让用户在丢之前被提醒一次**。
 *
 * 这一层是**纯函数**：给它事实（上次导出时间、最近一次数据变化、占用与配额），
 * 它给结论（要不要提醒、体积算不算大）。取事实的部分在
 * `utils/db/maintenance.ts` 的 `readDataHealth()`，界面只做显示。
 */
import type { DataHealth } from '../db/maintenance';
import { tx } from '../i18n';

/**
 * FR-L6 的 N：距上次导出超过多少天提醒。
 *
 * 取 30 天（一个月）：更短会变成噪音（用户刚开始用就天天被提醒），
 * 更长压不住 R10。取舍与备选见 `decisions/0021-backup-reminder-trigger.md`。
 */
export const BACKUP_REMIND_DAYS = 30;

/** FR-L5 的绝对阈值：占用超过它就提示备份 */
export const STORAGE_WARN_BYTES = 50 * 1024 * 1024;

/**
 * FR-L5 的比例阈值：占配额的多少算"接近上限"。
 *
 * 为什么两个都要：只有绝对值会漏掉小配额设备（配额 100 MB 的机器上占 40 MB 已经很危险）；
 * 只有比例会在"配额 2 GB、占用 100 MB"时一直不提醒。
 */
export const STORAGE_WARN_RATIO = 0.25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 距离某个时间点过了多少天（向下取整）；`null` 或未来的时间返回 `null` */
export function daysSince(timestamp: number | null, now: number): number | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null;
  if (timestamp > now) return null;
  return Math.floor((now - timestamp) / DAY_MS);
}

export type BackupReminderReason = 'never' | 'stale' | 'recent' | 'unchanged' | 'empty';

export interface BackupReminder {
  /** 要不要在管理台顶部提示 */
  remind: boolean;
  reason: BackupReminderReason;
  /** 距上次导出的天数；从未导出为 `null` */
  days: number | null;
}

/**
 * FR-L6 的判定：**超期 且 有变化**才提醒。
 *
 * 四个分支各自对应一种"不该提醒"的情况，缺一个都会让提示条变成噪音：
 * - 库里没有数据 → 没什么可丢的，不提醒；
 * - 从未导出过 → 提醒（第一次备份最要紧）；
 * - 还没超过 N 天 → 不提醒（哪怕刚改过数据）；
 * - 超期但这段时间数据没变 → 不提醒（上次导出的那份就是当前状态）。
 */
export function backupReminder(
  health: Pick<DataHealth, 'lastExportAt' | 'latestChangeAt' | 'words' | 'scenes'>,
  now: number,
): BackupReminder {
  const days = daysSince(health.lastExportAt, now);
  const hasData = health.words > 0 || health.scenes > 0;

  if (!hasData) return { remind: false, reason: 'empty', days };
  if (health.lastExportAt === null) return { remind: true, reason: 'never', days: null };

  const elapsed = days ?? 0;
  if (elapsed <= BACKUP_REMIND_DAYS) return { remind: false, reason: 'recent', days };

  const changed = health.latestChangeAt !== null && health.latestChangeAt > health.lastExportAt;
  if (!changed) return { remind: false, reason: 'unchanged', days };

  return { remind: true, reason: 'stale', days };
}

export type StorageLevel = 'ok' | 'warn' | 'unknown';

export interface StorageStatus {
  level: StorageLevel;
  /** 真实占用（未知时为 `null`） */
  usage: number | null;
  quota: number | null;
  reason: 'bytes' | 'ratio' | null;
}

/**
 * FR-L5 的体积分档。
 *
 * ⚠️ **拿不到配额时返回 `unknown`，不是 `ok`**：`navigator.storage.estimate()`
 * 在部分环境下不存在或抛错，那时我们**不知道**大小——显示"占用正常"是谎报
 * （`CONSTRAINTS.md` 第 34 条："拿不到"与"是空的"必须分开）。
 */
export function storageStatus(health: Pick<DataHealth, 'usage' | 'quota'>): StorageStatus {
  const { usage, quota } = health;
  if (usage === null || !Number.isFinite(usage)) {
    return { level: 'unknown', usage: null, quota, reason: null };
  }
  if (quota !== null && (!Number.isFinite(quota) || quota <= 0)) {
    // 配额是 0 或负数说明这个数字不可信，按"未知"处理（比例没法算）
    return { level: 'unknown', usage, quota: null, reason: null };
  }

  if (usage >= STORAGE_WARN_BYTES) return { level: 'warn', usage, quota, reason: 'bytes' };
  if (quota !== null && usage / quota >= STORAGE_WARN_RATIO) {
    return { level: 'warn', usage, quota, reason: 'ratio' };
  }
  return { level: 'ok', usage, quota, reason: null };
}

/** 人类可读的容量。用于设置页的"占用 X / 配额 Y" */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return tx('未知');
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** 提示条上给用户看的一句话（文案与判定放在一起，避免界面各自拼） */
export function backupReminderText(reminder: BackupReminder): string {
  if (!reminder.remind) return '';
  if (reminder.reason === 'never') {
    return tx('还没有导出过备份：数据只在本机，卸载扩展或清理浏览器数据都会丢掉。到「生词」页点「导出…」备份一次。');
  }
  return tx('距上次导出已 {days} 天，这期间数据有变化。再导出一次，换机或重装时才不会丢。', {
      days: reminder.days ?? 0,
    });
}
