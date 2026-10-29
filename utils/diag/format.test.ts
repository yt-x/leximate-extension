/**
 * 诊断日志的呈现与导出（PLAN.md FR-L4 的"可查看、可导出"）。
 *
 * 导出文件的形状与文件名都有约定，所以逐字断言——"导出一份看着差不多的 JSON"
 * 在排查时等于没有（别人拿到手不知道该看哪个字段）。
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../db/types';
import {
  availableScopes,
  detailText,
  diagnosticsFilename,
  filterLogs,
  formatLogLine,
  LEVEL_LABEL,
  LOG_LEVELS,
  logsToJson,
  logsToText,
} from './format';

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    level: 'info',
    scope: 'dict',
    message: '词库就绪',
    detail: { version: '0.1.0', entries: 920 },
    at: Date.UTC(2026, 9, 16, 12, 0, 0),
    ...over,
  };
}

describe('筛选', () => {
  const entries = [
    entry({ id: 1, level: 'info', scope: 'install', message: '扩展已安装' }),
    entry({ id: 2, level: 'warn', scope: 'badge', message: '角标刷新失败', detail: { error: 'boom' } }),
    entry({ id: 3, level: 'debug', scope: 'content', message: 'popup-shown', detail: { surface: 'Running' } }),
  ];

  it('默认返回全部', () => {
    expect(filterLogs(entries)).toHaveLength(3);
    expect(filterLogs(entries, { level: 'all', scope: 'all' })).toHaveLength(3);
  });

  it('按级别精确筛（不是"及以上"）', () => {
    expect(filterLogs(entries, { level: 'warn' }).map((item) => item.id)).toEqual([2]);
  });

  it('按来源精确筛', () => {
    expect(filterLogs(entries, { scope: 'content' }).map((item) => item.id)).toEqual([3]);
  });

  it('文本是子串匹配、大小写不敏感，且同时看 message 与 detail', () => {
    expect(filterLogs(entries, { text: '角标' }).map((item) => item.id)).toEqual([2]);
    expect(filterLogs(entries, { text: 'BOOM' }).map((item) => item.id)).toEqual([2]);
    expect(filterLogs(entries, { text: 'running' }).map((item) => item.id)).toEqual([3]);
    expect(filterLogs(entries, { text: '  ' })).toHaveLength(3);
    expect(filterLogs(entries, { text: '不存在的词' })).toHaveLength(0);
  });

  it('多个条件之间是 AND', () => {
    expect(filterLogs(entries, { level: 'debug', scope: 'content' }).map((item) => item.id)).toEqual([3]);
    expect(filterLogs(entries, { level: 'warn', scope: 'content' })).toHaveLength(0);
  });

  it('availableScopes 去重并排序', () => {
    expect(availableScopes(entries)).toEqual(['badge', 'content', 'install']);
    expect(availableScopes([])).toEqual([]);
  });
});

describe('detail 折行', () => {
  it('字符串原样、对象转 JSON、null 为空串', () => {
    expect(detailText('已就绪')).toBe('已就绪');
    expect(detailText({ a: 1 })).toBe('{"a":1}');
    expect(detailText(null)).toBe('');
    expect(detailText(undefined)).toBe('');
  });
});

describe('一行文本', () => {
  it('带本地时间与偏移量、级别、来源、消息、detail', () => {
    const line = formatLogLine(entry({ level: 'error', scope: 'sync', message: '同步失败' }));

    expect(line).toContain('ERROR');
    expect(line).toContain('sync: 同步失败');
    expect(line).toContain('{"version":"0.1.0","entries":920}');
    // 时间带时区偏移（导出给别人看时不会被误读）
    expect(line).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]/);
  });

  it('logsToText 逐行拼接', () => {
    const text = logsToText([entry({ id: 1 }), entry({ id: 2, message: '第二条' })]);
    expect(text.split('\n')).toHaveLength(2);
    expect(text.split('\n')[1]).toContain('第二条');
  });
});

describe('导出 JSON', () => {
  it('载荷形状：app / kind / exportedAt / 版本 / 计数 / 日志数组', () => {
    const json = logsToJson([entry()], {
      appVersion: '0.1.0',
      at: new Date(Date.UTC(2026, 9, 16, 12, 0)),
    });
    const payload = JSON.parse(json) as Record<string, unknown>;

    expect(payload.app).toBe('leximate');
    expect(payload.kind).toBe('diagnostics');
    expect(payload.exportedAt).toBe('2026-10-16T12:00:00.000Z');
    expect(payload.appVersion).toBe('0.1.0');
    expect(payload.counts).toEqual({ entries: 1 });
    expect((payload.entries as LogEntry[])[0]!.message).toBe('词库就绪');
  });

  it('只含日志本身：没有设置、没有凭据（FR-H7 的同一条底线）', () => {
    const json = logsToJson([entry()], { appVersion: '0.1.0' });
    expect(json).not.toContain('webdav');
    expect(json).not.toContain('apiKey');
    expect(Object.keys(JSON.parse(json) as object).sort()).toEqual([
      'app',
      'appVersion',
      'counts',
      'entries',
      'exportedAt',
      'kind',
    ]);
  });

  it('不改动传入的条目（导出是无损的）', () => {
    const source = entry();
    logsToJson([source], { appVersion: '0.1.0' });
    expect(source.detail).toEqual({ version: '0.1.0', entries: 920 });
  });
});

describe('文件名与级别标签', () => {
  it('沿用 §3.2.5 的约定：leximate-diag-<YYYYMMDD-HHmm>.json', () => {
    const name = diagnosticsFilename(new Date(2026, 9, 16, 21, 30));
    expect(name).toBe('leximate-diag-20261016-2130.json');
    expect(name).toMatch(/^leximate-[a-z]+-\d{8}-\d{4}\.(tsv|csv|txt|json)$/);
  });

  it('四个级别都有中文标签（界面上不出现英文枚举）', () => {
    for (const level of LOG_LEVELS) {
      expect(LEVEL_LABEL[level]).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
