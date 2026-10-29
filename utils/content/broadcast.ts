/**
 * 后台 → 内容脚本的定向投递（PLAN.md FR-A14）。
 *
 * ⚠️ **为什么不能用 `runtime.sendMessage`**：官方原文（见
 * `docs/reference/extension-storage-and-messaging.md` §2）——
 *
 * > Note that extensions cannot send messages to content scripts using this method.
 * > To send messages to content scripts, use `tabs.sendMessage`.
 *
 * 所以设置变更通知**必须**逐个标签页投递。
 *
 * 编排抽成纯逻辑（`planBroadcast`）+ 注入的 `BroadcastEnv`，
 * 使"哪些标签页收到"这件事可以在单测里断言，而不是只能靠真机看。
 */
import { MSG, type SettingsChangedNotice, type WordsChangedNotice } from './messages';

/**
 * 投递给内容脚本的通知种类。
 *
 * `tabs.sendMessage` 是内容脚本**唯一**收得到的通道，因此"设置变更"与
 * "词库变了"（重拉生词集合、重扫下划线）都走它。
 */
export type TabNotice = SettingsChangedNotice | WordsChangedNotice;

/** 投递需要的浏览器能力 */
export interface BroadcastEnv {
  /** 枚举可投递的标签页 id */
  listTabIds(): Promise<number[]>;
  /** 投递给单个标签页；返回是否至少有一个接收方 */
  sendToTab(tabId: number, notice: TabNotice): Promise<boolean>;
}

export interface BroadcastResult {
  /** 尝试投递的标签页数 */
  attempted: number;
  /** 至少有一个接收方的标签页数 */
  delivered: number;
  /** 投递失败的标签页 id（多为未注入内容脚本的页面） */
  failed: number[];
}

/**
 * 决定该投给哪些标签页。
 *
 * 单独的纯函数是为了能测"哪些被排除"这类规则。
 * 当前规则：**全部**标签页都尝试——
 * 未注入内容脚本的页面（`chrome://`、扩展页、`file://` 等）会投递失败，
 * 那属于正常噪声，由 `sendToTab` 的返回值区分，不预先过滤。
 *
 * 不预先过滤的理由：标签页的 URL 可以在投递瞬间变化，
 * 按 URL 预筛会漏掉刚导航到普通网页的标签页；而漏投的代价是
 * 该页面继续用旧设置（用户要重载才生效），比多投一次大。
 */
export function planBroadcast(tabIds: number[]): number[] {
  // 去重并保持稳定顺序：某些路径可能重复枚举到同一个 id
  return [...new Set(tabIds)].filter((id) => Number.isInteger(id) && id >= 0);
}

/** 广播设置变更；返回投递统计供诊断（FR-L4） */
export async function broadcastToTabs(
  notice: TabNotice,
  env: BroadcastEnv,
): Promise<BroadcastResult> {
  const targets = planBroadcast(await env.listTabIds());

  const failed: number[] = [];
  let delivered = 0;

  // 逐个投递而不是 Promise.all：某一页投递失败（很常见）不该影响其它页，
  // 而且顺序投递让失败日志更可读
  for (const tabId of targets) {
    try {
      if (await env.sendToTab(tabId, notice)) delivered += 1;
      else failed.push(tabId);
    } catch {
      // 未注入内容脚本的页面会走到这里，属正常情况
      failed.push(tabId);
    }
  }

  return { attempted: targets.length, delivered, failed };
}
