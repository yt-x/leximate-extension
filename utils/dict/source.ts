/**
 * 分片取用（PLAN.md §4.5 P3）——**经后台读取版**。
 *
 * ## 为什么不直接 `fetch(runtime.getURL(...))`
 *
 * 内容脚本虽然跑在隔离世界，但它发起 `fetch` 时的**请求来源仍是页面源**，
 * 因此受**页面 CSP / 安全策略**约束。在有严格策略的站点（YouTube、GitHub 等）上
 * Chrome 直接报：
 *
 * ```
 * Unsafe attempt to load URL chrome-extension://<id>/dict/inflections.json
 * from frame with URL https://www.youtube.com/. Domains, protocols and ports must match.
 * ```
 *
 * 实测（2026-10-23）：`web_accessible_resources` 声明**不能**解决这个问题——
 * 它只决定"资源可被谁访问"，不豁免页面自身的 CSP。
 * 表现是整份词库都加载失败，连内置 3004 词都查不到（只剩"未收录"）。
 *
 * ## 现在怎么做
 *
 * **后台读文件，内容脚本经消息取文本**。后台是扩展源，读自己的包不受页面 CSP 限制。
 * 代价是每次读要一次消息往返（分片只在启动与补拉时读，不是热路径）。
 */
import type { DictIndex, DictShard } from './types';

export interface DictSource {
  /** 读 `dict/index.json` */
  readIndex(): Promise<string>;
  /** 读某个分片文件，参数是清单里给的 `file` */
  readShard(file: string): Promise<string>;
}

/** 经后台读扩展资源的消息名（与 `utils/content/messages.ts` 的 `MSG.readDictFile` 对应） */
export const READ_DICT_FILE = 'leximate:read-dict-file';

/**
 * 经后台读扩展包内资源。
 *
 * `send` 由调用方给（内容脚本传 `browser.runtime.sendMessage`），
 * 这样本模块不依赖 `browser`，测试里可直接注入。
 */
export function createMessageSource(
  send: (file: string) => Promise<unknown>,
): DictSource {
  async function read(file: string): Promise<string> {
    let response: unknown;
    try {
      response = await send(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`读取词表分片失败：${file}（消息错误：${message}）`);
    }
    if (typeof response !== 'string') {
      throw new Error(`读取词表分片失败：${file}（后台没有返回文本）`);
    }
    return response;
  }

  return {
    readIndex: () => read('index.json'),
    readShard: (file) => read(file),
  };
}

/**
 * 直接 `fetch` 扩展资源（**保留但不再用于内容脚本**）。
 *
 * 仅适用于**扩展源上下文**（后台、管理台页面）——那里的 `fetch` 不受页面 CSP 限制。
 * 内容脚本请用 `createMessageSource`。
 */
export function createFetchSource(baseUrl: string, fetchImpl: typeof fetch = fetch): DictSource {
  const withSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  async function read(file: string): Promise<string> {
    const response = await fetchImpl(`${withSlash}${file}`);
    if (!response.ok) {
      throw new Error(`读取词表分片失败：${file}（HTTP ${response.status}）`);
    }
    return response.text();
  }

  return {
    readIndex: () => read('index.json'),
    readShard: (file) => read(file),
  };
}

/** 内存源。测试用 */
export function createMemorySource(files: Record<string, string>): DictSource {
  return {
    async readIndex() {
      const text = files['index.json'];
      if (text === undefined) throw new Error('内存源里没有 index.json');
      return text;
    },
    async readShard(file) {
      const text = files[file];
      if (text === undefined) throw new Error(`内存源里没有分片 ${file}`);
      return text;
    },
  };
}

/** 解析并粗校验清单。字段缺失时给出能定位问题的报错，而不是让 undefined 一路传下去 */
export function parseIndex(text: string): DictIndex {
  const raw = JSON.parse(text) as Partial<DictIndex>;
  if (typeof raw.version !== 'string' || !Array.isArray(raw.shards)) {
    throw new Error('词表清单格式不对：缺 version 或 shards');
  }
  return {
    version: raw.version,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    count: typeof raw.count === 'number' ? raw.count : 0,
    shards: raw.shards,
  };
}

export function parseShard(text: string): DictShard {
  const raw = JSON.parse(text) as Partial<DictShard>;
  if (typeof raw.name !== 'string' || typeof raw.words !== 'object' || raw.words === null) {
    throw new Error('词表分片格式不对：缺 name 或 words');
  }
  return { name: raw.name, words: raw.words };
}
