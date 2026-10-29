/**
 * 入库后入队的三个前提（PLAN.md FR-D1 / FR-D6 / FR-D7）。
 *
 * 每条前提都要能单独驱动：漏掉任何一条的结果都是"用户没同意就把句子送出去"或
 * "白跑一次数据库"。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../db/types';
import { enqueueSceneForTranslation } from './enqueue';

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

function deps(options: { settings: Settings; notice: number | null }) {
  const enqueue = vi.fn(async (_input: unknown) => ({}) as never);
  return {
    enqueue,
    deps: {
      getSettings: async () => options.settings,
      getMeta: async () => ({ translationNoticeAt: options.notice }) as never,
      enqueue: enqueue as never,
    },
  };
}

const input = { wordId: 'w1', sceneId: 's1', sceneText: 'hello there', targetLang: 'zh-CN' };

describe('入库后入队', () => {
  it('配置完整 + 已告知 → 入队一条', async () => {
    const { deps: d, enqueue } = deps({ settings: configured, notice: 1 });

    const outcome = await enqueueSceneForTranslation(input, d);

    expect(outcome).toEqual({ enqueued: true, skipped: '' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      wordId: 'w1',
      sceneId: 's1',
      targetLang: 'zh-CN',
    });
  });

  it('没配置翻译 → 不入队，也不碰 meta', async () => {
    const getMeta = vi.fn(async () => ({ translationNoticeAt: 1 }) as never);
    const enqueue = vi.fn(async (_input: unknown) => ({}) as never);

    const outcome = await enqueueSceneForTranslation(input, {
      getSettings: async () => unconfigured,
      getMeta: getMeta as never,
      enqueue: enqueue as never,
    } as never);

    expect(outcome).toEqual({ enqueued: false, skipped: 'disabled' });
    expect(getMeta).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('配置完整但用户没确认告知 → 不入队（这条是隐私约束）', async () => {
    const { deps: d, enqueue } = deps({ settings: configured, notice: null });

    const outcome = await enqueueSceneForTranslation(input, d);

    expect(outcome).toEqual({ enqueued: false, skipped: 'no-notice' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('这次入库没带例句 → 不入队', async () => {
    const { deps: d, enqueue } = deps({ settings: configured, notice: 1 });

    expect(await enqueueSceneForTranslation({ ...input, sceneText: '   ' }, d)).toEqual({
      enqueued: false,
      skipped: 'no-scene',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sceneId 缺省时退回 wordId（不产生 undefined 键）', async () => {
    const { deps: d, enqueue } = deps({ settings: configured, notice: 1 });

    await enqueueSceneForTranslation({ wordId: 'w9', sceneText: 'x', targetLang: 'zh-CN' }, d);

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ sceneId: 'w9' });
  });
});
