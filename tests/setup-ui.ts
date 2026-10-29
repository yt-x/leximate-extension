/**
 * UI（jsdom）测试的公共准备。
 *
 * 与 `tests/setup.ts` 的 node 版区别：
 * - 同样要 fake-indexeddb（管理台真的会读库）
 * - 额外要 `ResizeObserver` 的桩：jsdom 不实现它，
 *   而 `WordList` 用它监听视口高度变化，不桩会直接抛错
 * - 还要 `window.matchMedia`（主题跟随系统用得到）
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetDbHandle } from '../utils/db/schema';

/**
 * jsdom 没有 `ResizeObserver`。
 *
 * 桩成"注册后不触发"是刻意的：组件初始渲染时会主动读一次
 * `clientHeight`，因此不触发回调也能拿到视口高度。
 * 若要测"窗口缩放后重新切片"，需在用例里手动取出回调再调用。
 */
class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

/**
 * `browser` 全局的最小桩。
 *
 * jsdom 里没有扩展 API，而 `App` 要读 manifest 版本号、也要订阅后台广播。
 *
 * ⚠️ `runtime.id` **必须给**：`wxt/browser` 的实际实现是
 * `globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome`
 * （`node_modules/@wxt-dev/browser/src/index.mjs`），
 * 少了它就会回退到 `chrome`（jsdom 里是 undefined），
 * 报错是 `Cannot read properties of undefined (reading 'runtime')`——
 * 看起来像 stub 没生效，实际是判定条件没满足。
 *
 * **只桩界面真正用到的那一小块**：桩得越少，测试越接近真实调用面。
 * `onMessage` 例外——它必须**真的记住监听者**，否则"后台广播 → 页面重读库"
 * 这条链路就没法在 jsdom 里验；`__leximateEmitRuntimeMessage` 是给用例用的
 * 派发口。
 */
type RuntimeListener = (message: unknown) => unknown;

const runtimeListeners = new Set<RuntimeListener>();

/**
 * 下载链路的记录器（导出功能的用例要用）。
 *
 * jsdom 里 `URL.createObjectURL` 不可用，`browser.downloads` 也不存在，
 * 而"导出"这个功能的验收对象正是**交给浏览器的那份内容与文件名**——
 * 因此这里把两者都记下来供用例回读，而不是让用例去 mock 被测代码。
 *
 * ⚠️ `revokeObjectURL` **不删** map 里的条目：导出的对象 URL 是延迟回收的，
 * 用例要在回收之后仍能读到内容（"回收了没有"由 `download.test.ts` 断言）。
 */
const downloadCalls: Array<{ url: string; filename: string }> = [];
const objectUrls = new Map<string, Blob>();
let objectUrlSeq = 0;

URL.createObjectURL = ((blob: Blob) => {
  objectUrlSeq += 1;
  const url = `blob:leximate-test/${objectUrlSeq}`;
  objectUrls.set(url, blob);
  return url;
}) as typeof URL.createObjectURL;

URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

const g = globalThis as unknown as {
  browser?: unknown;
  chrome?: unknown;
  __leximateEmitRuntimeMessage?: (message: unknown) => void;
  __leximateDownloads?: Array<{ url: string; filename: string }>;
  __leximateObjectUrls?: Map<string, Blob>;
};

if (!g.browser) {
  g.browser = {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '0.0.0-test' }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: async () => undefined,
      onMessage: {
        addListener: (listener: RuntimeListener) => runtimeListeners.add(listener),
        removeListener: (listener: RuntimeListener) => runtimeListeners.delete(listener),
      },
    },
    downloads: {
      download: async (options: { url: string; filename: string }) => {
        downloadCalls.push({ url: options.url, filename: options.filename });
        return downloadCalls.length;
      },
    },
  };
}

g.__leximateDownloads = downloadCalls;
g.__leximateObjectUrls = objectUrls;

/** 用例用它在 jsdom 里模拟"后台广播了一条消息" */
g.__leximateEmitRuntimeMessage = (message: unknown) => {
  for (const listener of [...runtimeListeners]) listener(message);
};

beforeEach(() => {
  // 监听者按用例清空：上一个用例卸载后的监听器不应收到下一条广播
  runtimeListeners.clear();
  // 下载记录同样按用例清空，否则上一个用例导出的文件会混进断言
  downloadCalls.length = 0;
  objectUrls.clear();
  resetDbHandle();
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  cleanup();
});
