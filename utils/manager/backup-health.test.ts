/**
 * 备份提醒与体积自检的判定（PLAN.md FR-L5、FR-L6）。
 *
 * 这两条 FR 的价值全在**判定**上：提醒得太频繁是噪音（用户会学会无视它），
 * 提醒得太少就压不住 R10（卸载即丢）。所以每个分支都要有一条用例。
 */
import { describe, expect, it } from 'vitest';
import {
  BACKUP_REMIND_DAYS,
  STORAGE_WARN_BYTES,
  STORAGE_WARN_RATIO,
  backupReminder,
  backupReminderText,
  daysSince,
  formatBytes,
  storageStatus,
} from './backup-health';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16);

function health(over: Partial<{ lastExportAt: number | null; latestChangeAt: number | null; words: number; scenes: number; usage: number | null; quota: number | null }> = {}) {
  return {
    lastExportAt: null,
    latestChangeAt: null,
    words: 10,
    scenes: 20,
    usage: null,
    quota: null,
    ...over,
  };
}

describe('daysSince', () => {
  it('按天向下取整', () => {
    expect(daysSince(NOW - 3 * DAY - 1000, NOW)).toBe(3);
    expect(daysSince(NOW, NOW)).toBe(0);
  });

  it('未来时间与 null 都返回 null（时钟偏移不该显示成负数天）', () => {
    expect(daysSince(NOW + DAY, NOW)).toBeNull();
    expect(daysSince(null, NOW)).toBeNull();
  });
});

describe('FR-L6：超期且数据有变化才提醒', () => {
  it('从未导出过 → 提醒（第一次备份最要紧）', () => {
    expect(backupReminder(health({ words: 3 }), NOW)).toEqual({
      remind: true,
      reason: 'never',
      days: null,
    });
  });

  it('库里没有数据 → 不提醒（没什么可丢的）', () => {
    const reminder = backupReminder(health({ words: 0, scenes: 0 }), NOW);
    expect(reminder.remind).toBe(false);
    expect(reminder.reason).toBe('empty');
  });

  it('刚导出过 → 不提醒，哪怕随后改过数据', () => {
    const reminder = backupReminder(
      health({ lastExportAt: NOW - 2 * DAY, latestChangeAt: NOW - DAY }),
      NOW,
    );
    expect(reminder).toMatchObject({ remind: false, reason: 'recent', days: 2 });
  });

  it(`恰好 ${BACKUP_REMIND_DAYS} 天 → 还不提醒（"超过"不含等于）`, () => {
    const reminder = backupReminder(
      health({ lastExportAt: NOW - BACKUP_REMIND_DAYS * DAY, latestChangeAt: NOW }),
      NOW,
    );
    expect(reminder.remind).toBe(false);
  });

  it('超期但这段时间没有变化 → 不提醒（上次导出的就是当前状态）', () => {
    const reminder = backupReminder(
      health({ lastExportAt: NOW - 40 * DAY, latestChangeAt: NOW - 45 * DAY }),
      NOW,
    );
    expect(reminder).toMatchObject({ remind: false, reason: 'unchanged', days: 40 });
  });

  it('超期且有变化 → 提醒并带上天数', () => {
    const reminder = backupReminder(
      health({ lastExportAt: NOW - 31 * DAY, latestChangeAt: NOW - DAY }),
      NOW,
    );
    expect(reminder).toMatchObject({ remind: true, reason: 'stale', days: 31 });
  });

  it('变化时间拿不到（如库刚被清空过）时按"没变化"处理，不在无证据时催人', () => {
    const reminder = backupReminder(
      health({ lastExportAt: NOW - 40 * DAY, latestChangeAt: null }),
      NOW,
    );
    expect(reminder.remind).toBe(false);
  });

  it('文案：从未导出过与超期各说各的（用户要能判断该做什么）', () => {
    expect(backupReminderText({ remind: true, reason: 'never', days: null })).toContain('还没有导出过');
    expect(backupReminderText({ remind: true, reason: 'stale', days: 31 })).toContain('31 天');
    expect(backupReminderText({ remind: false, reason: 'recent', days: 1 })).toBe('');
  });
});

describe('FR-L5：体积分档', () => {
  it('远低于阈值 → ok', () => {
    expect(storageStatus({ usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 })).toMatchObject({
      level: 'ok',
      reason: null,
    });
  });

  it('超过绝对阈值 → warn（原因：数据量较大）', () => {
    expect(storageStatus({ usage: STORAGE_WARN_BYTES, quota: 10 * 1024 * 1024 * 1024 })).toMatchObject({
      level: 'warn',
      reason: 'bytes',
    });
  });

  it('没到绝对阈值但接近配额 → warn（原因：接近配额）', () => {
    const quota = 100 * 1024 * 1024; // 100 MB
    expect(storageStatus({ usage: quota * STORAGE_WARN_RATIO, quota })).toMatchObject({
      level: 'warn',
      reason: 'ratio',
    });
  });

  it('配额拿不到（null）但占用很大 → 仍按绝对阈值提醒', () => {
    expect(storageStatus({ usage: STORAGE_WARN_BYTES * 2, quota: null })).toMatchObject({
      level: 'warn',
      reason: 'bytes',
    });
  });

  it('拿不到占用 → unknown，**不是 ok**（不知道 ≠ 健康）', () => {
    expect(storageStatus({ usage: null, quota: 1024 })).toEqual({
      level: 'unknown',
      usage: null,
      quota: 1024,
      reason: null,
    });
  });

  it('配额是 0 或负数（不可信）→ unknown，不拿它算比例', () => {
    expect(storageStatus({ usage: 1024, quota: 0 }).level).toBe('unknown');
    expect(storageStatus({ usage: 1024, quota: -1 }).level).toBe('unknown');
  });
});

describe('formatBytes', () => {
  it('按量级选单位并保留一位小数', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe('2.0 GB');
  });

  it('拿不到时显示"未知"，不显示 0', () => {
    expect(formatBytes(null)).toBe('未知');
    expect(formatBytes(Number.NaN)).toBe('未知');
  });
});
