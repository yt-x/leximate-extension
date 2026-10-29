/**
 * 管理台侧："告诉后台数据变了"（PLAN.md FR-A14）。
 *
 * ## 为什么需要这条路
 *
 * 角标是**全局**的（`action.setBadgeText` 不带 tabId 就是全局角标），
 * 只有后台调 `badge.sync()` 才会变。而后台刷新角标原先只有三条触发路径：
 * Service Worker 启动、`onStartup` / `onInstalled`、**设置写入**。
 *
 * 管理台是**另一个页面**：它删词、改状态是**直接写扩展源的 IndexedDB**，
 * 不产生任何 storage 事件（数据在 IndexedDB 里，见 `decisions/0009`），
 * 也不走 `setSettings`。于是后台完全不知道——
 * 表现就是用户看到的那样：**清空生词、刷新页面，角标照旧**。
 *
 * ## 为什么不是"让管理台自己写角标"
 *
 * 管理台确实有权限直接写角标，但那样角标就有了两个写入者，
 * 且"词数 → 文案"的判定（含 FR-A14 的 `OFF` 分支）要在两处各写一遍。
 * 本项目的数据归属是**后台持有**（`decisions/0010`），因此只发一条通知，
 * 由后台重算。
 */
import { MSG } from '../content/messages';

export interface DataChangeEnv {
  /** 发消息给后台（与内容脚本用的是同一套消息协议） */
  sendToBackground(message: unknown): Promise<unknown>;
}

/**
 * 造一个"通知后台"的函数。
 *
 * 返回 `false` 表示通知没送到（后台被回收、页面正在卸载）——
 * **写库此时已经成功**，所以调用方不该因此报错，最多记一条日志。
 */
export function createDataChangeNotifier(env: DataChangeEnv): () => Promise<boolean> {
  return async function notifyDataChanged(): Promise<boolean> {
    try {
      await env.sendToBackground({ type: MSG.dataChanged });
      return true;
    } catch {
      return false;
    }
  };
}
