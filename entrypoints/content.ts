/**
 * 内容脚本入口。
 *
 * 硬约束（PLAN.md §4.2、FR-K1）：本文件及其依赖**不得发出任何网络请求**。
 * 解释、音标、生词比对全部来自本地；联网能力只在用户显式启用、且发生在后台/管理台。
 *
 * ⚠️ **本文件不得直接访问 IndexedDB / localStorage / chrome.storage。**
 * 内容脚本里的 Web 存储 API 访问的是**宿主页面源**，不是扩展源——
 * 官方原文（见 `docs/reference/extension-storage-and-messaging.md` §1）：
 *
 * > In content scripts, calling web storage APIs accesses data from the host page
 * > the content script is injected on and not the extension.
 *
 * 之前的版本直接调用 `getSettings()` 与 `createWordStateStore()`（都走 IndexedDB），
 * 结果是与后台各写一个同名但互不可见的库。现在一切数据都经消息向后台要
 * （`utils/content/gateway.ts`）。**词表产物不受影响**：它是随包投递的静态资源，
 * 用 `fetch(runtime.getURL(...))` 读取，读的是扩展自身资源。
 *
 * 逻辑全在 `utils/content/` 下，各层都有单测；这里只做**组装与生命周期**。
 */
import { createContentDictLookup } from '@/utils/dict/browser';
import { DEFAULT_SETTINGS } from '@/utils/db/defaults';
import { createBrowserController } from '@/utils/content/controller';
import { createMeetCounter } from '@/utils/content/meet-counter';
import { createWordStateCache } from '@/utils/content/word-state-cache';
import { createMessagingGateway, fetchSettings } from '@/utils/content/gateway';
import { normalizeForLookup } from '@/utils/content/word';
import { planSettingsChange, shouldRunOn } from '@/utils/content/settings-bridge';
import { toContentSettings, type ContentSettings } from '@/utils/content/content-settings';
import { isBlacklisted } from '@/utils/content/blacklist';
import { MSG, MAX_FETCH_WORDS, type ContentRequest, type SettingsChangedNotice } from '@/utils/content/messages';

