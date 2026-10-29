/**
 * 后台的消息处理（PLAN.md §4.5 P3、FR-A6、FR-A10、FR-A14、FR-A17）。
 *
 * 后台是**数据的持有者**：词状态、设置、计数都在扩展源。
 * 内容脚本读不到扩展源（见 `docs/reference/extension-storage-and-messaging.md` §1），
 * 因此所有读写都经这里。
 *
 * ⚠️ 安全约束（官方原文，同文件 §4）：
 * > Assume that messages from a content script might have been crafted by an
 * > attacker and make sure to validate and sanitize all input.
 *
 * 所以每个入口都先洗输入（`messages.ts` 的 `sanitize*`），
 * 不信任 `words` 是数组、不信任 `status` 是合法值、不信任单词长度。
 *
 * ⚠️ 方向约束（同文件 §2）：**本文件处理"内容脚本 → 后台"方向**。
 * 反方向的通知必须用 `tabs.sendMessage`，在 `broadcast.ts` 里。
 */
import { getSettings } from '../db/kv';
import {
  MSG,
  sanitizeDictFields,
  sanitizeStatus,
  sanitizeSurface,
  sanitizeWord,
  sanitizeWords,
} from './messages';
import type { MeetRecordResult, WordStateStore } from './word-state';
import type { WordState } from './word-state-shared';
import { toContentSettings } from './content-settings';
import type { WordDefinitionResult } from '../translate/define-word';

/** 处理器需要的能力，注入以便单测 */
export interface HandlerEnv {
  store: WordStateStore;
  /** 读设置（含 FR-A14 的 enabled） */
  getSettings(): Promise<unknown>;
  /** 用户点击后生成未收录词释义；后台检查配置与告知，内容脚本不接触 key。 */
  defineWord?(word: string): Promise<WordDefinitionResult>;
  /** 打开管理台标签页（FR-A6）；由后台入口接上 `tabs.create` */
  openManager(): unknown;
  /**
   * 重算并写角标（FR-A14）。
   *
   * **任何改变词数的消息之后都必须调**，否则角标会停在旧数字上直到
   * Service Worker 被回收重启——用户的观感就是"删完词角标还在"。
   */
  refreshBadge(): void;
  /**
   * 广播"词库变了"给**扩展页面**（管理台），FR-F2。
   *
   * 与 `refreshBadge` 总是成对调用：一个管角标、一个管界面。
   * 内容脚本写的是扩展源的库，管理台是另一个页面、也收不到 storage 事件
   * （`decisions/0009`），没有这条广播，已打开的管理台会一直显示旧列表。
   */
  onWordsChanged(): void;
  /** 管理台写入后向内容脚本广播最新的无秘密设置（FR-A14）。 */
  onSettingsChanged?(): void;
  /** 任意本地数据写入后合并到一个延迟同步窗口（FR-H4）。 */
  onSyncRequested?(): void;
  /**
   * 入库之后的通知钩子（FR-D1 / FR-D6）。
   *
   * 为什么放在"入库之后"而不是翻译那一侧自己轮询：**只有这一刻知道"刚刚多了一条例句"**。
   * 它是可选的，且实现方必须自己兜住错误——翻译是增益功能，挂掉不能影响划词入库。
   */
  onMeetRecorded?(info: { lemma: string; sceneText?: string; sceneId?: string }): void;
  /**
   * 写一条诊断日志（FR-L4）。
   *
   * 由后台注入真实实现（`utils/diag/log.ts` 的 `writeLog`）；
   * 内容脚本读不到扩展源的日志表，所以它的日志也走这里落库。
   */
  writeLog(entry: {
    level: unknown;
    scope: unknown;
    message: unknown;
    detail?: unknown;
  }): Promise<void>;
  /**
   * 查导入词库（FR-B7）。
   *
   * 内容脚本只能读内存分片，导入词在扩展源库里；分片未命中时问这里。
   * 返回 `null` = 导入词库里也没有（调用方据此判 FR-B4 的「未收录」）。
   */
  lookupImported?(
    word: string,
  ): Promise<{ lemma: string; hint: string | null; word: { phoneticUs: string; pos: string[]; defZh: string[]; fallbackDef: string[]; examTags: string[] } } | null>;
  /**
   * 读一个随包词表文件的文本（`dict/` 下的白名单文件）。
   *
   * 为什么由后台读：内容脚本直接 `fetch` 扩展资源时请求来源是页面源，
   * 会被严格 CSP 站点拦（实测 YouTube 报 `Unsafe attempt to load URL`）。
   * 返回 `null` = 文件名不在白名单或读取失败。
   */
  readDictFile?(file: string): Promise<string | null>;
}

export interface HandlerResult {
  /** 是否处理了这条消息；false 表示不归我们管 */
  handled: boolean;
  /** 回给内容脚本的数据 */
  response?: unknown;
}

