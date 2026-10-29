/**
 * 内容脚本主控（PLAN.md FR-A1、FR-A4、FR-A7、FR-A13、FR-A14）。
 *
 * 把前面各层接起来，并**只做接线**——判定、定位、分组、渲染都在各自的模块里，
 * 各自已单测过。这里的所有浏览器依赖都由调用方注入，因此本文件可在 Node 里验收
 * "该弹的时候弹、该关的时候关、黑名单站点什么都不做"这些**行为契约**。
 *
 * 生命周期（FR-A13 / FR-A14）：
 * ```
 * shouldRunOn(enabled, hostname, blacklist)
 *   ├─ false → 什么都不做（零注入、零标注），就此结束
 *   └─ true  → warm 词库 → 挂监听（mouseup / scroll / keydown / blur）
 *              → 首次全量标注 → MutationObserver 增量标注
 * ```
 */
import type { DictLookup } from '../dict/lookup';
import type { WordStatus, LogLevel } from '../db/types';
import type { ContentSettings } from './content-settings';
import { isBlacklisted } from './blacklist';
import { isBlockedByTag } from './blocked-tags';
import type { CardAction, CardModel } from './card';
import { cardFromHit, cardFromUnlisted, definitionText } from './card';
import type { AnnotationScheduler } from './observe';
import { createBrowserSchedulerEnv, createScheduler, observeMutations } from './observe';
import { createPopup, type Popup } from './popup';
import { scrolledTooFar, type Rect } from './position';
import { querySelectionAsync, type ImportedLookup, type QueryResult } from './query';
import { captureSelection, type SelectionLike } from './selection';
import { shouldRunOn, themeFromSettings } from './settings-bridge';
import { createBrowserHighlightEnv, createHighlightSession, type HighlightEnv, type NodeSpans } from './highlight';
import { scanWords } from './scan';
import { createBrowserSpeechEnv, createSpeech, safeRate } from './speech';
// ⚠️ 只 import 纯逻辑那一半：`utils/diag/log.ts` 碰 IndexedDB，
// 内容脚本把它拉进依赖图就会踩"内容脚本读不到扩展源存储"那条线
import { contentLogLevel } from '../diag/levels';
import { normalizeForLookup } from './word';
import type { CardDetail, MeetRecord, SceneCapture, WordState } from './word-state-shared';
import type { WordDefinitionResult } from '../translate/define-word';
import { captureScene as captureSentenceScene, displayDomain } from './scene';

/**
 * 控制器需要的外部能力。**全部注入**，因此测试里可以用假实现驱动完整流程。
 *
 * 特别地：**没有任何"发网络请求"的能力**——FR-K1 的"运行时零网络"在类型层面就无法违反。
 */
