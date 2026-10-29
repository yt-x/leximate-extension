/**
 * 后台 Service Worker —— 扩展的**数据持有者**。
 *
 * 约束（PLAN.md §4.2）：MV3 中会被随时回收，本文件只做事件注册，不放常驻状态。
 *
 * ⚠️ 架构要点（PLAN.md §4.5 P3）：**内容脚本读不到扩展源的存储**——
 * 内容脚本里的 Web 存储 API 访问的是宿主页面源（官方原文见
 * `docs/reference/extension-storage-and-messaging.md` §1）。
 * 因此词状态与设置的权威副本都在这里，内容脚本通过消息读写。
 *
 * 本文件只做**事件接线**，业务逻辑在各 `utils/` 模块里（都有单测）：
 * - 角标文案 `utils/badge/badge.ts`、刷新编排 `utils/badge/sync.ts`
 * - 内容脚本消息处理 `utils/content/message-handler.ts`
 * - 后台 → 内容脚本投递 `utils/content/broadcast.ts`
 */
import { countWords } from '@/utils/db/words';
import { getMeta, getSettings, setMeta } from '@/utils/db/kv';
import { writeLog } from '@/utils/diag';
import { createBadgeSync, type BadgeEnv } from '@/utils/badge/sync';
import { createWordStateStore } from '@/utils/content/word-state';
import { getSceneById } from '@/utils/db/words';
import { handleContentMessage } from '@/utils/content/message-handler';
import { lookupImported } from '@/utils/dict/imported-lookup';
import { broadcastToTabs } from '@/utils/content/broadcast';
import { onSettingsWritten } from '@/utils/settings-bus';
import { MSG, type SettingsChangedNotice } from '@/utils/content/messages';
import { toContentSettings } from '@/utils/content/content-settings';
import { runTranslatePass } from '@/utils/translate/assembly';
import { defineUnlistedWord } from '@/utils/translate/define-word';
import { enqueueSceneForTranslation } from '@/utils/translate/enqueue';
import { runSync, scheduleSyncAfterChange } from '@/utils/sync/assembly';

/**
 * 诊断日志的落点（FR-L4）。
 *
 * 本地日志本身不该成为故障源：写失败只 `console.warn`，不往上抛——
 * 在 Service Worker 里，未捕获的拒绝会污染整条事件链。
 */
function log(entry: {
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  detail?: unknown;
}): void {
  void writeLog(entry).catch((error: unknown) => {
    console.warn('[leximate] 写诊断日志失败', error);
  });
}

/**
 * 把编排层要的浏览器能力接上真实实现。
 *
 * `setBadge(null)` 落到 API 上是**空字符串**——Chrome 文档明确"传入空字符串即清除角标"。
 * 这个映射只在实现里出现一次（见 `docs/reference/action-badge.md`）。
 */
function createBrowserBadgeEnv(): BadgeEnv {
  return {
    getSettings: async () => {
      const settings = await getSettings();
      return { enabled: settings.enabled };
    },
    countWords: () => countWords(),
    setBadge: async (text) => {
      // 不传 tabId ⇒ 全局角标（文档："tabId 省略时视为全局设置"）
      await browser.action.setBadgeText({ text: text ?? '' });
    },
  };
}

