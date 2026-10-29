/**
 * WebDAV 客户端（PLAN.md FR-H1 / FR-H7）。
 *
 * 只做同步真正需要的最小动作：**确保目录、读文件、写文件**。
 * 不实现 PROPFIND 列目录（同步只有"一个固定路径"），也不做分片——
 * 少一个动作就少一处与各家服务端（坚果云 / Nextcloud / 自建）行为差异的纠缠。
 *
 * 认证用 Basic（用户名 + 应用密码），凭据只从注入的配置来，**不落日志、不进载荷**。
 */
import type { FetchLike } from '../translate/engines';

export interface WebdavConfig {
  url: string;
  username: string;
  password: string;
  /** 远端路径，如 `/leximate/sync.json` */
  path: string;
}

export interface WebdavDeps {
  fetch?: FetchLike;
  /** Basic 认证头的构造（用例断言用；默认 btoa） */
  basicAuth?: (username: string, password: string) => string;
}

function defaultBasicAuth(username: string, password: string): string {
  // btoa 只吃 latin1：先按 UTF-8 转一遍，否则中文用户名会抛错
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** 拼完整 URL：容忍 baseUrl 末尾斜杠、也容忍 path 没写前导斜杠 */
export function joinUrl(config: Pick<WebdavConfig, 'url' | 'path'>): string {
  const base = config.url.trim().replace(/\/+$/, '');
  const path = config.path.trim().replace(/^\/+/, '');
  return path === '' ? base : `${base}/${path}`;
}

function headersFor(config: WebdavConfig, deps: WebdavDeps): Record<string, string> {
  const make = deps.basicAuth ?? defaultBasicAuth;
  return { authorization: make(config.username, config.password) };
}

export interface WebdavClient {
  /** 读远端；不存在（404）返回 null，其它错误抛出 */
  read(): Promise<string | null>;
  /** 写远端；父目录不存在时先建（最多建一层） */
  write(body: string): Promise<void>;
}

export function createWebdavClient(config: WebdavConfig, deps: WebdavDeps = {}): WebdavClient {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const target = joinUrl(config);
  const parent = target.slice(0, target.lastIndexOf('/'));

  return {
    async read() {
      const response = await doFetch(target, { method: 'GET', headers: headersFor(config, deps) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`同步读取失败：HTTP ${response.status}`);
      return response.text();
    },

    async write(body: string) {
      const headers = { ...headersFor(config, deps), 'content-type': 'application/json' };
      let response = await doFetch(target, { method: 'PUT', headers, body });

      // 409 = 父目录不存在。各家服务端对"PUT 到不存在的目录"就是这个码
      if (response.status === 409 && parent.includes('/')) {
        await doFetch(parent, { method: 'MKCOL', headers: headersFor(config, deps) });
        response = await doFetch(target, { method: 'PUT', headers, body });
      }

      if (!response.ok) throw new Error(`同步写入失败：HTTP ${response.status}`);
    },
  };
}
