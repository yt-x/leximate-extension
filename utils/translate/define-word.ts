import type { Meta, Settings } from '../db/types';
import { createLlmEngine } from './engines';
import { translationEnabled, type TranslateEngineImpl } from './chain';

export type WordDefinitionResult = { defZh: string[] } | { error: string };

export interface DefineWordDeps {
  getSettings(): Promise<Settings>;
  getMeta(): Promise<Pick<Meta, 'translationNoticeAt'>>;
  /** 测试注入；生产默认使用真实 OpenAI 兼容引擎。 */
  createEngine?: (
    config: NonNullable<Settings['translation']['llm']>,
  ) => TranslateEngineImpl;
}

/**
 * 用户显式点击后才生成一个未收录词的释义。
 * 配置、告知或调用失败都以可见错误返回，不向内容脚本泄露 key。
 */
export async function defineUnlistedWord(
  word: string,
  deps: DefineWordDeps,
): Promise<WordDefinitionResult> {
  const settings = await deps.getSettings();
  if (settings.translation.engine !== 'llm' || !translationEnabled(settings.translation)) {
    return { error: '请先在设置页配置 LLM，并确认外发告知' };
  }

  const meta = await deps.getMeta();
  if (meta.translationNoticeAt === null) {
    return { error: '请先在设置页配置 LLM，并确认外发告知' };
  }

  const config = settings.translation.llm;
  if (!config) return { error: '请先在设置页配置 LLM，并确认外发告知' };

  try {
    const engine = (deps.createEngine ?? createLlmEngine)(config);
    const result = await engine.translate({
      text: `请为英文单词 "${word}" 给出简洁中文释义。按“词性 释义”分行，只返回释义，不要解释。`,
      targetLang: 'zh-CN',
    });
    const defZh = result.text
      .split(/\\n|\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    return defZh.length > 0 ? { defZh } : { error: 'LLM 未返回可用释义' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