export interface ControllerEnv {
  settings: ContentSettings;
  hostname: string;
  dict: DictLookup;
  /**
   * 内置分片未命中时问一次导入词典（FR-B7）。
   *
   * ⚠️ 上一轮把它接在 `query.ts` 与后台之间，却**忘了从 controller 传下去**，
   * 于是导入词库那条分支永远走不到——用户导完完整词库，划 `Adventures`
   * 仍然显示「未收录 · 可在设置页导入完整词库后查到」。本字段就是为了把它接上。
   * 未注入时行为与没有导入功能时完全一致。
   */
  lookupImported?: ImportedLookup;
  popup: Popup;
  highlight: HighlightEnv;
  /** 取当前选区；无选区返回 null */
  getSelection(): SelectionLike | null;
  /** 取选区对应的矩形（用于定位弹窗） */
  getSelectionRect(): Rect | null;
  /** 取视口的滚动位置 */
  getScroll(): { x: number; y: number };
  /** 遍历页面文本节点，供标注扫描 */
  collectTextNodes(root: Node): Node[];
  /** 读一个文本节点的内容 */
  readText(node: Node): string;
  /**
   * 页面上的这个词**该不该标下划线**；返回它的遇见次数（分档用），不该标则 `undefined`。
   *
   * 判据是"**在本地生词本里且 `status = new`**"，集合由后台**一次性下发**
   * （`PLAN.md` §4.5 P3）；实现里还负责**词形还原**（页面 `running` → 词条 `run`）。
   *
   * ⚠️ **不能用"词典认识它"当判据**：那样"被收藏但词表没收录的词"（如 `proof`，
   * 不在 920 条核心词表里）永远进不了候选，收藏之后也画不出下划线——实测过的失败形态。
   * 词典在这里只该当**词形还原器**用，不该当过滤器。
   */
  underlineCount(word: string): number | undefined;
  /**
   * 同步读缓存里的权威状态；**未知返回 `undefined`**。
   *
   * 这是**唯一**的状态读法。刻意不提供"未命中按 `UNSEEN`（生词）兜底"的
   * 那种读法：它让"不在生词本里"与"是生词"混为一谈，
   * 于是页面上每个词库词都被当成生词标下划线（实测过的失败形态）。
   * 卡片也靠它区分"未加入（主操作＝加入生词本）"与"是生词"。
   */
  cachedState(word: string): WordState | undefined;
  /**
   * 拉一批词的权威状态进缓存（**划词路径**用：卡片要知道次数与状态）。
   *
   * 返回**是否真的取到了东西**。实现必须记住"哪些词已经问过了"，
   * 否则同一批词会被反复询问。
   *
   * ⚠️ 标注路径**不再**用它：那条路走 `underlineCount`（后台下发的生词集合），
   * 否则未收录的词永远问不出结果也标不出来。
   */
  ensureStates(words: readonly string[]): Promise<boolean>;
  /** 记一次遇见（FR-A17）；返回是否真的 +1 */
  recordMeet(record: MeetRecord): boolean;
  /**
   * FR-C1：捕获"这次划词所在的那句话"。
   *
   * **可选**：没接这个能力（或捕获失败返回 `null`）时，消息、入库与卡片的行为
   * 与没有例句采集时**完全一致**——例句是增量能力，不是划词的前置条件。
   *
   * 必须与选区在**同一次事件里**捕获：选区在用户下一次点击后就不存在了。
   */
  captureScene?(): SceneCapture | null;
  /**
   * FR-A5 ④段：拉"首次日期 + 首条例句 + 来源域名"。
   *
   * **可选**：没接这个能力（或返回 `undefined`）时，卡片维持"例句尚未采集"的显示，
   * 与没有这条通道时完全一致。只在词**已在生词本里**时调用。
   */
  fetchCard?(word: string): Promise<CardDetail | undefined>;
  /**
   * 改词条状态（FR-A6 的"已掌握 / 改回生词 / 忽略"）。
   *
   * 返回**落库后的权威状态**；后台不可达时返回 `undefined`——
   * 那时界面必须**不谎报成功**（卡片不变、弹窗不关）。
   */
  setStatus(word: string, status: WordStatus): Promise<WordState | undefined>;
  /** 朗读一个词（FR-I1）；不可用时空操作 */
  speak(word: string): void;
  /** FR-I3：是否有可用发音。**只有确定不可用才返回 false**（加载中返回 true） */
  canSpeak(): boolean;
  /** 语音可用性变化时通知（加载 → 确定），用于刷新已打开的卡片 */
  onSpeechAvailable(cb: () => void): () => void;
  /**
   * FR-I2：改发音语速，**下一次发音即生效**。
   *
   * 由内容脚本入口在收到 `settings-changed` 时调用（设置页改完不需要重载页面）。
   */
  setSpeechRate(rate: number): void;
  /** 复制纯文本到剪贴板（FR-A6 的"复制释义"） */
  /** 复制纯文本到剪贴板（FR-A6 的"复制释义"） */
  copyText(text: string): Promise<boolean>;
  /** 用户点击后生成未收录词的 LLM 释义（FR-B4）。 */
  defineWord?(word: string): Promise<WordDefinitionResult>;
  /** 打开管理台新标签页（FR-A6） */
  openManager(): void;
  scheduler: AnnotationScheduler;
  /** 挂事件监听；返回解绑函数 */
  on(target: 'document' | 'window', event: string, handler: (e: unknown) => void, capture: boolean): () => void;
  /** 观察增量变更；返回可断开的观察器 */
  observe(target: Node, scheduler: AnnotationScheduler): { disconnect(): void };
  /** 标注扫描的根节点 */
  root(): Node;
  log(event: string, detail?: unknown): void;
}

export interface Controller {
  /** 跑起来；返回是否真的启用了 */
  start(): Promise<boolean>;
  /** 处理一次划词（供事件回调调用，也便于测试直接驱动） */
  handleSelection(): Promise<CardModel | null>;
  /**
   * 后台回写权威状态后，就地刷新**当前这张**卡片（FR-A5 ④段）。
   *
   * 存在的理由：划词即入库（FR-A17）是**异步**发生的（经消息),
   * 卡片是先画出来的，那时缓存里还没有这个词的状态。
   * 没有这一步，卡片上永远显示"首次记录"，用户看不到"它已经记进去了"。
   *
   * 只刷新同一个词条的卡片；弹窗已关或词不同都什么都不做。
   */
  applyState(word: string, state: WordState): void;
  /** 全量重扫并标注 */
  annotateAll(): void;
  /** 增量标注一个子树 */
  annotateSubtree(node: Node): void;
  /** 替换内容设置快照；运行中立即重扫标注 */
  updateSettings(next: ContentSettings): void;
  /** 关闭弹窗 */
  closePopup(): void;
  /** FR-I2：改发音语速（下一次发音生效，不重建控制器） */
  setSpeechRate(rate: number): void;
  /** 停止一切（全局开关关闭时调用） */
  stop(): void;
  /** 当前是否在运行 */
  isRunning(): boolean;
}

