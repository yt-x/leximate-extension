/**
 * 诊断日志的读写（PLAN.md FR-L4）。
 *
 * FR-L4 的原话："记录运行日志（安装、词库初始化、翻译失败、同步失败），
 * 可查看、可导出、**不上报任何数据**"。
 *
 * ## 为什么日志也要有上限
 *
 * 这是个**本地**日志表：诊断用得上，但没人会因为"日志涨到 10 万条"而收到提醒——
 * 只会看到占用莫名其妙地涨（FR-L5 的体积自检也会把它算进去）。
 * 因此写入时**顺手裁到 `MAX_LOG_ENTRIES` 条**（保留最新的），
 * 裁剪在同一次事务里完成，不会出现"写进去了但没裁"的中间态。
 *
 * ## 为什么内容脚本的日志要绕后台
 *
 * 内容脚本读不到扩展源的存储（`docs/reference/extension-storage-and-messaging.md` §1），
 * 所以它只能把事件发给后台，由后台写这张表。协议在 `utils/content/messages.ts` 的
 * `MSG.log`，落点在 `utils/content/message-handler.ts`。
 *
 * ⚠️ 纯逻辑（级别映射、输入清洗）在 `levels.ts`：本文件碰存储，
 * 内容脚本只允许 import 前者。
 */
import { readTx, req, STORE, writeTx } from '../db/schema';
import type { LogEntry } from '../db/types';
import {
  cleanText,
  isLogLevel,
  MAX_MESSAGE_LENGTH,
  MAX_SCOPE_LENGTH,
  sanitizeDetail,
} from './levels';

/** 日志表的条数上限（写入时裁剪） */
export const MAX_LOG_ENTRIES = 500;

export interface LogInput {
  level: unknown;
  scope: unknown;
  message: unknown;
  detail?: unknown;
  at?: number;
}

/** 写一条日志（并裁剪到上限）。任何输入都不抛错——诊断不该成为故障源 */
export async function writeLog(
  input: LogInput,
  options: { max?: number; now?: number } = {},
): Promise<void> {
  const max = options.max ?? MAX_LOG_ENTRIES;
  const entry: LogEntry = {
    level: isLogLevel(input.level) ? input.level : 'info',
    scope: cleanText(input.scope, MAX_SCOPE_LENGTH, 'unknown'),
    message: cleanText(input.message, MAX_MESSAGE_LENGTH, '(无消息)'),
    detail: sanitizeDetail(input.detail),
    at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : (options.now ?? Date.now()),
  };

  await writeTx(STORE.logs, async (tx) => {
    const store = tx.objectStore(STORE.logs);
    await req(store.add(entry));

    const total = await req<number>(store.count());
    let excess = total - max;
    if (excess <= 0) return;

    // 从最旧的一条开始删（autoIncrement 的 id 顺序就是写入顺序）
    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || excess <= 0) {
          resolve();
          return;
        }
        cursor.delete();
        excess -= 1;
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('裁剪日志失败'));
    });
  });
}

export interface ListLogsOptions {
  /** 最多返回多少条（默认按上限取，够诊断用） */
  limit?: number;
}

/** 读日志，**最新在前** */
export async function listLogs(options: ListLogsOptions = {}): Promise<LogEntry[]> {
  const limit = options.limit ?? MAX_LOG_ENTRIES;

  return readTx(STORE.logs, (tx) =>
    new Promise<LogEntry[]>((resolve, reject) => {
      const out: LogEntry[] = [];
      // 走 `at` 索引反向游标：时间序即写入序，不必把整表读进内存再排
      const request = tx.objectStore(STORE.logs).index('at').openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cursor.value as LogEntry);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('读取日志失败'));
    }),
  );
}

export async function countLogs(): Promise<number> {
  return readTx(STORE.logs, (tx) => req<number>(tx.objectStore(STORE.logs).count()));
}

/** 清空日志（FR-L4 的"可查看、可导出"之外的基本操作） */
export async function clearLogs(): Promise<void> {
  await writeTx(STORE.logs, (tx) => {
    tx.objectStore(STORE.logs).clear();
  });
}
