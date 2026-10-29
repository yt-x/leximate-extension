/**
 * "词库变了"的进程内通知（FR-E7 的界面联动）。
 *
 * ## 为什么需要
 *
 * 管理台的两个页面是**同时挂载**的（`App.tsx` 用 `hidden` 切换，
 * 为的是切回"生词"时滚动位置与筛选都还在，见 FR-F7）。
 * 于是设置页清空数据之后，一直挂着的 `WordList` 手里还是**旧行**——
 * 切回"生词"会看到已经删掉的词。
 *
 * ## 与 `data-changed.ts` 的分工
 *
 * 两个都叫"变了"，但**收件人不同**，不要混：
 *
 * | 模块 | 方向 | 收件人 | 干什么 |
 * |---|---|---|---|
 * | `data-changed.ts` | 跨上下文（消息） | **后台** | 重算角标（FR-A14） |
 * | 本模块 | 同上下文（进程内） | 管理台的其它页面 | 重新读库、刷新界面 |
 *
 * 与 `utils/settings-bus.ts` 是同一手法：**只做本上下文内的通知**，
 * 不碰任何浏览器 API，因此能在 Node 里逐条验收。
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** 订阅"词库变了"；返回取消订阅函数 */
export function onWordsChanged(handler: Listener): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/**
 * 通知本上下文内的订阅者。
 *
 * 同步派发：调用方（清空数据、批量操作）不关心监听者是谁，
 * 也不该被某个监听者的异常影响。
 */
export function notifyWordsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // 一个监听者出错不该影响其它监听者，也不该让写库操作失败
      console.warn('[leximate] 词库变更监听器抛错', error);
    }
  }
}

/** 仅供测试：清空订阅者，避免用例之间互相污染 */
export function resetWordsListeners(): void {
  listeners.clear();
}