export function createController(env: ControllerEnv): Controller {
  let running = false;
  let unbinds: Array<() => void> = [];
  let observer: { disconnect(): void } | null = null;
  let popupAnchorAt: { x: number; y: number } | null = null;
  let lastHandled: string | null = null;
  /**
   * 是否在等一次 `selectionchange` 补齐选区（FR-A1 的口径）。
   *
   * 只有 `mouseup` 时选区为空才会挂上，且**处理一次即撤**——
   * 它是补等，不是第二条独立的触发源（见 `onSelectionChange`）。
   */
  let awaitingSelectionChange = false;
  /** 当前卡片：状态变更后就地重绘要用它，语音可用性变化也要用它 */
  let currentCard: CardModel | null = null;
  /**
   * 当前卡片对应的**记账内容**。
   *
   * 「加入生词本」要用它：命中时的音标/释义、或未收录标记都在这里，
   * 而卡片模型上只有展示所需的那几项。
   */
  let currentRecord: MeetRecord | null = null;
  /**
   * 标注会话（FR-A12 的增量语义）。
   *
   * 之所以要在控制器里持有它而不是让标注层做无状态的"清空重来"：
   * 增量标注必须知道"这个节点上次标了什么"才能只摘掉自己的那一份。
   */
  const highlightSession = createHighlightSession(env.highlight);

  /**
   * 标注一个子树（FR-A9 / FR-A10 / FR-A12）。
   *
   * 判据只有一条：**这个词在生词本里且 `status = new`**（`underlineCount`），
   * 集合由后台一次性下发（§4.5 P3），因此这里**不需要任何异步等待**——
   * 一次同步扫描就能定下整棵子树要标什么。
   *
   * ⚠️ 这里曾经有三处错，每一处都有实测的失败形态：
   * 1. 候选用"**词典认识它**"来圈（`scanKnownWords`）→ 被收藏但词表没收录的词
   *    （`proof` 不在 920 条核心词表里）**永远画不出下划线**，刷新也没用；
   * 2. 判据用 `UNSEEN`（查不到状态按"生词"）→ 整页词库词都被标成生词；
   * 3. 每次调用先整表清空 → 页面任何一处 DOM 变更都会抹掉全页下划线。
   */
  function annotateSubtree(node: Node): void {
    // ⚠️ 脏节点可能**本身就是文本节点**（`characterData` 变更时 MutationObserver
    // 给的就是它）。TreeWalker 不会把根节点当子节点返回，若照常走
    // `collectTextNodes`，这类变更会被静默忽略：文本被页面改写后，
    // 旧 Range 的偏移已经错了却留着不更新。因此这里显式处理文本节点。
    const textNodes = node.nodeType === 3 ? [node] : env.collectTextNodes(node);
    const nodeSpans: NodeSpans[] = [];

    for (const textNode of textNodes) {
      const text = env.readText(textNode);
      // 扫**全部**词形（不用词典过滤），逐个问"它在生词本里吗"。
      // 空文本与零候选也必须交给 annotate：它会据此 detach 这个节点的旧 Range。
      const spans = scanWords(text).filter((span) => env.underlineCount(span.text) !== undefined);
      nodeSpans.push({ node: textNode, spans });
    }

    if (nodeSpans.length === 0) return;
    paint(nodeSpans);
  }

  /** 把一批节点交给标注层（增量：只动这几个节点） */
  function paint(nodeSpans: NodeSpans[]): void {
    highlightSession.annotate(
      nodeSpans,
      (word) => {
        const meetCount = env.underlineCount(word);
        // 集合里没有 → 状态未知 → `shouldAnnotate` 会把它过滤掉
        return meetCount === undefined ? undefined : { status: 'new' as const, meetCount };
      },
      themeFromSettings(env.settings),
      env.settings.enabled,
    );
  }

  function annotateAll(): void {
    // 全量重扫：先整表清空（状态变更后"下划线消失"要靠这一步），再重扫
    highlightSession.clearAll();
    annotateSubtree(env.root());
  }

  /**
   * 后台回写权威状态后就地刷新当前卡片（FR-A5 ④段）。
   *
   * 只动**同一个词条**的卡片：回写的词与卡片上的词不一致时什么都不做
   * （用户可能已经划了另一个词，那张卡片正开着）。
   */
  /**
   * FR-A5 ④段：把后台拉回来的"首次日期 + 首条例句"补进当前卡片。
   *
   * 与 `applyState` 一样只动**同一个词条**的卡片（用户可能已经划了另一个词）。
   * 按**文本去重**合并：刚收藏那一次卡片上已经就地显示过本次采集的句子，
   * 后台回来的往往就是同一条，不能变成两行。
   */
  function applyDetail(word: string, detail: CardDetail | undefined): void {
    if (!detail) return;
    if (!currentCard || !env.popup.isVisible()) return;
    if (currentCard.head.lemma !== word) return;

    const seen = new Set(currentCard.examples.map((example) => example.text));
    const older = detail.examples.filter((example) => !seen.has(example.text));

    const next: CardModel = {
      ...currentCard,
      // 历史例句在前（它更早采集），本次刚采集的那条在后
      examples: [...older, ...currentCard.examples],
      meta: {
        ...currentCard.meta,
        firstSeenAt: detail.firstSeenAt ?? currentCard.meta.firstSeenAt,
      },
    };
    env.popup.update(next);
    currentCard = next;
  }

  function applyState(word: string, state: WordState): void {
    if (!currentCard || !env.popup.isVisible()) return;
    if (currentCard.head.lemma !== word) return;

    // FR-C1：这次划选中那句就地补进段四（不额外查库）。
    // 只显示"刚采集到的这一句"；历史例句的读取通道不属本轮，见
    // `changes/M2-example-capture.md` 的未决项。
    const scene = currentRecord && currentRecord.lemma === word ? currentRecord.scene : undefined;
    const examples = scene
      ? [
          { text: scene.text, source: displayDomain(scene.sourceUrl) || null, at: null },
          ...currentCard.examples.filter((example) => example.text !== scene.text),
        ]
      : currentCard.examples;

    const next: CardModel = {
      ...currentCard,
      examples,
      meta: {
        ...currentCard.meta,
        status: state.status,
        meetCount: state.meetCount,
        // 后台回写了状态 ⇒ 这个词**一定在生词本里**（未入库的词没有状态）
        inBook: true,
      },
    };
    env.popup.update(next);
    currentCard = next;
  }

  async function handleSelection(): Promise<CardModel | null> {
    if (!running) return null;

    const capture = captureSelection(env.getSelection());
    if (capture.ignored || capture.text === '') return null;

    // 同一段文本不重复处理（mouseup 与 selectionchange 两条路径可能都到，
    // 见 docs/reference/selection-and-range.md §5.3 的"两条路径需要共享去重键"）
    if (capture.text === lastHandled) return null;
    lastHandled = capture.text;

    // FR-C1：与选区**同一次事件**里捕获例句。捕获失败只是没有例句，
    // 不参与后面的任何一条判定（判词、状态、写库全都不看它）。
    // 外面再包一层 try：例句是**增益**，任何异常都不该让这次划词整体失败
    // （连弹窗都不出的话，用户连"查词"这件事都做不成了）。
    let scene: SceneCapture | null = null;
    try {
      scene = env.captureScene?.() ?? null;
    } catch {
      scene = null;
    }

    const result: QueryResult = await querySelectionAsync(
      capture.text,
      env.dict,
      {
        // FR-F9 的"最短词长"：设置页写着"短于该长度的选中词不处理"，
        // 这一关必须真的过——否则单字母的误选（拖选过程中的前缀）也会入库
        minLength: env.settings.minWordLength,
        // FR-A16 的「完整性」：切在词中间的选区不算选中了一个词
        before: capture.before,
        after: capture.after,
      },
      // FR-B7：内置分片未命中时，最后问一次导入词典。
      // 少了这个参数，导入词库那条分支永远走不到（用户划 constraint 显示未收录的根因）。
      env.lookupImported,
    );
    if (result.kind === 'rejected') return null;

    // 记账内容按 §2 数据模型组装：命中时键是**词条原形**（running → run），
    // 未收录时键是页面词形并标 isUnlisted（FR-B4：仍采集，导出时标记）
    const record: MeetRecord =
      result.kind === 'hit'
        ? {
            lemma: result.hit.entry.lemma,
            surface: result.surface,
            unlisted: false,
            inflectionOf: result.hit.inflectionOf?.lemma ?? null,
            dict: {
              phoneticUs: result.hit.entry.phoneticUs,
              pos: result.hit.entry.pos,
              defZh: result.hit.entry.defZh,
            },
          }
        : {
            // 记账键按 §2 的定义（规范原形、小写）归一；`surface` 保留页面原样
            lemma: normalizeForLookup(result.surface),
            surface: result.surface,
            unlisted: true,
            inflectionOf: null,
          };

    // FR-C1：把这次划词所在的句子挂到记账内容上。挂在 `record` 上而不是单独传参，
    // 是因为「加入生词本」与「已入库的词重复遇见」两条写库路径**都复用 currentRecord**，
    // 这样两条路自动都带上例句。
    if (scene) record.scene = scene;

    // 这个词已经在生词本里吗？——主操作三选一要用它，
    // 也决定"这次划词要不要 +1"（见下面的手动收藏口径）。
    //
    // 先用**后台下发的生词集合**即时判断（同步、零等待；生词本里状态为
    // new 的词都在集合里），只有"已掌握 / 忽略"的词不在集合里，
    // 才需要异步问一次（见下面的 ensureStates）。
    const pushedMeetCount = env.underlineCount(record.surface);
    const known =
      env.cachedState(record.lemma) ??
      (pushedMeetCount === undefined
        ? undefined
        : { status: 'new' as const, meetCount: pushedMeetCount });
    const inBook = known !== undefined;

    // FR-A17（手动收藏轮修订）：**未加入的词无论划多少次都不写库**——
    // 用户的原话是"不然会频繁的触发误点击加入生词"。只有当
    // ① 用户在设置里打开了"选中即入库"，或 ② 这个词已在生词本里（重复遇见要 +1）
    // 才写。
    if (env.settings.autoAddOnSelect === true || inBook) {
      env.recordMeet(record);
    } else {
      // 不在下发的生词集合里，也可能是"已掌握 / 忽略"的词——异步问一次，
      // 回来再更正卡片（否则会把已收藏的词显示成"尚未加入生词本"）
      void env.ensureStates([record.lemma]).then((fetched) => {
        if (!fetched) return;
        const state = env.cachedState(record.lemma);
        if (!state) return;
        env.recordMeet(record); // 已在生词本里：重复遇见 +1（FR-A17）
        applyState(record.lemma, state);
      });
    }

    const context = {
      meetCount: known?.meetCount ?? 0,
      firstSeenAt: null,
      examples: [],
      status: known?.status ?? 'new',
      inBook,
      canSpeak: env.canSpeak(),
    };

    const card =
      result.kind === 'hit'
        ? cardFromHit(result.surface, result.hit, context)
        : cardFromUnlisted(result.surface, context);

    const anchor = env.getSelectionRect();
    if (!anchor) return null;

    env.popup.show(card, anchor);
    currentCard = card;
    currentRecord = record;
    popupAnchorAt = env.getScroll();
    env.log('popup-shown', { surface: result.surface, kind: result.kind });

    // FR-A5 ④段：已在生词本里时补拉"首次日期 + 首条例句 + 来源域名"。
    // 只在这一种情况下拉一次：未入库的词没有例句，问了也是白问。
    // 失败（undefined）维持"例句尚未采集"的显示——不改状态、不关弹窗。
    if (inBook) {
      void env.fetchCard?.(record.lemma).then((detail) => applyDetail(record.lemma, detail));
    }
    return card;
  }

  /**
   * 处理卡片上的一个操作（FR-A6）。
   *
   * 规格把四条交互约定写得很死，这里逐条落实：
   * - 主操作按当前 `status` 二选一（按钮集合由 `visibleActions` 决定）
   * - **状态变更后弹窗不关闭**，主按钮**就地**切换文案（回到上面的 `new`/`known`）
   * - **忽略后弹窗关闭**，且该词下划线**即时消失**（FR-A10）
   * - 写失败（后台不可达）**不谎报成功**：卡片不变、弹窗不关
   *
   * 记账与改状态都按**词条原形**（`card.head.lemma`）：词库里的词条是 `run`，
   * 页面词形 `running` 只是它的一个变形，两者不能各记一条。
   */
  async function handleAction(action: CardAction, card: CardModel): Promise<void> {
    const word = card.head.lemma;

    switch (action) {
      case 'collect': {
        // FR-A6：**由用户显式点击**才把词收进生词本（默认不自动入库）。
        // 用当前卡片的记账内容（含命中时的音标/释义、或未收录标记）；
        // 回写后由 `applyState` 把卡片更新成"已加入"。
        if (!currentRecord || currentRecord.lemma !== word) return;
        env.recordMeet(currentRecord);
        env.log('word-collected', { word });
        return;
      }

      case 'mark-known':
      case 'mark-new': {
        const status: WordStatus = action === 'mark-known' ? 'known' : 'new';
        const state = await env.setStatus(word, status);
        if (!state) return;

        const next: CardModel = {
          ...card,
          meta: { ...card.meta, status: state.status, meetCount: state.meetCount },
        };
        // 弹窗保持打开，卡片就地重绘（便于误点后立刻改回）
        if (env.popup.isVisible()) env.popup.update(next);
        currentCard = next;
        // FR-A10：状态变更后下划线即时消失 / 恢复
        annotateAll();
        env.log('status-changed', { word, status: state.status });
        return;
      }

      case 'ignore': {
        const state = await env.setStatus(word, 'ignored');
        if (!state) return;
        // FR-A6：忽略后弹窗关闭，下划线即时消失
        closePopup();
        annotateAll();
        env.log('status-changed', { word, status: 'ignored' });
        return;
      }

      case 'speak':
        env.speak(word);
        return;

      case 'copy-definition':
        await env.copyText(definitionText(card));
        return;

      case 'llm-define': {
        if (card.defining) return;
        const pending: CardModel = { ...card, defining: true, definitionError: null };
        env.popup.update(pending);
        currentCard = pending;
        const result: WordDefinitionResult = env.defineWord
          ? await env.defineWord(word)
          : { error: '未配置 LLM 释义能力' };
        // 用户可能在等待期间划了另一个词或关了弹窗，不回写旧卡片。
        if (!currentCard || currentCard.head.lemma !== word || !env.popup.isVisible()) return;
        const next: CardModel = 'defZh' in result
          ? {
              ...pending,
              senses: result.defZh.map((def) => ({ pos: '', defZh: [def] })),
              defining: false,
              definitionError: null,
            }
          : { ...pending, defining: false, definitionError: result.error };
        env.popup.update(next);
        currentCard = next;
        return;
      }

      case 'open-manager':
        env.openManager();
        return;
    }
  }

  function closePopup(): void {
    if (!env.popup.isVisible()) return;
    env.popup.hide();
    popupAnchorAt = null;
    lastHandled = null;
    currentCard = null;
    currentRecord = null;
  }

  function onScroll(): void {
    if (!popupAnchorAt || !env.popup.isVisible()) return;
    const now = env.getScroll();
    // FR-A7：滚动超过 80px 关闭
    if (scrolledTooFar(popupAnchorAt.x, popupAnchorAt.y, now.x, now.y)) closePopup();
  }

  function onKeyDown(event: unknown): void {
    const e = event as { key?: string };
    // FR-A7：Esc 关闭
    if (e?.key === 'Escape') closePopup();
  }

  function onMouseDown(event: unknown): void {
    // 新的手势开始：撤掉"待补一次 selectionchange"的状态，
    // 免得上一次没等到的补等被这次手势里的选区变化误触发
    awaitingSelectionChange = false;
    // FR-A7：点击弹窗之外关闭。
    //
    // ⚠️ 判据必须是"事件是否落在弹窗宿主内"（`popup.containsEvent`），
    // **不能**拿 `composedPath()` 里的 DOM 节点去比 `env.popup` 这个门面对象：
    // 弹窗在 closed shadow root 内，内部点击冒泡到 document 时目标被重定向为宿主节点，
    // 拿节点比对象永远为假 —— 那样的后果是"点按钮 = 点外部"，按钮全部失效。
    if (env.popup.containsEvent(event)) return;
    closePopup();
  }

  /**
   * 松手：这才是"划词"的触发点（FR-A1）。
   *
   * 若此刻选区为空，**等一次 `selectionchange` 补齐**——部分浏览器在 `mouseup`
   * 时选区尚未落定（见 `docs/reference/selection-and-range.md` §5.3）。
   */
  function onMouseUp(): void {
    const sel = env.getSelection();
    if (!sel || sel.isCollapsed) {
      awaitingSelectionChange = true;
      return;
    }
    awaitingSelectionChange = false;
    void handleSelection();
  }

  /**
   * 选区变化：**只在"补等"状态下**才处理，且处理一次即撤。
   *
   * ⚠️ 这里曾经无条件处理任何非空选区，后果是**拖选过程中的每一个中间选区
   * 都被当成一次划词**：拖选 `proof` 时选区逐字符增长（`p`→`pr`→`pro`→`proo`→`proof`），
   * 每变一次派发一次 `selectionchange`，于是生词本里凭空多出 4 条前缀词。
   *
   * 规格口径（`PLAN.md` FR-A1）：`selectionchange` 只是 `mouseup` 的**补等**，
   * 不是第二条独立的触发源；"以先到者为准，不引入固定延时"。
   */
  function onSelectionChange(): void {
    if (!awaitingSelectionChange) return;
    const sel = env.getSelection();
    if (!sel || sel.isCollapsed) return;
    awaitingSelectionChange = false;
    void handleSelection();
  }

  return {
    async start() {
      // FR-A13 / FR-A14：不满足条件就什么都不做
      if (!shouldRunOn(env.settings, env.hostname, isBlacklisted)) {
        env.log('content-skipped', {
          enabled: env.settings.enabled,
          blacklisted: isBlacklisted(env.hostname, env.settings.blacklist ?? []),
        });
        return false;
      }

      await env.dict.warm();
      running = true;

      // FR-A6：把六个操作接上业务逻辑。
      // ⚠️ 这一步此前**根本不存在**：`setActionHandler` 从未被调用，
      // 于是弹窗上的六个按钮点了没有任何事情发生。
      env.popup.setActionHandler((action, card) => void handleAction(action, card));

      // FR-I3：语音可用性是**异步判定**的（等 `voiceschanged` 或超时）。
      // 判定结果变为"不可用"时，要把已经打开的卡片上的发音按钮收起来；
      // 这一步不能少，否则在无语音的机器上按钮会一直挂着但点了没反应。
      unbinds = [
        env.on('document', 'mouseup', onMouseUp, true),
        env.on('document', 'mousedown', onMouseDown, true),
        env.on('document', 'keydown', onKeyDown, true),
        env.on('window', 'scroll', onScroll, true),
        env.on('window', 'blur', () => closePopup(), true),
        // 选区在 mouseup 时可能尚未落定，补等一次（见调研 §5.3）；
        // ⚠️ 只在补等状态下生效，见 `onSelectionChange`
        env.on('document', 'selectionchange', onSelectionChange, true),
        // FR-I3：语音判定结果变化时刷新已打开的卡片（见上）
        env.onSpeechAvailable(() => {
          if (!currentCard || !env.popup.isVisible()) return;
          const next: CardModel = { ...currentCard, canSpeak: env.canSpeak() };
          env.popup.update(next);
          currentCard = next;
        }),
      ];

      observer = env.observe(env.root(), env.scheduler);
      annotateAll();
      env.log('content-started', { hostname: env.hostname });
      return true;
    },

    handleSelection,

    applyState,

    annotateAll,

    annotateSubtree,

    updateSettings(next) {
      env.settings = next;
      if (running) annotateAll();
    },

    closePopup,

    setSpeechRate(rate) {
      // 转交给注入的发音实现：控制器不持 `Speech` 对象，只持它的能力
      env.setSpeechRate(rate);
    },

    stop() {
      running = false;
      for (const unbind of unbinds) unbind();
      unbinds = [];
      observer?.disconnect();
      observer = null;
      env.scheduler.stop();
      highlightSession.clearAll();
      closePopup();
    },

    isRunning: () => running,
  };
}

