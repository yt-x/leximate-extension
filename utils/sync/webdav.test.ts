/**
 * WebDAV 客户端的请求形状（PLAN.md FR-H1 / FR-H7）。
 *
 * 断言重点是"发出去的东西"：方法、URL 拼接、认证头。凭据错在真机上表现为 401，
 * 而那是最难从界面反推的一类问题。
 */
import { describe, expect, it, vi } from 'vitest';
import { createWebdavClient, joinUrl } from './webdav';

const config = {
  url: 'https://dav.example.com/dav/',
  username: 'me@example.com',
  password: 'app-pass',
  path: '/leximate/sync.json',
};

function response(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe('joinUrl', () => {
  it('末尾斜杠与缺前导斜杠都容忍', () => {
    expect(joinUrl({ url: 'https://d/x/', path: '/a/b.json' })).toBe('https://d/x/a/b.json');
    expect(joinUrl({ url: 'https://d/x', path: 'a/b.json' })).toBe('https://d/x/a/b.json');
  });

  it('path 为空就是 base（不会多一个斜杠）', () => {
    expect(joinUrl({ url: 'https://d/x/', path: '/' })).toBe('https://d/x');
  });
});

describe('读', () => {
  it('GET 带 Basic 认证', async () => {
    const fetch = vi.fn(async () => response(200, '{"ok":1}'));
    const client = createWebdavClient(config, { fetch });

    expect(await client.read()).toBe('{"ok":1}');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://dav.example.com/dav/leximate/sync.json');
    expect(init.method).toBe('GET');
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth?.startsWith('Basic ')).toBe(true);
    // 凭据确实被编码进认证头（解回来应是 user:pass）
    expect(atob(auth!.slice('Basic '.length))).toBe('me@example.com:app-pass');
  });

  it('404 → null（远端还没有文件，是正常状态不是错误）', async () => {
    const client = createWebdavClient(config, { fetch: async () => response(404) });
    expect(await client.read()).toBeNull();
  });

  it('其它错误码抛出（401 会在这里冒出来）', async () => {
    const client = createWebdavClient(config, { fetch: async () => response(401) });
    await expect(client.read()).rejects.toThrow('HTTP 401');
  });
});

describe('写', () => {
  it('PUT 带 content-type 与认证', async () => {
    const fetch = vi.fn(async () => response(201));
    const client = createWebdavClient(config, { fetch });

    await client.write('{"a":1}');

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://dav.example.com/dav/leximate/sync.json');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('{"a":1}');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization?.startsWith('Basic ')).toBe(true);
  });

  it('409（目录不存在）→ 建目录后重试一次', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (init?.method === 'PUT' && calls.filter((c) => c.startsWith('PUT')).length === 1) {
        return response(409);
      }
      return response(201);
    }) as never;

    await createWebdavClient(config, { fetch }).write('x');

    expect(calls).toEqual([
      'PUT https://dav.example.com/dav/leximate/sync.json',
      'MKCOL https://dav.example.com/dav/leximate',
      'PUT https://dav.example.com/dav/leximate/sync.json',
    ]);
  });

  it('重试后仍失败就抛出（不无限重试）', async () => {
    const fetch = vi.fn(async () => response(409)) as never;
    await expect(createWebdavClient(config, { fetch }).write('x')).rejects.toThrow('同步写入失败');
  });

  it('中文用户名不会因为 btoa 抛错（按 UTF-8 编码）', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(() => atob(auth!.slice('Basic '.length))).not.toThrow();
      return response(201);
    }) as never;

    await expect(
      createWebdavClient({ ...config, username: '张三', password: '密码' }, { fetch }).write('x'),
    ).resolves.toBeUndefined();
  });
});