/**
 * 把一条来自内容脚本的消息派发到对应处理。
 *
 * 返回 `{ handled: false }` 表示"不是我们的消息"，调用方应继续把消息
 * 让给其它监听器（避免吞掉别人的消息）。
 *
 * **所有分支都不抛错**：内容脚本侧等的是 Promise，
 * 后台抛错会让它挂起或得到一个难懂的异常（Chrome 146 起监听器抛错会拒绝发送方）。
 * 所以这里对畸形输入一律返回安全默认值。
 */
export async function handleContentMessage(
  message: unknown,
  env: HandlerEnv,
): Promise<HandlerResult> {
  if (typeof message !== 'object' || message === null) {
    return { handled: false };
  }
  const { type } = message as { type?: unknown };

  switch (type) {
    case MSG.getSettings: {
      return { handled: true, response: toContentSettings(await env.getSettings()) };
    }

    case MSG.defineWord: {
      const word = sanitizeWord((message as { word?: unknown }).word);
      if (word === null) return { handled: true, response: { error: '单词为空或不可用' } };
      if (!env.defineWord) return { handled: true, response: { error: '未配置 LLM 释义能力' } };
      return { handled: true, response: await env.defineWord(word) };
    }

    case MSG.fetchStates: {
      const words = sanitizeWords((message as { words?: unknown }).words);
      if (words.length === 0) return { handled: true, response: [] };

      const states = await env.store.getMany(words);
      return { handled: true, response: states };
    }

    case MSG.fetchNewWords: {
      // §4.5 P3 的生词集合下发：内容脚本据此**同步**判定"这个页面词该不该标下划线"。
      // 只回词条原形 + 遇见次数（释义/音标不在其中）——也因此它不会成为"全量词库外流"。
      return { handled: true, response: await env.store.listNewWords() };
    }

    case MSG.fetchImported: {
      // FR-B7：内置分片未命中时，内容脚本问一次"导入词库里有没有"
      const word = sanitizeWord((message as { word?: unknown }).word);
      if (word === null || !env.lookupImported) return { handled: true, response: null };
      const hit = await env.lookupImported(word);
      return { handled: true, response: hit };
    }

    case MSG.readDictFile: {
      // 内容脚本读随包词表（页面 CSP 会拦它自己的 fetch，见 messages.ts 的说明）
      const file = (message as { file?: unknown }).file;
      if (typeof file !== 'string' || !isAllowedDictFile(file) || !env.readDictFile) {
        return { handled: true, response: null };
      }
      const text = await env.readDictFile(file);
      return { handled: true, response: text };
    }

    case MSG.recordMeet: {
      const lemma = sanitizeWord((message as { lemma?: unknown }).lemma);
      if (lemma === null) return { handled: true, response: null };

      const surface = sanitizeSurface((message as { surface?: unknown }).surface) ?? lemma;
      const unlisted = (message as { unlisted?: unknown }).unlisted === true;
      const dict = sanitizeDictFields((message as { dict?: unknown }).dict);
      const inflectionOf = sanitizeWord((message as { inflectionOf?: unknown }).inflectionOf);
      // FR-C1：例句字段不合法只丢例句，**不丢这次记账**——记账才是主链路
      const scene = sanitizeScene((message as { scene?: unknown }).scene);

      // 记账内容按 §2 数据模型组装：命中带词库字段，未收录标 isUnlisted（FR-B4）
      const state: MeetRecordResult = await env.store.recordMeet({
        lemma,
        surface,
        unlisted,
        inflectionOf,
        ...(dict ? { dict } : {}),
        ...(scene ? { scene } : {}),
      });
      // 词数变了 → 角标要立刻跟上（划词收藏后角标该涨），
      // 同时告诉已打开的管理台重读库（它就是靠这条看到新词的）
      env.refreshBadge();
      env.onWordsChanged();
      env.onSyncRequested?.();
      // FR-D1 / FR-D6：入库之后交给翻译侧决定要不要入队、什么时候跑。
      // 用 try 包住：这个钩子出问题不该让内容脚本收到失败（它只关心词有没有入库）。
      try {
        env.onMeetRecorded?.({
          lemma,
          ...(scene ? { sceneText: scene.text } : {}),
          ...(state.sceneId ? { sceneId: state.sceneId } : {}),
        });
      } catch {
        // 翻译侧的错误在它自己的日志里，这里只保证不连累入库结果
      }
      return { handled: true, response: state };
    }

    case MSG.fetchCard: {
      const word = sanitizeWord((message as { word?: unknown }).word);
      if (word === null) return { handled: true, response: null };

      return { handled: true, response: (await env.store.getCard(word)) ?? null };
    }

    case MSG.setStatus: {
      const word = sanitizeWord((message as { word?: unknown }).word);
      const status = sanitizeStatus((message as { status?: unknown }).status);
      if (word === null || status === null) return { handled: true, response: null };

      const state = await env.store.setStatus(word, status);
      // 状态变了：角标文案虽然只看词数，但"已掌握/生词"的切换走的是同一条写入路径，
      // 统一在这里刷新，避免将来加"按状态显示角标"时又漏一处
      env.refreshBadge();
      env.onWordsChanged();
      env.onSyncRequested?.();
      return { handled: true, response: state };
    }

    case MSG.dataChanged: {
      // 管理台直接写了扩展源的库。后台的逐词缓存不会收到 IndexedDB 事件，
      // 必须先失效，否则旧状态会把已删除/已改状态的词伪装成仍在生词本。
      env.store.clear();
      env.refreshBadge();
      env.onWordsChanged();
      env.onSettingsChanged?.();
      env.onSyncRequested?.();
      return { handled: true, response: true };
    }

    case MSG.openManager: {
      // 打开标签页可能失败（API 不可用、被策略拦），回 `false` 而不是抛错——
      // 内容脚本在等这个 Promise，抛错在发送方会变成难懂的异常（见文件头）。
      try {
        env.openManager();
        return { handled: true, response: true };
      } catch {
        return { handled: true, response: false };
      }
    }

    case MSG.log: {
      // FR-L4：内容脚本的日志（它写不了扩展源的日志表）。
      // `writeLog` 内部会洗输入（级别白名单、字段限长、detail 截断），
      // 因此这里不做二次校验——两处各洗一遍只会让"到底谁负责"变模糊。
      const report = message as { level?: unknown; scope?: unknown; message?: unknown; detail?: unknown };
      try {
        await env.writeLog({
          level: report.level,
          scope: report.scope,
          message: report.message,
          detail: report.detail,
        });
      } catch {
        // 本分支的契约与其它分支一致：**不抛错**（内容脚本在等这个 Promise）。
        // 诊断日志写不进去（配额满、库被清）不该让页面侧收到一个难懂的异常。
      }
      // 单向通知：回 `true` 只是让发送方拿到一个确定的结果
      return { handled: true, response: true };
    }

    default:
      return { handled: false };
  }
}