/**
 * 取选区两端**紧邻的字符**（FR-A16 的「完整性」判定要用）。
 *
 * 取法与 `range.toString()` 同源：都从 Range 的起止点算，
 * 不另取一次选区（那时的选区可能已经被用户改掉）。
 *
 * ⚠️ **已知边界**：选区起点恰好落在文本节点开头（`startOffset === 0`）时，
 * `before` 取到空串，因此"跨节点切一半"（如 `<b>pro</b>of` 里选 `pro`）
 * 会被当成完整选择。这类 DOM 形态很少见，而**误伤**（把完整选择判成半截）
 * 的代价更高——宁可漏判这一种。
 */
/**
 * 取选区两端紧邻的字符，供 FR-A16 的「完整性」判定。
 *
 * ⚠️ 判定要看**选区自身**而不是只看端点外侧。
 *
 * 实测（用户反馈）：页面是 `an adventure story`，用户拖选成 `"adventure "`
 * （尾部多带一个空格）。`range.endOffset` 落在空格**之后**，
 * 直接取 `endText[range.endOffset]` 得到 `'s'`（story 的 s）→ 判成
 * "后面还紧挨着词字符" → 整次划词被拒。可用户明明选中了完整的词。
 *
 * 正确语义：**选区文本两端如果带着空白，说明用户划的是干净的词边界**——
 * 那两个空白的另一侧属于别的词，不能拿来判"切在词中间"。
 * 所以先看选区原文（`range.toString()`）两端有没有空白：
 * 有空白的那一端直接返回空串（边界干净），没有才取端点外侧那个字符。
 */
