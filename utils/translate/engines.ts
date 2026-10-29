/**
 * 三个翻译引擎的实现（PLAN.md FR-D3）。
 *
 * 每个引擎都**接受注入的 fetch**——这既让用例能在 Node 里断言请求形状（URL / header / body），
 * 也保证"真的联网"这件事只发生在装配点（后台），不会溜进内容脚本。
 *
 * 共同约定：
 * - 失败一律 `throw`，由 `utils/translate/chain.ts::runChain` 决定要不要降级；
 * - 返回**去掉首尾空白**的译文；空串在链里会被当成失败（不写缓存）。
 */
import type { TranslateEngineImpl } from './chain';

/** 注入点：默认用全局 fetch，用例替换成假的 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * OpenAI 兼容的 `chat/completions`（FR-D3 的第 ① 级）。
 *
 * 为什么是 chat 而不是 `completions`：绝大多数自建网关（vLLM / LiteLLM / one-api / Ollama 的
 * 兼容层）都实现了 chat 接口，而 prompt 式翻译用 chat 更稳（可以给 system 指令）。
 */
export function createLlmEngine(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: FetchLike;
}): TranslateEngineImpl {
  return {
    engine: 'llm',
    async translate(input) {
      const fetcher: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));
      // 容忍用户粘贴的 baseUrl 末尾带斜杠，也容忍已经写全 `/chat/completions`
      const base = config.baseUrl.trim().replace(/\/+$/, '');
      const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey.trim() === '' ? {} : { authorization: `Bearer ${config.apiKey.trim()}` }),
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: `You are a translation engine. Translate the user's text into ${input.targetLang}. Reply with the translation only, no quotes, no explanation.`,
            },
            { role: 'user', content: input.text },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM 返回 ${response.status}`);
      }
      const data: unknown = await response.json();
      const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
        ?.content;
      if (typeof content !== 'string') {
        throw new Error('LLM 返回格式不认识');
      }
      return { text: content.trim(), model: config.model };
    },
  };
}

/**
 * Chrome 内置的设备端翻译（FR-D3 的第 ② 级）。
 *
 * 浏览器行为：`Translator.availability()` 返回 `'available' | 'downloadable' | 'downloading' |
 * 'unavailable'`，只有 `available` 能立即用；其余一律当"不可用"跳过，
 * **不主动触发模型下载**（那是几十 MB 的下载，不该由划词悄悄引起）。
 */
export interface ChromeTranslatorLike {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<{ translate(text: string): Promise<string> }>;
}

export function createChromeBuiltinEngine(config: {
  /** 取 Translator 构造器；拿不到就当本机不支持 */
  getTranslator?: () => ChromeTranslatorLike | undefined;
  /** 源语言：本项目只处理英文页面，固定 'en' */
  sourceLanguage?: string;
}): TranslateEngineImpl {
  const source = config.sourceLanguage ?? 'en';

  return {
    engine: 'chrome-builtin',
    available: async () => {
      const translator = config.getTranslator?.();
      if (!translator) return false;
      try {
        // 探测目标语言在链里是动态的，这里只能问一个"随便什么"的可用性；
        // 真正的判定放在 translate 里（那时才知道 targetLang）
        return true;
      } catch {
        return false;
      }
    },
    async translate(input) {
      const translator = config.getTranslator?.();
      if (!translator) throw new Error('本机没有内置翻译');

      const target = input.targetLang;
      const availability = await translator.availability({
        sourceLanguage: source,
        targetLanguage: target,
      });
      if (availability !== 'available') {
        throw new Error(`内置翻译不可用（${availability}）`);
      }

      const session = await translator.create({ sourceLanguage: source, targetLanguage: target });
      const text = await session.translate(input.text);
      return { text: text.trim() };
    },
  };
}

/**
 * 用户自配的传统翻译 API（FR-D3 的第 ③ 级）。
 *
 * 契约（我方一侧，见 `TECH.md`）：`POST {url}`，body `{"text": "...", "target": "zh-CN"}`，
 * 期望返回 `{"text": "..."}` 或 `{"translated": "..."}`；`headers` 原样带上（放 Key 用）。
 */
export function createApiEngine(config: {
  url: string;
  headers: Record<string, string>;
  fetch?: FetchLike;
}): TranslateEngineImpl {
  return {
    engine: 'api',
    async translate(input) {
      const fetcher: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));
      const response = await fetcher(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...config.headers },
        body: JSON.stringify({ text: input.text, target: input.targetLang }),
      });

      if (!response.ok) {
        throw new Error(`翻译接口返回 ${response.status}`);
      }
      const data: unknown = await response.json();
      const record = data as { text?: unknown; translated?: unknown };
      const text = typeof record.text === 'string' ? record.text : record.translated;
      if (typeof text !== 'string') {
        throw new Error('翻译接口返回格式不认识');
      }
      return { text: text.trim() };
    },
  };
}