export default defineBackground(() => {
  /** 打开管理台新标签页（扩展图标点击与 FR-A6 的"打开管理台"共用） */
  const openManagerTab = () => browser.tabs.create({ url: browser.runtime.getURL('/manager.html') });

  // 未定义 popup，因此点击扩展图标走这里：打开管理台标签页。
  browser.action.onClicked.addListener(() => {
    void openManagerTab();
  });

  // 词状态的真值在这一个 store 里（扩展源），内容脚本只能经消息访问。
  // 放模块作用域（而非每个请求新建）是为了让内存缓存跨请求生效——
  // 后台被回收时缓存自然消失，重建后从 IndexedDB 恢复，符合 MV3 的可重入要求。
  const store = createWordStateStore();

  // ── 翻译（FR-D1 ~ FR-D7）────────────────────────────────────────
  /**
   * 跑一轮翻译。**所有网络请求只在这里发生**（内容脚本零网络，PLAN.md §4.2）。
   *
   * 三重门禁都在 `runTranslatePass` 里：告知未确认 / 配置不完整 / 今日额度用尽，
   * 任一成立就一条请求都不发。这里只负责"什么时候叫它"。
   */
  const runTranslate = () => {
    void runTranslatePass({
      getSettings: () => getSettings(),
      getMeta: () => getMeta(),
      setMeta: (patch) => setMeta(patch),
      getSceneText: async (sceneId) => {
        const scene = await getSceneById(sceneId);
        return scene?.text;
      },
      getTranslator: () => (globalThis as { Translator?: unknown }).Translator as never,
      log: (entry) => {
        log({ level: entry.level, scope: 'translation', message: entry.message, detail: entry.detail });
      },
    })
      .then((summary) => {
        if (summary.translated > 0) {
          log({
            level: 'info',
            scope: 'translation',
            message: '翻译完成',
            detail: summary,
          });
        }
      })
      .catch((error: unknown) => {
        // 翻译是后台增益功能：挂了不该影响划词与角标
        log({
          level: 'warn',
          scope: 'translation',
          message: '翻译轮次失败',
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      });
  };

  // ── 同步（FR-H1 ~ FR-H7）────────────────────────────────────────
  /**
   * 定时同步（FR-H4）。用 alarms 而不是 setInterval：MV3 的 worker 会被回收，
   * 只有 alarms 能在回收后把 worker 叫起来。
   */
  const SYNC_ALARM = 'leximate-sync';
  const refreshSyncAlarm = async () => {
    const { webdav } = await getSettings();
    browser.alarms?.create(SYNC_ALARM, {
      periodInMinutes: webdav?.syncIntervalMinutes ?? 15,
    });
  };
  void refreshSyncAlarm();
  browser.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM) return;
    void runSync('alarm', syncDeps());
  });

  // ── 角标（FR-A14）───────────────────────────────────────────────
  const badge = createBadgeSync(createBrowserBadgeEnv());

  /**
   * 刷新角标，失败只记日志不上抛。
   *
   * 角标是**装饰性**信息，它挂掉不该影响扩展的其它职责；而 worker 里
   * 未捕获的 Promise 拒绝会污染整条事件链。
   */
  const refreshBadge = () => {
    void badge.sync().catch((error: unknown) => {
      console.warn('[leximate] 角标刷新失败', error);
      // FR-L4：这类"失败"正是诊断页要看的东西（用户只会看到角标不动）
      log({
        level: 'warn',
        scope: 'badge',
        message: '角标刷新失败',
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
    });
  };

  /**
   * 广播"词库变了"（FR-A9 / FR-F2）。**两个方向都要发**，收件人不同：
   *
   * | 收件人 | API | 为什么 |
   * |---|---|---|
   * | **扩展页面**（管理台） | `runtime.sendMessage` | 让它重读库（词库是内容脚本写进去的，它不会知道） |
   * | **内容脚本** | `tabs.sendMessage`（逐标签页） | 让它重拉**生词集合**并重扫下划线；`runtime.sendMessage` **到不了**内容脚本 |
   *
   * 没有收件人时两边都会拒绝（"Could not establish connection" / 未注入的页面），
   * 那是**正常噪声**，吞掉即可。
   */
  const broadcastWordsChanged = () => {
    void browser.runtime.sendMessage({ type: MSG.wordsChanged }).catch(() => {});

    void broadcastToTabs(
      { type: MSG.wordsChanged },
      {
        listTabIds: async () => {
          const tabs = await browser.tabs.query({});
          return tabs.map((tab) => tab.id).filter((id): id is number => typeof id === 'number');
        },
        sendToTab: async (tabId, payload) => {
          await browser.tabs.sendMessage(tabId, payload);
          return true;
        },
      },
    );
  };

  /** 同步的日志与写回刷新依赖；alarm / manual / change 共用。 */
  const syncDeps = () => ({
    log: (entry: { level: 'info' | 'warn'; message: string; detail?: unknown }) =>
      log({ level: entry.level, scope: 'sync', message: entry.message, detail: entry.detail }),
    onDataChanged: () => {
      store.clear();
      refreshBadge();
      broadcastWordsChanged();
    },
  });

  /** 向全部内容脚本下发最新的无秘密设置。 */
  const broadcastSettingsChanged = async () => {
    const notice: SettingsChangedNotice = {
      type: MSG.settingsChanged,
      settings: toContentSettings(await getSettings()),
    };
    await broadcastToTabs(notice, {
      listTabIds: async () => {
        const tabs = await browser.tabs.query({});
        return tabs.map((tab) => tab.id).filter((id): id is number => typeof id === 'number');
      },
      sendToTab: async (tabId, payload) => {
        await browser.tabs.sendMessage(tabId, payload);
        return true;
      },
    });
  };

  // ── 消息（内容脚本 / 管理台 → 后台）─────────────────────────────
  browser.runtime.onMessage.addListener((message: unknown) => {
    // 管理台的「立即同步」（FR-H6 的手动重试）。这条走 runtime 消息而不是页面直连：
    // 网络请求只能从后台发出，页面只管展示结果。
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'leximate:sync-now') {
      return runSync('manual', syncDeps()).then((outcome) => {
        if (outcome === null) return { ok: false, message: '同步未启动（未配置或正在运行）' };
        if (outcome.status === 'ok') return { ok: true };
        if (outcome.status === 'remote-broken') return { ok: false, message: outcome.reason };
        return { ok: false, message: outcome.error };
      });
    }
    // 必须返回 Promise 才能异步回复；返回 undefined 表示"这条不归我管"。
    // 注意：listener 抛错会在 Chrome 146+ 拒绝发送方的 Promise，
    // 因此 handleContentMessage 内部对各分支的畸形输入都不抛错。
    return handleContentMessage(message, {
      store,
      getSettings: () => getSettings(),
      defineWord: (word) => defineUnlistedWord(word, { getSettings, getMeta }),
      openManager: () => void openManagerTab(),
      // ⚠️ 词数一变就要重算角标：旧实现只在"设置写入 / SW 启动 / 安装"时刷新，
      // 于是划词收藏后角标不涨、管理台删词后角标不掉（见 message-handler.ts）
      refreshBadge,
      // 同时告诉已打开的管理台重读库，否则它显示的还是旧列表
      onWordsChanged: broadcastWordsChanged,
      onSettingsChanged: () => {
        void Promise.all([broadcastSettingsChanged(), refreshSyncAlarm()]).catch((error: unknown) => {
          console.warn('[leximate] 设置变更广播失败', error);
        });
      },
      onSyncRequested: () => scheduleSyncAfterChange(syncDeps()),
      // FR-L4：内容脚本的日志落在这里（它读不到扩展源的日志表）
      writeLog: (entry) => writeLog(entry),
      // FR-B7：内置分片未命中时，内容脚本问一次"导入词典里有没有"。
      // 查的是 `dict` store（纯词典），与生词本无关。
      lookupImported: async (word) => {
        const hit = await lookupImported(word);
        if (!hit) return null;
        return {
          lemma: hit.entry.lemma,
          hint: hit.hint,
          word: {
            phoneticUs: hit.entry.phoneticUs,
            pos: hit.entry.pos,
            defZh: hit.entry.defZh,
            fallbackDef: [],
            examTags: hit.entry.examTags,
          },
        };
      },
      /**
       * 读随包词表文件（`dict/` 下的白名单文件）。
       *
       * **为什么由后台读**：内容脚本直接 `fetch(getURL(...))` 时请求来源是页面源，
       * 会被严格 CSP 的站点拦（实测 YouTube 报 "Unsafe attempt to load URL …"，
       * 整份词库加载失败）。后台是扩展源，读自己的包不受页面 CSP 约束。
       * 文件名白名单在 `message-handler.ts::isAllowedDictFile` 校验，这里只管读。
       */
      readDictFile: async (file) => {
        try {
          const url = (browser.runtime.getURL as (p: string) => string)(`dict/${file}`);
          const response = await fetch(url);
          if (!response.ok) return null;
          return await response.text();
        } catch {
          return null;
        }
      },
      // FR-D1 / FR-D6：刚入库的例句送进翻译队列，然后立刻跑一轮。
      // 入队本身不发请求（内容脚本仍零网络），请求在 runTranslate 里发生。
      onMeetRecorded: (info) => {
        if (!info.sceneText) return;
        void enqueueSceneForTranslation({
          wordId: info.lemma,
          sceneId: info.sceneId,
          sceneText: info.sceneText,
          targetLang: 'zh-CN',
        })
          .then((outcome) => {
            if (outcome.enqueued) runTranslate();
          })
          .catch(() => {
            // 入队失败不连累入库：翻译是增益功能
          });
      },
    }).then((result) => (result.handled ? result.response : undefined));
  });

  // ⚠️ MV3 关键点：Service Worker 会被回收，事件监听之外的路径在重启后不会走。
  // 角标状态按 W3C #424 属 "session only"，浏览器重启即清除，
  // 所以每次 worker 醒来都要重算一次（见 `docs/reference/action-badge.md` §5）。
  refreshBadge();

  browser.runtime.onStartup.addListener(refreshBadge);

  // Service Worker 醒来时补跑一轮：MV3 会被回收，靠定时器不可靠，
  // "每次醒来跑一次" 才是这个平台能给的保证（与角标重算同一理由）
  runTranslate();

  /**
   * FR-L4：安装与更新要留痕。
   *
   * 这是"用户说某天之后就不对劲了"唯一能对上时间的事件——
   * 安装/更新会重新注册内容脚本、清掉 Service Worker 的进程内缓存。
   */
  browser.runtime.onInstalled.addListener((details) => {
    log({
      level: 'info',
      scope: 'install',
      message: details?.reason === 'update' ? '扩展已更新' : '扩展已安装',
      detail: { reason: details?.reason ?? 'unknown', version: browser.runtime.getManifest().version },
    });
    refreshBadge();
  });

  log({
    level: 'debug',
    scope: 'background',
    message: 'Service Worker 启动',
    detail: { version: browser.runtime.getManifest().version },
  });

  /**
   * 设置变化时：刷新角标 + **逐个标签页**通知内容脚本（FR-A14 热应用）。
   *
   * ⚠️ 这里**不能**用 `runtime.sendMessage`：官方明确
   * "extensions cannot send messages to content scripts using this method"，
   * 必须 `tabs.sendMessage`（见 `docs/reference/extension-storage-and-messaging.md` §2）。
   */
  onSettingsWritten(() => {
    refreshBadge();
    void Promise.all([broadcastSettingsChanged(), refreshSyncAlarm()]).catch((error: unknown) => {
      console.warn('[leximate] 设置变更广播失败', error);
    });
  });
});
