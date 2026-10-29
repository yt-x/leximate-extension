/**
 * 后台装配里的两个判断（PLAN.md FR-D5 / FR-D7）：每日计数与告知门禁。
 *
 * 这两件事出错的方式都很隐蔽——计数跨天没归零 → 额度永远用不了；
 * 告知判定写反 → 用户没同意就发请求。所以单独测。
 */
import { describe, expect, it, vi } from 'vitest';
import { addCalls, callsToday, localDateKey, runTranslatePass, type DailyCalls } from './assembly';
import { enqueueTranslation } from '../db/translations';
import type { Settings } from '../db/types';

const NOW = new Date('2026-10-17T10:00:00Z').getTime();

describe('每日计数', () => {
  it('本地日历日的键是 YYYY-MM-DD（补零）', () => {
    expect(localDateKey(new Date(2026, 0, 5).getTime())).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31).getTime())).toBe('2026-12-31');
  });

  it('跨天自动归零（不写回）', () => {
    expect(callsToday({ date: localDateKey(NOW), count: 7 }, NOW)).toBe(7);
    expect(callsToday({ date: '2026-10-16', count: 7 }, NOW)).toBe(0);
    expect(callsToday(null, NOW)).toBe(0);
  });

  it('累加；跨天从 1 重新开始', () => {
    expect(addCalls({ date: localDateKey(NOW), count: 3 }, NOW, 1)).toEqual({
      date: localDateKey(NOW),
      count: 4,
    });
    expect(addCalls({ date: '2026-10-16', count: 99 }, NOW, 1)).toEqual({
      date: localDateKey(NOW),
      count: 1,
    });
    expect(addCalls(null, NOW, 2)).toEqual({ date: localDateKey(NOW), count: 2 });
  });
});

function assembly(overrides: {
  settings: Settings;
  notice: number | null;
  calls?: { date: string; count: number } | null;
}) {
  const setMeta = vi.fn(async () => undefined);
  return {
    setMeta,
    deps: {
      getSettings: async () => overrides.settings,
      getMeta: async () => ({
        translationNoticeAt: overrides.notice,
        translateCalls: overrides.calls ?? null,
      }),
      setMeta,
      getSceneText: async (id: string) => (id === 's1' ? 'hello one' : undefined),
      log: vi.fn(),
      now: () => NOW,
    },
  };
}

const configured = {
  translation: {
    engine: 'llm' as const,
    targetLang: 'zh-CN',
    llm: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
    api: null,
    limits: { batchSize: 20, concurrency: 2, dailyLimit: 2000 },
  },
} as unknown as Settings;

const unconfigured = {
  translation: {
    engine: 'llm' as const,
    targetLang: 'zh-CN',
    llm: null,
    api: null,
    limits: { batchSize: 20, concurrency: 2, dailyLimit: 2000 },
  },
} as unknown as Settings;

describe('告知门禁（FR-D7）', () => {
  it('没确认过告知 → 整轮跳过，且不写任何 meta', async () => {
    const { deps, setMeta } = assembly({ settings: configured, notice: null });

    const summary = await runTranslatePass(deps);

    expect(summary.disabled).toBe(true);
    expect(setMeta).not.toHaveBeenCalled();
  });

  it('配置不完整时即便已确认也不跑', async () => {
    const { deps } = assembly({ settings: unconfigured, notice: NOW });
    expect((await runTranslatePass(deps)).disabled).toBe(true);
  });

  it('已确认 + 配置完整 → 会走到队列（此处队列为空，故 handled 为 0 且非 disabled）', async () => {
    const { deps } = assembly({ settings: configured, notice: NOW });
    const summary = await runTranslatePass(deps);

    expect(summary.disabled).toBe(false);
    expect(summary.handled).toBe(0);
  });
});

describe('FR-D5：并发请求写每日计数', () => {
  it('两个真实请求都持久化，不用旧 meta 快照覆盖计数', async () => {
    await enqueueTranslation({ wordId: 'w1', sceneId: 's1', textHash: 'h1', targetLang: 'zh-CN' });
    await enqueueTranslation({ wordId: 'w2', sceneId: 's2', textHash: 'h2', targetLang: 'zh-CN' });
    let stored: DailyCalls | null = { date: localDateKey(NOW), count: 0 };
    const setMeta = vi.fn(async (patch: { translationNoticeAt?: number; translateCalls?: DailyCalls }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (patch.translateCalls) stored = patch.translateCalls;
    });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '译文' } }] }),
    }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const summary = await runTranslatePass({
        getSettings: async () => configured,
        getMeta: async () => ({ translationNoticeAt: NOW, translateCalls: stored }),
        setMeta,
        getSceneText: async (id: string) => `text ${id}`,
        now: () => NOW,
      }, 2);

      expect(summary.requested).toBe(2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(setMeta).toHaveBeenCalledTimes(2);
      expect(stored).toEqual({ date: localDateKey(NOW), count: 2 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('额度门禁（FR-D5）', () => {
  it('今天已用满 → deferred，不跑', async () => {
    const { deps } = assembly({
      settings: configured,
      notice: NOW,
      calls: { date: localDateKey(NOW), count: 2000 },
    });

    const summary = await runTranslatePass(deps);

    expect(summary.disabled).toBe(false);
    expect(summary.deferred).toBeGreaterThan(0);
  });

  it('昨天的计数不影响今天', async () => {
    const { deps } = assembly({
      settings: configured,
      notice: NOW,
      calls: { date: '2000-01-01', count: 99999 },
    });

    const summary = await runTranslatePass(deps);
    expect(summary.deferred).toBe(0);
  });
});
