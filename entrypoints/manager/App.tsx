/**
 * 管理台外壳（PLAN.md FR-F1、FR-F9）。
 *
 * FR-F1：点扩展图标打开本页（`background.ts` 的 `action.onClicked`），不弹 popup。
 *
 * 分页用 tab 而不是路由：只有两页，引 router 是纯负担，
 * 且切页时列表组件会卸载、丢失滚动位置与筛选（FR-F7 明确不许丢）。
 * 这里让两个页面都挂载、用 `hidden` 切换，列表状态因此天然保持。
 */
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { isWordsChangedNotice } from '@/utils/content/messages';
import { readDataHealth, type DataHealth } from '@/utils/db/maintenance';
import { backupReminder, backupReminderText } from '@/utils/manager/backup-health';
import { notifyWordsChanged, onWordsChanged } from '@/utils/manager/words-bus';
import { WordList } from './WordList';
import { SettingsPage } from './SettingsPage';
import { DiagnosticsPage } from './DiagnosticsPage';
import { styles } from './styles';
import { Onboarding } from './Onboarding';
import { shouldShowOnboarding } from '@/utils/manager/onboarding';
import { getMeta, getSettings, setMeta } from '@/utils/db/kv';
import { resolveLocale, setLocale, t, tx } from '@/utils/i18n';

type Tab = 'words' | 'settings' | 'diag';

export default function App() {
  const [tab, setTab] = useState<Tab>('words');
  const version = browser.runtime.getManifest().version;

  /**
   * FR-L6：备份提醒要看的两个事实（上次导出时间、最近一次数据变化）。
   *
   * 数据变了就重算（订阅同上下文的总线）：导入或收藏之后提醒可能刚好该出现/该消失。
   */
  const [health, setHealth] = useState<DataHealth | null>(null);
  const [reminderDismissed, setReminderDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void readDataHealth()
        .then((next) => {
          if (alive) setHealth(next);
        })
        .catch(() => {
          // 读不到健康信息不该影响管理台：提示条不显示即可
        });
    };
    load();
    return onWordsChanged(load);
  }, []);

  /**
   * FR-F10：首装引导只在没看过时显示一次。
   *
   * 读不到 meta 就不显示——宁可不引导，也不要在页面上闪一下再消失。
   * 点「知道了」先关面板再写库：写失败下次还会出现，这比"关不掉"好。
   */
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void getMeta()
      .then((meta) => {
        if (alive) setOnboardingOpen(shouldShowOnboarding(meta));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /**
   * FR-L1：界面语言（只管管理台，弹窗不参与）。
   *
   * 解析顺序：设置里的 `ui.language`（默认 `auto`）→ 浏览器语言 → 中文兜底。
   * `t()` 读的是模块级当前语言，所以这里切换后必须让 App 重渲染一次，
   * 子组件才会用新语言重新取文案（它们没有 memo，跟着父组件重渲染）。
   */
  const [, setLocaleTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void getSettings()
      .then((settings) => {
        if (!alive) return;
        setLocale(resolveLocale(settings.ui.language, browser.i18n.getUILanguage()));
        setLocaleTick((n) => n + 1);
      })
      .catch(() => {
        // 读不到设置就用默认（中文）：语言不该阻塞界面渲染
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 设置页改完语言后调它：模块状态 + 重渲染一起更新 */
  const applyLocale = (language: Parameters<typeof resolveLocale>[0]): void => {
    setLocale(resolveLocale(language, browser.i18n.getUILanguage()));
    setLocaleTick((n) => n + 1);
  };

  const dismissOnboarding = () => {
    setOnboardingOpen(false);
    void setMeta({ onboardingDoneAt: Date.now() }).catch(() => {});
  };

  /**
   * 后台广播"词库变了"时重读库（FR-F2）。
   *
   * 为什么需要：内容脚本在网页上划词写入的是**扩展源**的库，
   * 管理台是另一个页面，只在挂载时读过一次库——没有这条广播，
   * 已经打开的管理台会一直显示旧列表，用户的观感是"划了词但生词本里没有"。
   *
   * ⚠️ 页面不可见时先记下、等切回可见再刷新：管理台可能在后台标签页里躺着，
   * 为每一次划词都跑一遍全表读取是白费（1 万词一次就是秒级）。
   */
  const pendingRefresh = useRef(false);
  useEffect(() => {
    const onMessage = (message: unknown) => {
      if (!isWordsChangedNotice(message)) return undefined;
      if (document.visibilityState === 'visible') notifyWordsChanged();
      else pendingRefresh.current = true;
      return undefined;
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || !pendingRefresh.current) return;
      pendingRefresh.current = false;
      notifyWordsChanged();
    };

    browser.runtime.onMessage.addListener(onMessage);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // 事实还没读到时按"不提醒"处理：宁可晚一条消息，也不要先闪一下再消失
  const reminder = health
    ? backupReminder(health, Date.now())
    : { remind: false, reason: 'empty' as const, days: null };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <main className="app">
        <h1>{t('app.title')}</h1>
        <div className="muted" style={{ fontSize: '.8rem' }}>
          {t('app.tagline', { version })}
        </div>

        {/* FR-L6：距上次导出超过 30 天且数据有变化时提醒（R10：卸载即丢）。
            "知道了"只关掉本次会话——持久化关闭等于把这条 FR 关掉。 */}
        {reminder.remind && !reminderDismissed && (
          <div className="banner" role="status" aria-label={tx('备份提醒')}>
            <span>{backupReminderText(reminder)}</span>
            <button onClick={() => setTab('words')}>{tx('去「生词」页')}</button>
            <button onClick={() => setReminderDismissed(true)}>{tx('知道了')}</button>
          </div>
        )}

        {/* FR-F10：首装引导（四块：词库状态 / 卸载风险 / 核心开关 / 隐私）。不阻塞使用 */}
        {onboardingOpen && <Onboarding onDismiss={dismissOnboarding} />}

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'words'} onClick={() => setTab('words')}>
            {t('tab.words')}
          </button>
          <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>
            {t('tab.settings')}
          </button>
          <button role="tab" aria-selected={tab === 'diag'} onClick={() => setTab('diag')}>
            {t('tab.diag')}
          </button>
        </div>

        {/* 用 hidden 而不是条件渲染：切回"生词"时滚动位置与筛选都还在 */}
        <div hidden={tab !== 'words'}>
          <WordList />
        </div>
        <div hidden={tab !== 'settings'}>
          <SettingsPage onLocaleChange={applyLocale} />
        </div>
        <div hidden={tab !== 'diag'}>
          <DiagnosticsPage />
        </div>
      </main>
    </>
  );
}
