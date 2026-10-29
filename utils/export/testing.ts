/**
 * 导出单测的公共夹具。
 *
 * `Scene` 的字段不少，逐个用例写一遍会淹没测试意图；
 * 也让"数据模型加字段"只需改一处。`Word` 的夹具复用管理台那一份
 * （`../manager/testing`），避免两个模块各造一套字段默认值而慢慢分叉。
 */
import type { Scene } from '../db/types';

/** 造一条例句。id 由词与文本推出，保证同一用例里稳定且互不相同 */
export function makeScene(over: Partial<Scene> & { wordId: string; text: string }): Scene {
  const { wordId, text, ...rest } = over;
  return {
    id: `${wordId}#${text}`,
    wordId,
    text,
    highlightFrom: 0,
    highlightTo: text.length,
    translation: null,
    sourceUrl: 'https://example.com/article',
    sourceTitle: 'example',
    domain: 'example.com',
    capturedAt: 1000,
    contentHash: `${wordId}:${text}`,
    ...rest,
  };
}
