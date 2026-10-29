/**
 * 三个引擎的请求形状与失败归类（PLAN.md FR-D3）。
 *
 * 全部用**注入的假 fetch**，因此这些断言不需要网络，也不会因为外部服务变化而红。
 * 断言重点是**发出去的东西**：URL 拼得对不对、Key 有没有带、body 是不是那个形状——
 * 因为"句子会离开浏览器"，这里错了就是隐私或兼容性问题。
 */
import { describe, expect, it, vi } from 'vitest';
import { createApiEngine, createChromeBuiltinEngine, createLlmEngine } from './engines';
import { runChain } from './chain';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('LLM 引擎（OpenAI 兼容）', () => {
  it('拼出 /chat/completions，带上 Bearer Key，body 是 chat 形状', async () => {
    const fetch = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '你好' } }] }));
    const engine = createLlmEngine({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetch,
    });

    const out = await engine.translate({ text: 'hello', targetLang: 'zh-CN' });

    expect(out.text).toBe('你好');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    // 目标语言进 system 指令，用户那句原样进 user
    expect(body.messages[0]!.content).toContain('zh-CN');
    expect(body.messages[1]).toBeDefined();
  });

  it('baseUrl 末尾带斜杠或已写全路径都不重复拼', async () => {
    for (const baseUrl of ['https://x/v1/', 'https://x/v1/chat/completions']) {
      const fetch = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
      await createLlmEngine({ baseUrl, apiKey: '', model: 'm', fetch }).translate({
        text: 'a',
        targetLang: 'zh-CN',
      });
      expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://x/v1/chat/completions');
    }
  });

  it('没有 Key 时不带 authorization 头（本地模型合法）', async () => {
    const fetch = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await createLlmEngine({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen', fetch }).translate(
      { text: 'a', targetLang: 'zh-CN' },
    );
    const headers = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBeUndefined();
  });

  it('HTTP 失败与格式不认识都抛错（交给降级链）', async () => {
    const httpFail = createLlmEngine({
      baseUrl: 'https://x',
      apiKey: '',
      model: 'm',
      fetch: async () => jsonResponse({}, 401),
    });
    await expect(httpFail.translate({ text: 'a', targetLang: 'zh-CN' })).rejects.toThrow('LLM 返回 401');

    const shapeBad = createLlmEngine({
      baseUrl: 'https://x',
      apiKey: '',
      model: 'm',
      fetch: async () => jsonResponse({ nope: true }),
    });
    await expect(shapeBad.translate({ text: 'a', targetLang: 'zh-CN' })).rejects.toThrow('格式不认识');
  });
});

describe('自建接口引擎', () => {
  it('把 headers 原样带上，body 是 {text, target}', async () => {
    const fetch = vi.fn(async () => jsonResponse({ text: '你好' }));
    const engine = createApiEngine({
      url: 'https://t.example.com/translate',
      headers: { 'x-api-key': 'k1' },
      fetch,
    });

    const out = await engine.translate({ text: 'hello', targetLang: 'zh-CN' });

    expect(out.text).toBe('你好');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://t.example.com/translate');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k1');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hello', target: 'zh-CN' });
  });

  it('也认 {translated} 这个字段名', async () => {
    const engine = createApiEngine({
      url: 'https://t',
      headers: {},
      fetch: async () => jsonResponse({ translated: '哟' }),
    });
    expect((await engine.translate({ text: 'hi', targetLang: 'zh-CN' })).text).toBe('哟');
  });

  it('HTTP 失败 / 格式不认识都抛错', async () => {
    await expect(
      createApiEngine({ url: 'https://t', headers: {}, fetch: async () => jsonResponse({}, 500) }).translate({
        text: 'a',
        targetLang: 'zh-CN',
      }),
    ).rejects.toThrow('翻译接口返回 500');

    await expect(
      createApiEngine({ url: 'https://t', headers: {}, fetch: async () => jsonResponse({ x: 1 }) }).translate({
        text: 'a',
        targetLang: 'zh-CN',
      }),
    ).rejects.toThrow('格式不认识');
  });
});

describe('Chrome 内置翻译引擎', () => {
  it('本机没有 Translator → available 为 false（链里直接跳过，不花钱）', async () => {
    const engine = createChromeBuiltinEngine({});
    expect(await engine.available?.()).toBe(false);
  });

  it('只有 availability 为 available 才翻译；downloadable 不触发下载', async () => {
    const translate = vi.fn(async () => '你好');
    const translator = {
      availability: vi.fn(async () => 'downloadable'),
      create: vi.fn(async () => ({ translate })),
    };
    const engine = createChromeBuiltinEngine({ getTranslator: () => translator });

    await expect(engine.translate({ text: 'hello', targetLang: 'zh-CN' })).rejects.toThrow(
      '内置翻译不可用（downloadable）',
    );
    expect(translator.create).not.toHaveBeenCalled();
  });

  it('available 时按 en → 目标语言建会话并翻译', async () => {
    const translator = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({ translate: async (text: string) => `${text} 的译文` })),
    };
    const engine = createChromeBuiltinEngine({ getTranslator: () => translator });

    const out = await engine.translate({ text: 'hello', targetLang: 'zh-CN' });

    expect(out.text).toBe('hello 的译文');
    expect(translator.create).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'zh-CN' });
  });
});

describe('降级链与真实引擎的接缝', () => {
  it('LLM 401 → 自动落到自建接口，结果记 api', async () => {
    const llm = createLlmEngine({
      baseUrl: 'https://x',
      apiKey: 'bad',
      model: 'm',
      fetch: async () => jsonResponse({}, 401),
    });
    const api = createApiEngine({
      url: 'https://t',
      headers: {},
      fetch: async () => jsonResponse({ text: '兜底译文' }),
    });

    const outcome = await runChain([llm, api], { text: 'hello', targetLang: 'zh-CN' });

    expect(outcome.result).toEqual({ text: '兜底译文', engine: 'api', model: '' });
    expect(outcome.attempts[0]?.error).toBe('LLM 返回 401');
  });
});
