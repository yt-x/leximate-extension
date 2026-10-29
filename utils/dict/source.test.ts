/**
 * `createMessageSource`：经后台读分片（替代内容脚本直接 fetch）。
 *
 * 背景：内容脚本直接 `fetch(runtime.getURL(...))` 时，请求来源是页面源，
 * 会被严格 CSP 站点拦（实测 YouTube 报 `Unsafe attempt to load URL ...`）。
 */
import { describe, expect, it, vi } from 'vitest';

import { createMessageSource } from './source';

describe('createMessageSource', () => {
  it('readIndex 发 index.json 的消息并返回文本', async () => {
    const send = vi.fn(async (file: string) => `{"file":"${file}"}`);
    const source = createMessageSource(send);

    expect(await source.readIndex()).toBe('{"file":"index.json"}');
    expect(send).toHaveBeenCalledWith('index.json');
  });

  it('readShard 原样转发清单给的文件名', async () => {
    const send = vi.fn(async () => '{}');
    const source = createMessageSource(send);

    await source.readShard('shard-a.json');
    expect(send).toHaveBeenCalledWith('shard-a.json');
  });

  it('后台没返回文本时报错并带上文件名（不能静默返回空串）', async () => {
    const source = createMessageSource(async () => null);
    await expect(source.readIndex()).rejects.toThrow(/index\.json/);
  });

  it('消息失败时错误里保留原始原因（便于诊断后台/上下文问题）', async () => {
    const source = createMessageSource(async () => {
      throw new Error('Extension context invalidated');
    });
    await expect(source.readShard('shard-core.json')).rejects.toThrow(
      /shard-core\.json.*Extension context invalidated/,
    );
  });
});