/** FR-C1 的例句上限（清洗后 500 字 + 两端省略号，留一点余量） */
const MAX_SCENE_TEXT = 600;
const MAX_SCENE_URL = 2048;
const MAX_SCENE_TITLE = 300;

interface SanitizedScene {
  text: string;
  highlightFrom: number;
  highlightTo: number;
  sourceUrl: string;
  sourceTitle: string;
}

/**
 * 校验一条例句（FR-C1）。
 *
 * 结构性等价于 `SceneCapture`（`word-state-shared.ts`），就地声明是为了不给这个文件
 * 多一条类型导入；两边一旦漂移，`tsc` 会在 `store.recordMeet` 的入参上直接报错。
 *
 * 任一字段不合法就返回 `undefined`：**坏例句被丢掉，记账照旧进行**。
 */
function sanitizeScene(value: unknown): SanitizedScene | undefined {  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as {
    text?: unknown;
    highlightFrom?: unknown;
    highlightTo?: unknown;
    sourceUrl?: unknown;
    sourceTitle?: unknown;
  };

  if (typeof raw.text !== 'string') return undefined;
  // 刻意**不 trim**：修剪会让 highlightFrom/To 的坐标系整体偏移
  const text = raw.text;
  if (text.trim() === '' || text.length > MAX_SCENE_TEXT) return undefined;

  const from = raw.highlightFrom;
  const to = raw.highlightTo;
  if (typeof from !== 'number' || typeof to !== 'number') return undefined;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return undefined;
  if (from < 0 || to < from || to > text.length) return undefined;

  return {
    text,
    highlightFrom: from,
    highlightTo: to,
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl.slice(0, MAX_SCENE_URL) : '',
    sourceTitle:
      typeof raw.sourceTitle === 'string' ? raw.sourceTitle.slice(0, MAX_SCENE_TITLE) : '',
  };
}

/**
 * `read-dict-file` 的文件名白名单。
 *
 * 只允许 `dict/` 下**实际存在的那几类文件名**，并拒绝任何路径分隔符与 `..`——
 * 否则这条通道就成了"内容脚本可读扩展包任意文件"（页面脚本若拿到消息能力就能利用）。
 * 分片文件名形如 `shard-a.json`（`utils/dict/build.ts::shardEntries` 产出）。
 */
const DICT_FILE_PATTERN = /^(index\.json|inflections\.json|shard-[a-z0-9-]+\.json)$/;

export function isAllowedDictFile(file: string): boolean {
  return DICT_FILE_PATTERN.test(file);
}