export function adjacentChars(range: Range): { before: string; after: string } {
  const textOf = (node: Node | null): string =>
    node && node.nodeType === 3 ? (node.textContent ?? '') : '';

  const startText = textOf(range.startContainer);
  const endText = textOf(range.endContainer);

  const selected = range.toString();
  const startsWithSpace = /^\s/.test(selected);
  const endsWithSpace = /\s$/.test(selected);

  const charBefore = range.startOffset > 0 ? (startText[range.startOffset - 1] ?? '') : '';
  const charAfter = endText[range.endOffset] ?? '';

  return {
    // 选区自身起点带空白 → 边界干净；否则看外侧字符（外侧是空白也算干净）
    before: startsWithSpace || /\s/.test(charBefore) ? '' : charBefore,
    after: endsWithSpace || /\s/.test(charAfter) ? '' : charAfter,
  };
}

/** 用真实浏览器 API 组装一个控制器（内容脚本入口调用） */
export function createBrowserController(
  settings: ContentSettings,
  dict: DictLookup,
  deps: {
    /** 同步读权威状态（未知返回 undefined）；**划词路径**用它取次数与状态 */
    cachedState(word: string): WordState | undefined;
    /** 页面上的词该不该标下划线（后台下发的生词集合，含词形还原） */
    underlineCount(word: string): number | undefined;
    /** 把一批词的状态拉进缓存；返回是否取到了东西（划词路径用） */
    ensureStates(words: readonly string[]): Promise<boolean>;
    recordMeet(record: MeetRecord): boolean;
    /** FR-A5 ④段：拉首次日期与首条例句（可选；不接就没有这段显示） */
    fetchCard?(word: string): Promise<CardDetail | undefined>;
    /**
     * FR-B7：内置分片未命中时问一次导入词典（可选）。
     * 入口把它接到 `MSG.fetchImported` 消息上；不接就没有导入词库查询。
     */
    lookupImported?: ImportedLookup;
    /** 改状态（内容脚本改不了扩展源的库，因此由入口注入经消息的实现） */
    setStatus(word: string, status: WordStatus): Promise<WordState | undefined>;
    /** 用户点击后生成未收录词的 LLM 释义（FR-B4）。 */
    defineWord?(word: string): Promise<WordDefinitionResult>;
    /** 打开管理台（要经后台 `tabs.create`，内容脚本打不开扩展页） */
    openManager(): void;
    /**
     * FR-L4：把一条诊断事件交给入口落库。
     *
     * 内容脚本写不了扩展源的日志表，因此入口把它经 `MSG.log` 发给后台。
     * 不注入时只打 console（单测与降级路径）。
     */
    log?(entry: { level: LogLevel; scope: string; message: string; detail?: unknown }): void;
  },
): Controller {
  const doc = document;

  const popup = createPopup(doc);
  const highlight = createBrowserHighlightEnv(doc);
  // FR-I2：语速来自设置（设置页可改；内容脚本收到 settings-changed 后
  // 调 `controller.setSpeechRate()`，下一次发音即生效，不需要重载页面）。
  // `safeRate` 兜底：设置可能被手改或旧版本写坏。
  const speech = createSpeech(createBrowserSpeechEnv(window), {
    rate: safeRate(settings.speechRate),
  });

  // 调度器的回调要调 controller.annotateSubtree，而 controller 还没造出来——
  // 用一层间接引用打破循环（回调真正执行时 controller 一定已赋值）
  let controller: Controller;
  const scheduler = createScheduler(createBrowserSchedulerEnv(window), (nodes) => {
    for (const node of nodes) controller.annotateSubtree(node);
  });

  controller = createController({
    settings,
    hostname: location.hostname,
    dict,
    popup,
    highlight,
    scheduler,
    // FR-B7：把"问一次导入词典"的能力透传到控制器
    ...(deps.lookupImported ? { lookupImported: deps.lookupImported } : {}),
    getSelection() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const { before, after } = adjacentChars(range);
      return {
        isCollapsed: sel.isCollapsed,
        text: range.toString(),
        anchorNode: sel.anchorNode,
        before,
        after,
      };
    },
    getSelectionRect() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      // 用 getClientRects 的首个矩形：getBoundingClientRect 跨行时会横跨两行（调研 §5.2）
      const rects = sel.getRangeAt(0).getClientRects();
      const rect = rects[0] ?? sel.getRangeAt(0).getBoundingClientRect();
      if (!rect) return null;
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
    },
    getScroll: () => ({ x: window.scrollX, y: window.scrollY }),
    collectTextNodes(root) {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          // 排除不该标注的区域：与选区触发（FR-A4）用**同一份清单**
          if (isBlockedByTag(parent.nodeName)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const out: Node[] = [];
      let current = walker.nextNode();
      while (current) {
        out.push(current);
        current = walker.nextNode();
      }
      return out;
    },
    readText: (node) => node.textContent ?? '',
    cachedState: deps.cachedState,
    underlineCount: deps.underlineCount,
    ensureStates: deps.ensureStates,
    recordMeet: deps.recordMeet,
    fetchCard: deps.fetchCard,
    // FR-C1：例句捕获在**装配点**接（与 popup / highlight / speech 同一处）——
    // 它是 DOM 能力，不属于纯逻辑控制器的 deps 接口，因此对外接口一行不改。
    // 捕获失败返回 null 只是没有例句，不影响查词、弹窗与收藏。
    captureScene: () =>
      captureSentenceScene(window.getSelection(), document, {
        url: window.location.href,
        title: document.title,
      }),
    setStatus: deps.setStatus,
    speak: (word) => speech.speak(word),
    canSpeak: () => speech.status() !== 'unavailable',
    onSpeechAvailable: (cb) => speech.onChange(() => cb()),
    setSpeechRate: (rate) => speech.setRate(rate),
    async copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // 剪贴板在失焦/无权限时会抛；这是可预期的失败，不该影响弹窗
        return false;
      }
    },
    ...(deps.defineWord ? { defineWord: deps.defineWord } : {}),
    openManager: deps.openManager,
    observe: (target, scheduler) => observeMutations(target, scheduler),
    root: () => doc.body ?? doc.documentElement,
    on(target, event, handler, capture) {
      const t: EventTarget = target === 'document' ? doc : window;
      t.addEventListener(event, handler as EventListener, capture);
      return () => t.removeEventListener(event, handler as EventListener, capture);
    },
    log(event, detail) {
      // 诊断日志走 console：调试时不必开扩展页就能看到
      console.debug('[leximate]', event, detail ?? '');
      // FR-L4：同时交给入口落库（内容脚本读不到扩展源的日志表）
      deps.log?.({ level: contentLogLevel(event), scope: 'content', message: event, detail });
    },
  });

  return controller;
}
