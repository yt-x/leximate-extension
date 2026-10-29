/**
 * 设置写入后的**进程内**通知钩子。
 *
 * ⚠️ 本模块经过一次重做，历史值得记下（`decisions/0009`）：
 *
 * 1. 最初内容脚本与后台都监听 `browser.storage.onChanged`。
 *    **那是死代码**——设置存在 IndexedDB 里，写它不产生任何 storage 事件。
 * 2. 改成在 `setSettings` 里广播 `runtime.sendMessage` 并让内容脚本订阅。
 *    **那也行不通**——官方明确 `runtime.sendMessage` **不能**投递给内容脚本
 *    （原文见 `docs/reference/extension-storage-and-messaging.md` §2）。
 *
 * 现在这一版只做**同一上下文内**的通知：后台自己需要知道"设置变了"
 * （刷新角标、向各标签页投递）。**跨上下文投递是 `broadcast.ts` 的职责**，
 * 它用 `tabs.sendMessage` 逐个标签页发。
 *
 * 这样切分之后，这个模块不依赖任何浏览器 API，也就不会再犯上面两个错。
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * 订阅"设置已写入"。
 *
 * 返回取消订阅函数。**只在写设置的上下文里有效**——
 * 内容脚本在自己的上下文里订阅是收不到后台那次写入的，
 * 它应该用 `broadcast.ts` 投递过来的 `settings-changed` 消息。
 */
export function onSettingsWritten(handler: Listener): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/**
 * 通知本上下文内的订阅者。由 `setSettings` 在写库成功后调用。
 *
 * 同步派发：调用方（`setSettings`）不关心监听者是谁，
 * 也不该被监听者的异步错误影响。
 */
export function notifySettingsWritten(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // 一个监听者出错不该影响其它监听者，也不该让 setSettings 失败
      console.warn('[leximate] 设置变更监听器抛错', error);
    }
  }
}

/** 仅供测试：清空订阅者，避免用例之间互相污染 */
export function resetSettingsListeners(): void {
  listeners.clear();
}
