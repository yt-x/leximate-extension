/**
 * 内容脚本侧调用后台的客户端（PLAN.md §4.5 P3）。
 *
 * 内容脚本**不能**直接读写扩展源的 IndexedDB（见
 * `docs/reference/extension-storage-and-messaging.md` §1），
 * 所有数据读写都经这里发消息给后台。
 *
 * ⚠️ 网络能力**不存在**：`SendEnv` 只有"发消息给本扩展的后台"一种能力，
 * 因此 FR-K1「运行时零网络」在类型层面无法违反——这与 M1-5 对
 * `HighlightEnv` 的处理是同一手法。
 */
import { MSG, parseImportedResponse, type ContentRequest } from './messages';
import type { CardDetail, WordState } from './word-state-shared';
import type { WordStateGateway } from './word-state-cache';

/** 发消息的能力（内容脚本 → 后台） */
export interface SendEnv {
  sendToBackground(request: ContentRequest): Promise<unknown>;
}

/**
 * 把后台的响应解析成词状态。
 *
 * 响应**不可信**：消息通道的对面若出问题（后台被回收、协议版本不匹配），
 * 回来的可能是 `undefined` / 畸形对象。这里逐项校验，
 * 坏数据一律丢弃而不是塞进缓存——缓存里混进脏数据会让标注长期画错。
 */
export function parseStatesResponse(
  response: unknown,
): Array<{ word: string; state: WordState }> {
  if (!Array.isArray(response)) return [];

  const out: Array<{ word: string; state: WordState }> = [];
  for (const item of response) {
    if (typeof item !== 'object' || item === null) continue;

    const { word, state } = item as { word?: unknown; state?: unknown };
    if (typeof word !== 'string' || word.trim() === '') continue;
    if (typeof state !== 'object' || state === null) continue;

    const { status, meetCount } = state as { status?: unknown; meetCount?: unknown };
    if (status !== 'new' && status !== 'known' && status !== 'ignored') continue;

    out.push({
      word: word.trim().toLowerCase(),
      state: {
        status,
        meetCount: typeof meetCount === 'number' && Number.isFinite(meetCount)
          ? meetCount
          : 0,
      },
    });
  }
  return out;
}

/** 解析单条状态响应 */
export function parseStateResponse(response: unknown): WordState | undefined {
  const parsed = parseStatesResponse([{ word: 'x', state: response }]);
  return parsed[0]?.state;
}

/**
 * 解析卡片 ④段的响应（FR-A5）。
 *
 * 同样按"响应不可信"处理：形状不对就返回 `undefined`（= 没有可显示的数据），
 * 而不是拿半个对象去改卡片——卡片上写错日期比不写更糟。
 */
export function parseCardResponse(response: unknown): CardDetail | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const { firstSeenAt, examples } = response as { firstSeenAt?: unknown; examples?: unknown };
  if (!Array.isArray(examples)) return undefined;

  const parsed: CardDetail['examples'] = [];
  for (const item of examples) {
    if (typeof item !== "object" || item === null) continue;
    const { text, source, at } = item as { text?: unknown; source?: unknown; at?: unknown };
    if (typeof text !== "string" || text === "") continue;
    parsed.push({
      text,
      source: typeof source === 'string' && source !== '' ? source : null,
      at: typeof at === "number" && Number.isFinite(at) ? at : null,
    });
  }

  return {
    firstSeenAt:
      typeof firstSeenAt === "number" && Number.isFinite(firstSeenAt) ? firstSeenAt : null,
    examples: parsed,
  };
}

/**
 * 造一个走消息的后台网关。
 *
 * 每个方法都**吞掉异常并返回安全值**：内容脚本在页面上跑，
 * 一次消息失败（后台冷启动、页面正在卸载）不该让标注整体崩掉——
 * 最差退化成"这个词按生词处理"，而不是白屏。
 */
