/**
 * 首装引导的判定与文案（PLAN.md FR-E6 / FR-F10 / FR-F11）。
 *
 * 这里只测纯逻辑；"四块是否真的渲染出来""点「知道了」是否写入"在
 * `entrypoints/manager/Onboarding.test.tsx` 与 `App.test.tsx` 里测。
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry, Meta } from '../db/types';
import {
  ONBOARDING_BLOCKS,
  dictStatusText,
  pickLatestDictLog,
  shouldShowOnboarding,
} from './onboarding';

function meta(patch: Partial<Meta> = {}): Meta {
  return {
    schemaVersion: 1,
    dictVersion: '',
    installedAt: 1700000000000,
    persistGranted: false,
    lastExportAt: null,
    lastSyncAt: null,
    syncState: 'idle',
    lastSyncError: null,
    onboardingDoneAt: null,
    translationNoticeAt: null,
    translateCalls: null,
    importedInflections: {},
    ...patch,
  };
}

function log(patch: Partial<LogEntry> = {}): LogEntry {
  return { level: 'info', scope: 'dict', message: '词库就绪', detail: {}, at: 1000, ...patch };
}

describe('FR-F10：该不该显示引导', () => {
  it('没看过就显示（新装与老用户都一样）', () => {
    expect(shouldShowOnboarding(meta())).toBe(true);
  });

  it('点过「知道了」之后不再显示', () => {
    expect(shouldShowOnboarding(meta({ onboardingDoneAt: 1700000000001 }))).toBe(false);
  });

  it('老库缺这个字段（读不到 meta）时按"没看过"处理', () => {
    expect(shouldShowOnboarding(null)).toBe(true);
    expect(shouldShowOnboarding(undefined)).toBe(true);
  });
});

describe('FR-F10：四块内容齐备', () => {
  it('清单就是规格点名的四块，不多不少', () => {
    expect([...ONBOARDING_BLOCKS]).toEqual([
      'dict-status',
      'uninstall-risk',
      'core-switches',
      'privacy',
    ]);
  });
});

describe('FR-F11：词库状态文案', () => {
  it('没有记录时说明"还没载入"与"不出网"', () => {
    const text = dictStatusText(undefined);
    expect(text).toContain('尚未载入');
    expect(text).toContain('不出网');
  });

  it('有记录时给出分片数 / 词数 / 版本 / 耗时', () => {
    const text = dictStatusText(
      log({ detail: { version: '0.1.0', entries: 3004, shards: ['core'], elapsedMs: 412.6 } }),
    );
    expect(text).toContain('1 个分片');
    expect(text).toContain('3004 词');
    expect(text).toContain('版本 0.1.0');
    expect(text).toContain('载入耗时 413 ms');
  });

  it('旧日志没有 elapsedMs（本次才加）时只报拿得到的部分，不编数字', () => {
    const text = dictStatusText(log({ detail: { version: '0.1.0', entries: 3004, shards: ['core'] } }));
    expect(text).toContain('3004 词');
    expect(text).not.toContain('载入耗时');
  });

  it('脏字段不影响文案（防御式读取）', () => {
    const text = dictStatusText(log({ detail: { version: 42, entries: 'many', shards: 'core' } }));
    expect(text).toBe('词库已就绪');
  });

  it('从日志里挑最近的一条词库记录', () => {
    const older = log({ at: 1000, detail: { version: 'old' } });
    const newer = log({ at: 3000, detail: { version: 'new' } });
    const other = log({ at: 5000, scope: 'content', message: '别的' });

    expect(pickLatestDictLog([older, other, newer])?.detail).toEqual({ version: 'new' });
    expect(pickLatestDictLog([other])).toBeUndefined();
  });
});
