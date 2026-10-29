import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../db/defaults';
import { defineUnlistedWord } from './define-word';

function deps(over: Partial<Parameters<typeof defineUnlistedWord>[1]> = {}) {
  return {
    getSettings: async () => ({
      ...DEFAULT_SETTINGS,
      translation: {
        ...DEFAULT_SETTINGS.translation,
        engine: 'llm' as const,
        llm: { baseUrl: 'https://llm.test/v1', apiKey: 'sk-test', model: 'm' },
      },
    }),
    getMeta: async () => ({ translationNoticeAt: 1 }),
    createEngine: () => ({ engine: 'llm' as const, translate: vi.fn(async () => ({ text: 'n. 测试；示例' })) }),
    ...over,
  };
}

describe('FR-B4：未收录词的 LLM 释义', () => {
  it('配置不完整时不发请求，并给出去设置的可见原因', async () => {
    const createEngine = vi.fn();
    const result = await defineUnlistedWord('learni', deps({
      getSettings: async () => DEFAULT_SETTINGS,
      createEngine,
    }));
    expect(result).toHaveProperty('error');
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('用户未确认外发告知时不发请求', async () => {
    const createEngine = vi.fn();
    const result = await defineUnlistedWord('learni', deps({
      getMeta: async () => ({ translationNoticeAt: null }), createEngine,
    }));
    expect(result).toHaveProperty('error');
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('配置与告知齐备时才调用引擎，并返回可渲染的释义行', async () => {
    const translate = vi.fn(async (_input: { text: string; targetLang: string }) => ({
      text: 'n. 测试；示例\nv. 举例说明',
    }));
    const result = await defineUnlistedWord('learni', deps({
      createEngine: () => ({ engine: 'llm' as const, translate }),
    }));
    expect(result).toEqual({ defZh: ['n. 测试；示例', 'v. 举例说明'] });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0]?.[0]).toMatchObject({ targetLang: 'zh-CN' });
    expect(translate.mock.calls[0]?.[0].text).toContain('learni');
  });

  it('引擎失败不抛出到内容脚本，返回可见错误', async () => {
    const result = await defineUnlistedWord('learni', deps({
      createEngine: () => ({ engine: 'llm' as const, translate: vi.fn(async () => { throw new Error('HTTP 401'); }) }),
    }));
    expect(result).toEqual({ error: 'HTTP 401' });
  });
});