export function createMessagingGateway(env: SendEnv): WordStateGateway {
  return {
    async fetchStates(words) {
      if (words.length === 0) return [];
      try {
        const response = await env.sendToBackground({
          type: MSG.fetchStates,
          words: [...words],
        });
        return parseStatesResponse(response);
      } catch {
        return [];
      }
    },

    /**
     * 拉下划线集合（§4.5 P3 的生词集合下发）。
     *
     * 解析口径：**只接受形状正确的条目**，整条响应不是数组就返回 `undefined`
     * （区别于"空集合"——空集合会把整页下划线抹掉，而"拿不到"应该保持原状）。
     */
    async fetchNewWords() {
      try {
        const response = await env.sendToBackground({ type: MSG.fetchNewWords });
        if (!Array.isArray(response)) return undefined;

        const out: Array<{ word: string; meetCount: number }> = [];
        for (const item of response) {
          if (typeof item !== 'object' || item === null) continue;
          const { word, meetCount } = item as { word?: unknown; meetCount?: unknown };
          if (typeof word !== 'string' || word.trim() === '') continue;
          out.push({
            word: word.trim().toLowerCase(),
            meetCount: typeof meetCount === 'number' && Number.isFinite(meetCount) ? meetCount : 1,
          });
        }
        return out;
      } catch {
        return undefined;
      }
    },

    /**
     * FR-A5 ④段：拉首次日期与首条例句。
     *
     * 失败返回 `undefined`（后台不可达 / 响应畸形）——卡片维持"例句尚未采集"，
     * 不改状态、不关弹窗；下一次划词会再拉。
     */
    async fetchCard(word) {
      try {
        const response = await env.sendToBackground({ type: MSG.fetchCard, word });
        return parseCardResponse(response);
      } catch {
        return undefined;
      }
    },

    /**
     * FR-B7：问一次导入词典（内置分片未命中时才调）。
     *
     * 返回 `null` = 导入词典里确实没有，调用方按 FR-B4 显示"未收录"。
     *
     * ⚠️ **出错也返回 null，但必须打日志**（`CONSTRAINTS.md` §33：拿不到与是空的必须分开）：
     * 后台不可达 / 查询抛错 与 "词典里没有" 是两回事。静默吞成 null 会让一个
     * 真实的故障（后台抛错、DB 被占用）伪装成"这个词没收录"，用户与开发者都无从发现。
     */
    async fetchImported(word) {
      try {
        const response = await env.sendToBackground({ type: MSG.fetchImported, word });
        return parseImportedResponse(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[leximate] fetch-imported 失败（word=${JSON.stringify(word)}）：${message}`);
        return null;
      }
    },

    async defineWord(word) {
      try {
        const response = await env.sendToBackground({ type: MSG.defineWord, word });
        if (typeof response !== 'object' || response === null) {
          return { error: '后台返回了不可用的释义' };
        }
        const value = response as { defZh?: unknown; error?: unknown };
        if (Array.isArray(value.defZh)) {
          const defZh = value.defZh.filter(
            (line): line is string => typeof line === 'string' && line.trim() !== '',
          );
          return defZh.length > 0 ? { defZh } : { error: '后台返回了不可用的释义' };
        }
        return { error: typeof value.error === 'string' ? value.error : '后台返回了不可用的释义' };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },

    async recordMeet(record) {
      try {
        const response = await env.sendToBackground({
          type: MSG.recordMeet,
          lemma: record.lemma,
          surface: record.surface,
          unlisted: record.unlisted,
          inflectionOf: record.inflectionOf ?? null,
          ...(record.dict ? { dict: record.dict } : {}),
          // FR-C1：这次划词所在的句子。不带它，后台就没例句可存——
          // 用户划词加入生词后例句数不增长，根因就在这里。
          ...(record.scene ? { scene: record.scene } : {}),
        });
        return parseStateResponse(response);
      } catch {
        return undefined;
      }
    },

    async setStatus(word, status) {
      try {
        const response = await env.sendToBackground({ type: MSG.setStatus, word, status });
        return parseStateResponse(response);
      } catch {
        return undefined;
      }
    },

    /**
     * 打开管理台（FR-A6）。
     *
     * 内容脚本打不开扩展页，只能请后台 `tabs.create`。
     * 失败（后台不可达）返回 `false`，由界面层决定要不要提示——这里不抛。
     */
    async openManager() {
      try {
        const response = await env.sendToBackground({ type: MSG.openManager });
        return response === true;
      } catch {
        return false;
      }
    },
  };
}

/** 拉当前设置（FR-A14 / FR-A13 都要它） */
export async function fetchSettings(env: SendEnv): Promise<unknown> {
  try {
    return await env.sendToBackground({ type: MSG.getSettings });
  } catch {
    return undefined;
  }
}