export default defineContentScript({
  // PLAN.md §4.6：全站注入，document_idle，不注入 iframe。
  matches: ['*://*/*'],
  runAt: 'document_idle',
  allFrames: false,
  async main() {
    /** 内容脚本 → 后台的唯一通道 */
    const sendToBackground = (request: ContentRequest): Promise<unknown> =>
      browser.runtime.sendMessage(request);

    const gateway = createMessagingGateway({ sendToBackground });

    // ⚠️ 后台可能正在冷启动或暂时不可达，`fetchSettings` 失败回 `undefined`。
    // 此时用 DEFAULT_SETTINGS 继续——不能因为一次消息失败就整个不工作
    // （这也是 `getSettings` 在后台侧与默认值合并的同一口径）。
    const remote = await fetchSettings({ sendToBackground });
    const settings: ContentSettings = {
      ...toContentSettings(DEFAULT_SETTINGS),
      ...toContentSettings(remote),
    };

    // ⚠️ **不能在这里直接 fetch(`dict/*`)**：内容脚本发起的请求来源是页面源，
    // 会被页面的 CSP / 安全策略拦。实测 2026-10-23 在 YouTube 上直接 fetch 报
    // `Unsafe attempt to load URL chrome-extension://…/dict/… from frame with URL https://www.youtube.com/`，
    // 整份词库加载失败（`web_accessible_resources` 不能豁免页面 CSP）。
    // 因此改为经后台消息读文本——后台是扩展源，读自己的包不受页面 CSP 约束。
    //
    // 词库装配（清单 + 变形索引 + 查询器）抽在 `utils/dict/browser.ts`：
    // 管理台的导入器要判断"哪些词未收录"，用的是同一套，避免两边分叉。
    // 分片的实际拉取仍在 `controller.start()` 里 warm（时机由调用方决定）。
    const dict = await createContentDictLookup((file) =>
      browser.runtime.sendMessage({ type: MSG.readDictFile, file }),
    );

    /**
     * FR-L4：诊断日志的落点。
     *
     * 内容脚本读不到扩展源的日志表，因此这里经 `MSG.log` 交给后台写。
     * 单向通知，失败静默（诊断不该影响页面行为）；`catch` 是必须的——
     * 没有接收方时 `sendMessage` 会拒绝，而那时抛出会污染调用点。
     */
    const logToBackground = (entry: {
      level: 'debug' | 'info' | 'warn' | 'error';
      scope: string;
      message: string;
      detail?: unknown;
    }): void => {
      try {
        void Promise.resolve(browser.runtime.sendMessage({ type: MSG.log, ...entry })).catch(() => {});
      } catch {
        // ⚠️ 扩展上下文失效时（开发期重载/更新后，旧内容脚本还挂在页面上）
        // sendMessage 是**同步抛出** Extension context invalidated，不是返回被拒的 Promise——
        // 少了这层 try，日志调用会在异步调用点变成 "Uncaught (in promise)" 噪声
        // （实测反馈：跑 FR-A1 探针时控制台出现该报错）。
      }
    };

    // 词状态**只有缓存**：真值在后台（扩展源）。标注路径同步读缓存（FR-A12），
    // 消息只在启动与写入时发生。
    const stateCache = createWordStateCache();
    const meets = createMeetCounter();

    /**
     * 已经问过后台的词。
     *
     * ⚠️ 必须自己记：后台只回**已入库**的词（`getMany` 的口径），
     * 页面上绝大多数词都不在生词本里，因此"问过但没回"是常态。
     * 不记的话每次标注（以及页面每一次 DOM 变更触发的增量标注）都会再问一遍，
     * 变成消息风暴。
     */
    const asked = new Set<string>();

    /**
     * 把一批词的权威状态拉进缓存（FR-A9：下划线只标**生词本里**的词）。
     *
     * 分批走 `MAX_FETCH_WORDS`：后台对单次请求的词数有上限，
     * 一次长页面可能扫出几百个词库词。
     *
     * 返回"是否真的取到了东西"——控制器据此决定要不要重新标注那一批节点。
     */
    const ensureStates = async (words: readonly string[]): Promise<boolean> => {
      const wanted = [...new Set(words.map((word) => word.trim().toLowerCase()))].filter(
        (word) => word !== '' && stateCache.get(word) === undefined && !asked.has(word),
      );
      if (wanted.length === 0) return false;
      for (const word of wanted) asked.add(word);

      let fetched = 0;
      for (let i = 0; i < wanted.length; i += MAX_FETCH_WORDS) {
        const chunk = wanted.slice(i, i + MAX_FETCH_WORDS);
        const states = await gateway.fetchStates(chunk);
        for (const { word, state } of states) {
          stateCache.set(word, state);
          fetched += 1;
        }
      }
      return fetched > 0;
    };

    /**
     * **下划线集合**：后台下发的生词表（词条原形 → 遇见次数），PLAN §4.5 P3。
     *
     * 为什么必须有它：标注的判据是"这个词在我生词本里、且是生词"，而
     * ①**页面词形常与词条原形不同**（`running` vs `run`）——逐词去问后台，
     * 问 `running` 是查不到 `run` 那条记录的；
     * ②**被收藏的词可能是词表未收录的**（`proof` 不在 920 条核心词表里）——
     * 用"词典里有没有"来圈候选，它就直接被排除在标注之外（实测过的失败形态）。
     *
     * 集合只含**原形 + 次数**（不含释义/音标），因此不是"把词库整体外流"。
     */
    let newWords = new Map<string, number>();

    /** 拉一次完整的生词集合；返回是否成功 */
    const refreshNewWords = async (): Promise<boolean> => {
      const entries = await gateway.fetchNewWords();
      if (entries === undefined) return false;
      const next = new Map<string, number>();
      for (const { word, meetCount } of entries) {
        const key = word.trim().toLowerCase();
        if (key !== '') next.set(key, meetCount);
      }
      newWords = next;
      return true;
    };

    /**
     * 页面上的这个词该不该标下划线（FR-A9）。
     *
     * 词形还原在这里做：页面 `running` → 词条 `run`；未收录的词（`proof`）
     * 查表落空，就按它自己的原形去集合里找——两条路都必须通。
     */
    const underlineCount = (word: string): number | undefined => {
      const key = normalizeForLookup(word);
      const direct = newWords.get(key);
      if (direct !== undefined) return direct;

      const hit = dict.lookup(word);
      return hit ? newWords.get(hit.entry.lemma) : undefined;
    };

    const controller = createBrowserController(settings, dict, {
      // 唯一的状态读法：未命中 = 不在生词本里（区分"未收藏"与"是生词"）
      cachedState: (word) => stateCache.get(word),
      underlineCount,
      ensureStates,
      recordMeet: (record) => {
        // FR-A17：同一标签页内 30 秒内对同一词重复触发只计一次。
        // 去抖按**记账键（词条原形）**判定——`running` 与 `run` 是同一个词。
        // 落库交给后台（经消息）。
        if (!meets.hit(record.lemma, Date.now())) return false;
        void gateway.recordMeet(record).then((state) => {
          // 后台回写权威状态后再更新缓存，保证本地不会与真值长期分叉
          if (!state) return;
          stateCache.set(record.lemma, state);
          // 同步更新下划线集合（不等下一次下发）：生词 → 立刻可标；
          // 已掌握/忽略 → 立刻撤掉下划线
          if (state.status === 'new') newWords.set(record.lemma, state.meetCount);
          else newWords.delete(record.lemma);
          // 重扫一遍让它立刻带上下划线（FR-A9 的"用下划线提醒重复遇见"）
          controller.annotateAll();
          // 卡片上"首次记录 / 遇见 N 次"随即变成真实数字——
          // 否则用户看不见"它已经被记进生词本了"（实测反馈过）
          controller.applyState(record.lemma, state);
        });
        return true;
      },
      // FR-A6：改状态走消息；后台回写权威状态后更新本地缓存与下划线集合，
      // 这样紧接着的重新标注（下划线消失/恢复）读到的就是新状态
      setStatus: async (word, status) => {
        const state = await gateway.setStatus(word, status);
        if (state) {
          stateCache.set(word, state);
          if (state.status === 'new') newWords.set(word, state.meetCount);
          else newWords.delete(word);
        }
        return state;
      },
      // FR-A5 ④段：拉首次日期与首条例句（只在词已在生词本里时被调用）
      fetchCard: (word) => gateway.fetchCard?.(word) ?? Promise.resolve(undefined),
      // FR-B7：内置分片未命中时问一次导入词典（词典与生词本分表，见 decisions/0031）
      lookupImported: (word) => gateway.fetchImported?.(word) ?? Promise.resolve(null),
      // FR-B4：只有用户点「LLM 释义」才会经后台调用所配服务。
      defineWord: (word) => gateway.defineWord(word),
      // FR-A6：内容脚本打不开扩展页，请后台开
      openManager: () => void gateway.openManager(),
      // FR-L4：诊断事件交后台落库
      log: logToBackground,
    });

    // **先把生词集合拉下来再启动**：标注判据完全依赖它，
    // 没有它 `annotateAll()` 会一条下划线都画不出来。
    await refreshNewWords();

    // FR-F11：词库载入耗时可见。显式先 warm 一次并计时——controller.start() 里也会 warm，
    // 但那时已经是空操作；这样"词库载入耗时"与"首次标注耗时"不会混成一个数字。
    const warmStarted = performance.now();
    try {
      await dict.warm();
    } catch {
      // 载入失败不让入口早退：start() 会再试，失败时它返回 false
    }
    const dictWarmMs = performance.now() - warmStarted;

    /**
     * 让状态缓存失效并允许重新问后台。
     *
     * 时机：设置恢复标注前——管理台可能刚改过状态，旧缓存会让下划线画错。
     */
    const invalidateStates = (): void => {
      stateCache.clear();
      asked.clear();
    };

    // 后台 → 内容脚本的通知。
    // ⚠️ 这个方向后台必须用 `tabs.sendMessage` 投递，`runtime.sendMessage` 到不了
    // （官方原文见 `docs/reference/extension-storage-and-messaging.md` §2）。
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (typeof message !== 'object' || message === null) return undefined;
      const type = (message as { type?: unknown }).type;

      // ① 词库在别处变了（管理台删词/改状态/清空）→ 重拉集合 + 重扫
      if (type === MSG.wordsChanged) {
        void (async () => {
          if (!(await refreshNewWords())) return;
          invalidateStates();
          if (controller.isRunning()) controller.annotateAll();
        })();
        return undefined;
      }

      if (type !== MSG.settingsChanged) return undefined;

      const notice = message as SettingsChangedNotice;
      void (async () => {
        const next: ContentSettings = {
          ...toContentSettings(DEFAULT_SETTINGS),
          ...toContentSettings(notice.settings),
        };

        const running = controller.isRunning();
        const allowedOnSite = shouldRunOn(next, window.location.hostname, isBlacklisted);
        // FR-A14 的开关联动 + FR-I2 的语速：判定抽在 `planSettingsChange` 里
        // （入口是副作用模块、没有单测，纯函数那一层有）
        const plan = planSettingsChange(running, next, allowedOnSite);

        // 新设置必须先替换启动时的快照，否则 start/stop、最短词长和自动入库
        // 仍按旧值执行；运行中的样式与最短词长也据此立即重扫。
        controller.updateSettings(next);

        // FR-I2：语速可在设置页改，**下一次发音即生效、不需要重载页面**。
        // 在开关分支之前：即便当前是"已关闭"状态也要把新语速记下来，
        // 免得重新打开后第一次发音还用旧值。
        controller.setSpeechRate(plan.speechRate);

        if (plan.stop) {
          // 关闭：立刻清标注并解绑事件（FR-A14）
          controller.stop();
        } else if (plan.start) {
          // 恢复：状态可能已被管理台改动（比如刚点了"已掌握"），
          // 先让缓存与生词集合作废，避免用旧状态重新标注
          invalidateStates();
          await refreshNewWords();
          await controller.start();
        }
      })();

      // 单向通知，不回复（返回 undefined）
      return undefined;
    });

    // 监听已注册后才启动。初始 OFF / 黑名单命中时 start 返回 false，
    // 但页面仍保留消息监听，之后无需刷新即可恢复。
    const started = await controller.start();
    if (started) {
      logToBackground({
        level: 'info',
        scope: 'dict',
        message: '词库就绪',
        detail: {
          version: dict.dictVersion(),
          entries: dict.entryCount(),
          shards: dict.loadedShards(),
          elapsedMs: dictWarmMs,
        },
      });
    }
  },
});
