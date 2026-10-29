/**
 * 降级链与成本控制（PLAN.md FR-D3 / FR-D5 / FR-D7）。
 *
 * 这一层的价值在于把两条不变量变成可断言的：
 *  - **默认不联网**：配置不完整时 `translationEnabled` 为 false，链根本不会跑；
 *  - **降级可追溯**：结果里记的是**实际成功**的那一级，不是配置里写的那一级。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIMITS,
  buildChain,
  canSpend,
  clampLimits,
  planBatches,
  runChain,
  translationEnabled,
  type TranslateEngineImpl,
} from './chain';

function engine(
  name: 'llm' | 'chrome-builtin' | 'api',
  behaviour: 'ok' | 'fail' | 'empty' | 'off',
  text = '译文',
): TranslateEngineImpl {
  return {
    engine: name,
    available: behaviour === 'off' ? () => false : undefined,
    async translate() {
      if (behaviour === 'fail') throw new Error(`${name} 挂了`);
      if (behaviour === 'empty') return { text: '   ' };
      return { text, model: name === 'llm' ? 'gpt-test' : undefined };
    },
  };
}

describe('FR-D7：默认不联网', () => {
  it('没有翻译配置 → 未启用', () => {
    expect(translationEnabled(null)).toBe(false);
  });

  it('LLM 缺 baseUrl 或 model → 未启用（不发请求）', () => {
    expect(translationEnabled({ engine: 'llm', llm: null, api: null })).toBe(false);
    expect(translationEnabled({ engine: 'llm', llm: { baseUrl: '', model: 'm' }, api: null })).toBe(false);
    expect(translationEnabled({ engine: 'llm', llm: { baseUrl: 'https://x', model: ' ' }, api: null })).toBe(
      false,
    );
  });

  it('LLM 配好 baseUrl + model → 启用（本地模型没有 Key 也是合法的）', () => {
    expect(translationEnabled({ engine: 'llm', llm: { baseUrl: 'https://x/v1', model: 'm' }, api: null })).toBe(
      true,
    );
  });

  it('自建接口必须有 url；Chrome 内置不需要凭据', () => {
    expect(translationEnabled({ engine: 'api', llm: null, api: null })).toBe(false);
    expect(translationEnabled({ engine: 'api', llm: null, api: { url: 'https://t' } })).toBe(true);
    expect(translationEnabled({ engine: 'chrome-builtin', llm: null, api: null })).toBe(true);
  });
});

describe('FR-D3：三级降级链', () => {
  it('一级失败 → 二级成功，结果记的是二级', async () => {
    const outcome = await runChain([engine('llm', 'fail'), engine('chrome-builtin', 'ok', '设备端译文')], {
      text: 'hello',
      targetLang: 'zh-CN',
    });

    expect(outcome.result?.text).toBe('设备端译文');
    expect(outcome.result?.engine).toBe('chrome-builtin');
    expect(outcome.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it('三级都失败时 result 为 null，且每一级的错误都留下来', async () => {
    const outcome = await runChain(
      [engine('llm', 'fail'), engine('api', 'fail')],
      { text: 'hello', targetLang: 'zh-CN' },
    );

    expect(outcome.result).toBeNull();
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts.every((a) => a.error)).toBe(true);
  });

  it('不可用的引擎直接跳过，不算"失败但花钱"', async () => {
    const spy = vi.fn();
    const off: TranslateEngineImpl = {
      engine: 'chrome-builtin',
      available: () => false,
      translate: spy,
    };
    const outcome = await runChain([off, engine('api', 'ok', 'api 译文')], {
      text: 'hello',
      targetLang: 'zh-CN',
    });

    expect(spy).not.toHaveBeenCalled();
    expect(outcome.result?.engine).toBe('api');
    expect(outcome.attempts[0]?.error).toBe('不可用');
  });

  it('空结果当失败，不写进缓存（否则这句永远翻不出来）', async () => {
    const outcome = await runChain([engine('llm', 'empty'), engine('api', 'ok', '兜底')], {
      text: 'hello',
      targetLang: 'zh-CN',
    });

    expect(outcome.result?.engine).toBe('api');
    expect(outcome.attempts[0]?.error).toBe('返回空结果');
  });

  it('模型名跟结果一起返回（缓存键要用）', async () => {
    const outcome = await runChain([engine('llm', 'ok')], { text: 'hi', targetLang: 'zh-CN' });
    expect(outcome.result?.model).toBe('gpt-test');
  });
});

describe('buildChain：配置指定的引擎打头', () => {
  const impls = {
    llm: engine('llm', 'ok'),
    'chrome-builtin': engine('chrome-builtin', 'ok'),
    api: engine('api', 'ok'),
  };

  it('默认（llm 优先）就是规格写的次序', () => {
    expect(buildChain('llm', impls).map((e) => e.engine)).toEqual(['llm', 'chrome-builtin', 'api']);
  });

  it('选 chrome-builtin → 它打头，其余按序补齐', () => {
    expect(buildChain('chrome-builtin', impls).map((e) => e.engine)).toEqual([
      'chrome-builtin',
      'llm',
      'api',
    ]);
  });

  it('只装配存在的引擎（缺的那级不会变成空转）', () => {
    expect(buildChain('llm', { api: impls.api }).map((e) => e.engine)).toEqual(['api']);
  });
});

describe('FR-D5：成本控制', () => {
  it('达到每日上限就不再花钱，但队列项不丢（调用方留在 pending）', () => {
    expect(canSpend(9, { ...DEFAULT_LIMITS, dailyLimit: 10 })).toBe(true);
    expect(canSpend(10, { ...DEFAULT_LIMITS, dailyLimit: 10 })).toBe(false);
    expect(canSpend(99, { ...DEFAULT_LIMITS, dailyLimit: 10 })).toBe(false);
  });

  it('按单批上限切批', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const batches = planBatches(items, { ...DEFAULT_LIMITS, batchSize: 20 });
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
    // 不重不漏
    expect(batches.flat()).toEqual(items);
  });

  it('非法配置钳到合法范围（设置可能被手改）', () => {
    expect(clampLimits({ batchSize: 0, concurrency: 999, dailyLimit: -5 })).toEqual({
      batchSize: 1,
      concurrency: 8,
      dailyLimit: 0,
    });
    expect(clampLimits({ batchSize: Number.NaN })).toEqual(DEFAULT_LIMITS);
    expect(clampLimits(null)).toEqual(DEFAULT_LIMITS);
  });
});
