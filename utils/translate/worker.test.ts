/**
 * 翻译 worker 的行为（PLAN.md FR-D1 / FR-D4 / FR-D5 / FR-D6 / FR-D7）。
 *
 * 用假依赖驱动，断言的是"发了几次、有没有花钱、队列怎么变"——
 * 这些正是隐私与成本两条约束的落点，必须能被单测钉死。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbHandle, STORE, readTx, req, writeTx } from '../db/schema';
import { enqueueTranslation, getCachedTranslation, queueStats } from '../db/translations';
import type { QueueItem, Settings } from '../db/types';
import { MAX_ATTEMPTS, runOnce } from './worker';
import type { TranslateEngineImpl } from './chain';

const BASE_SETTINGS = {
  translation: {
    engine: 'llm' as const,
    targetLang: 'zh-CN',
    llm: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
    api: null,
  },
} as unknown as Settings;

const DISABLED_SETTINGS = {
  translation: { engine: 'llm' as const, targetLang: 'zh-CN', llm: null, api: null },
} as unknown as Settings;

async function seed(scenes: Record<string, string>): Promise<Record<string, QueueItem>> {
  const out: Record<string, QueueItem> = {};
  for (const [sceneId, text] of Object.entries(scenes)) {
    out[sceneId] = await enqueueTranslation({
      wordId: 'w1',
      sceneId,
      textHash: `h-${sceneId}`,
      targetLang: 'zh-CN',
    });
  }
  return out;
}

function engines(translate: TranslateEngineImpl['translate']): {
  llm: TranslateEngineImpl;
  calls: () => number;
} {
  const spy = vi.fn(translate);
  return { llm: { engine: 'llm', translate: spy }, calls: () => spy.mock.calls.length };
}

function deps(overrides: Partial<Parameters<typeof runOnce>[0]> = {}) {
  const texts: Record<string, string> = { s1: 'hello one', s2: 'hello two' };
  let used = 0;
  return {
    getSettings: async () => BASE_SETTINGS,
    getSceneText: async (id: string) => texts[id],
    engines: {},
    todayUsed: async () => used,
    noteCall: async (n: number) => {
      used += n;
    },
    log: vi.fn(),
    ...overrides,
    // 暴露给用例读的计数器
    __used: () => used,
  };
}

beforeEach(async () => {
  resetDbHandle();
  for (const store of [STORE.translations, STORE.queue] as const) {
    await writeTx(store, (tx) => req(tx.objectStore(store).clear()));
  }
});

describe('FR-D7：没开启就一条请求都不发', () => {
  it('配置不完整 → disabled，队列原样留着，引擎一次没调', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => ({ text: '译文' }));

    const summary = await runOnce(deps({ getSettings: async () => DISABLED_SETTINGS, engines: { llm: e.llm } }));

    expect(summary.disabled).toBe(true);
    expect(e.calls()).toBe(0);
    expect((await queueStats(MAX_ATTEMPTS)).waiting).toBe(1);
  });
});

describe('FR-D4：非空模型名的缓存', () => {
  it('同一 model 的第二轮查询命中缓存，不重复请求', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => ({ text: '译文', model: 'm' }));
    const d = deps({ engines: { llm: e.llm } });

    const first = await runOnce(d);
    expect(first.translated).toBe(1);
    await seed({ s1: 'hello one' });
    const second = await runOnce(d);

    expect(second.cached).toBe(1);
    expect(e.calls()).toBe(1);
  });
});

describe('FR-D5：每日上限到了就排队，不丢也不花', () => {
  it('todayUsed == dailyLimit → deferred，引擎没调', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => ({ text: '译文' }));

    const summary = await runOnce(
      deps({
        engines: { llm: e.llm },
        todayUsed: async () => 5,
        limits: { dailyLimit: 5 },
      }),
    );

    expect(summary.deferred).toBeGreaterThan(0);
    expect(e.calls()).toBe(0);
    expect((await queueStats(MAX_ATTEMPTS)).waiting).toBe(1);
  });

  it('额度只剩 1 条：只花 1 次，剩下的留在队列', async () => {
    await seed({ s1: 'hello one', s2: 'hello two' });
    const e = engines(async (input) => ({ text: `译文:${input.text}` }));

    const summary = await runOnce(
      deps({ engines: { llm: e.llm }, todayUsed: async () => 4, limits: { dailyLimit: 5 } }),
    );

    expect(summary.requested).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(e.calls()).toBe(1);
    expect((await queueStats(MAX_ATTEMPTS)).waiting).toBe(1);
  });

  it('LLM 失败后降级成功：按两次真实引擎请求计额度', async () => {
    await seed({ s1: 'hello one' });
    const llm = { engine: 'llm' as const, translate: vi.fn(async () => { throw new Error('LLM 挂了'); }) };
    const api = { engine: 'api' as const, translate: vi.fn(async () => ({ text: '兜底译文' })) };
    const d = deps({ engines: { llm, api }, limits: { dailyLimit: 5 } });

    const summary = await runOnce(d);

    expect(llm.translate).toHaveBeenCalledTimes(1);
    expect(api.translate).toHaveBeenCalledTimes(1);
    expect(summary.requested).toBe(2);
    expect(summary.translated).toBe(1);
    expect(d.__used()).toBe(2);
  });

  it('额度只够首次请求：停止降级，不突破 dailyLimit，队列留待重试', async () => {
    await seed({ s1: 'hello one' });
    const llm = { engine: 'llm' as const, translate: vi.fn(async () => { throw new Error('LLM 挂了'); }) };
    const api = { engine: 'api' as const, translate: vi.fn(async () => ({ text: '不该请求' })) };
    const d = deps({ engines: { llm, api }, limits: { dailyLimit: 1 } });

    const summary = await runOnce(d);

    expect(llm.translate).toHaveBeenCalledTimes(1);
    expect(api.translate).not.toHaveBeenCalled();
    expect(summary.requested).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(summary.failed).toBe(0);
    expect(d.__used()).toBe(1);
    const rows = await readTx(STORE.queue, (tx) => req<QueueItem[]>(tx.objectStore(STORE.queue).getAll()));
    expect(rows[0]?.state).toBe('pending');
    expect(rows[0]?.attempts).toBe(0);
  });
});

describe('FR-D5：concurrency 真实控制并发', () => {
  it('concurrency=2 时两条同时执行，峰值不超过 2', async () => {
    await seed({ s1: 'one', s2: 'two', s3: 'three', s4: 'four' });
    let active = 0;
    let maxActive = 0;
    const translate = vi.fn(async (input: { text: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { text: `译文:${input.text}` };
    });

    const summary = await runOnce(deps({
      getSceneText: async (id: string) => `text ${id}`,
      engines: { llm: { engine: 'llm', translate } },
      limits: { concurrency: 2, dailyLimit: 10, batchSize: 20 },
    }), 4);

    expect(translate).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(2);
    expect(summary.translated).toBe(4);
  });

  it('并发任务共享 dailyLimit：不超额、不重复扣费，余项留队列', async () => {
    await seed({ s1: 'one', s2: 'two', s3: 'three', s4: 'four' });
    let active = 0;
    let maxActive = 0;
    let noted = 0;
    const translate = vi.fn(async (input: { text: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { text: `译文:${input.text}` };
    });

    const summary = await runOnce(deps({
      getSceneText: async (id: string) => `text ${id}`,
      engines: { llm: { engine: 'llm', translate } },
      todayUsed: async () => 0,
      noteCall: async (count: number) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        noted += count;
      },
      limits: { concurrency: 4, dailyLimit: 2, batchSize: 20 },
    }), 4);

    expect(maxActive).toBeGreaterThan(1);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(summary.requested).toBe(2);
    expect(summary.translated).toBe(2);
    expect(summary.deferred).toBe(2);
    expect(noted).toBe(2);
    expect((await queueStats(MAX_ATTEMPTS)).waiting).toBe(2);
  });
});

describe('FR-D4：重复句子零请求', () => {
  it('同一句第二次跑直接命中缓存并出队', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => ({ text: '你好' }));

    await runOnce(deps({ engines: { llm: e.llm } }));
    expect(e.calls()).toBe(1);

    // 同一句再入队（例如另一处划到同样的句子）
    await enqueueTranslation({ wordId: 'w2', sceneId: 's1b', textHash: 'h-other', targetLang: 'zh-CN' });
    const texts = { s1b: 'hello one' };
    const summary = await runOnce(
      deps({ engines: { llm: e.llm }, getSceneText: async (id: string) => texts[id as 's1b'] }),
    );

    expect(summary.cached).toBe(1);
    expect(summary.requested).toBe(0);
    expect(e.calls()).toBe(1); // 没有第二发
  });

  it('同批相同句子并发时只请求一次，另一项复用结果出队', async () => {
    await seed({ s1: 'hello one' });
    await enqueueTranslation({ wordId: 'w2', sceneId: 's2', textHash: 'h2', targetLang: 'zh-CN' });
    const translate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { text: '你好' };
    });

    const summary = await runOnce(deps({
      getSceneText: async () => 'hello one',
      engines: { llm: { engine: 'llm', translate } },
      limits: { concurrency: 2, dailyLimit: 10 },
    }), 2);

    expect(translate).toHaveBeenCalledTimes(1);
    expect(summary.requested).toBe(1);
    expect(summary.translated).toBe(1);
    expect(summary.cached).toBe(1);
    expect((await queueStats(MAX_ATTEMPTS)).waiting).toBe(0);
  });

  it('译文按 (文本, 语言, 引擎, 模型) 落库', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => ({ text: '你好', model: 'm' }));
    await runOnce(deps({ engines: { llm: e.llm } }));

    expect(
      await getCachedTranslation({ text: 'hello one', targetLang: 'zh-CN', engine: 'llm', model: 'm' }),
    ).toBe('你好');
  });
});

describe('FR-D6：失败可重试，到顶停下', () => {
  it('失败后留在队列，attempts 递增', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => {
      throw new Error('网络挂了');
    });

    const summary = await runOnce(deps({ engines: { llm: e.llm } }));

    expect(summary.failed).toBe(1);
    const rows = await readTx(STORE.queue, (tx) => req<QueueItem[]>(tx.objectStore(STORE.queue).getAll()));
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lastError).toContain('网络挂了');
  });

  it(`连续失败 ${MAX_ATTEMPTS} 次后不再自动重试（停下而不是无限烧钱）`, async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => {
      throw new Error('一直挂');
    });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await runOnce(deps({ engines: { llm: e.llm } }));
    }
    expect(e.calls()).toBe(MAX_ATTEMPTS);

    // 再到顶之后跑一轮：不该再发
    await runOnce(deps({ engines: { llm: e.llm } }));
    expect(e.calls()).toBe(MAX_ATTEMPTS);
    expect((await queueStats(MAX_ATTEMPTS)).exhausted).toBe(1);
  });
});

describe('对象消失时出队而不是失败', () => {
  it('scene 已被删除 → 出队，不计失败、不花钱', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => ({ text: 'x' }));

    const summary = await runOnce(deps({ engines: { llm: e.llm }, getSceneText: async () => undefined }));

    expect(summary.failed).toBe(0);
    expect(e.calls()).toBe(0);
    expect((await queueStats(MAX_ATTEMPTS)).waiting).toBe(0);
  });
});

describe('降级之后仍能用上缓存', () => {
  it('LLM 失败、api 成功 → 下一轮同句命中 api 的缓存，不再花钱', async () => {
    await seed({ s1: 'hello one' });
    const llm = { engine: 'llm' as const, translate: async () => { throw new Error('挂了'); } };
    const apiSpy = vi.fn(async () => ({ text: '兜底译文' }));
    const api = { engine: 'api' as const, translate: apiSpy };

    await runOnce(deps({ engines: { llm, api } }));
    expect(apiSpy).toHaveBeenCalledTimes(1);

    // 再来一句同样的文本
    await enqueueTranslation({ wordId: 'w2', sceneId: 's1b', textHash: 'h2', targetLang: 'zh-CN' });
    const summary = await runOnce(
      deps({
        engines: { llm, api },
        getSceneText: async (id: string) => (id === 's1b' ? 'hello one' : 'hello one'),
      }),
    );

    expect(summary.cached).toBe(1);
    expect(apiSpy).toHaveBeenCalledTimes(1);
  });
});

describe('FR-D7：告知未确认 → 一条请求都不发', () => {
  it('配置完整但没确认过告知，同样是 disabled，引擎零调用', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => ({ text: '译文' }));

    const summary = await runOnce(
      deps({ engines: { llm: e.llm }, noticeAcknowledged: async () => false }),
    );

    expect(summary.disabled).toBe(true);
    expect(e.calls()).toBe(0);
    expect((await queueStats(MAX_ATTEMPTS)).waiting).toBe(1);
  });

  it('确认过告知之后才真的发请求', async () => {
    await seed({ s1: 'hello one' });
    const e = engines(async () => ({ text: '译文' }));

    const summary = await runOnce(
      deps({ engines: { llm: e.llm }, noticeAcknowledged: async () => true }),
    );

    expect(summary.disabled).toBe(false);
    expect(summary.translated).toBe(1);
    expect(e.calls()).toBe(1);
  });
});
