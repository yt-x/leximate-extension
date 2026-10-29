/**
 * 首次安装引导（PLAN.md FR-E6 / FR-F10 / FR-F11）。
 *
 * 四块内容 + 「知道了」。**不阻塞使用**：它是页面顶部的一块面板，
 * 页签与列表照常可点；点「知道了」由调用方写 `Meta.onboardingDoneAt`，此后不再出现。
 *
 * 四块的清单与文案判定在 `utils/manager/onboarding.ts`（纯函数、有单测），
 * 这里只负责渲染——按 `data-block` 渲染是为了让"四块齐备"能被用例逐块断言。
 *
 * 样式一律内联：管理台的样式表是一段全局 CSS 字符串，为一块一次性面板去改它
 * 收益太小、风险却是影响所有页面。
 *
 * FR-L1：文案全部经 `t()`。**标题用渲染期函数取**，不能在模块顶层算成常量
 * （那样语言切换后不会更新）。
 */
import { useEffect, useState } from 'react';
import type { LogEntry } from '@/utils/db/types';
import { listLogs } from '@/utils/diag/log';
import { t } from '@/utils/i18n';
import {
  ONBOARDING_BLOCKS,
  dictStatusText,
  pickLatestDictLog,
  type OnboardingBlock,
} from '@/utils/manager/onboarding';

function titleOf(block: OnboardingBlock): string {
  switch (block) {
    case 'dict-status':
      return t('onboarding.dictStatus.title');
    case 'uninstall-risk':
      return t('onboarding.uninstall.title');
    case 'core-switches':
      return t('onboarding.switches.title');
    case 'privacy':
      return t('onboarding.privacy.title');
  }
}

export interface OnboardingProps {
  /** 点「知道了」。调用方负责写 `Meta.onboardingDoneAt` 并隐藏面板 */
  onDismiss(): void;
  /**
   * 取诊断日志（默认读扩展源的日志表）。
   *
   * 做成可注入是为了让用例不必真去建库；生产路径就是 `listLogs({})`。
   */
  loadLogs?(): Promise<LogEntry[]>;
}

export function Onboarding({ onDismiss, loadLogs }: OnboardingProps) {
  const [dictLog, setDictLog] = useState<LogEntry | undefined>(undefined);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = loadLogs ?? (() => listLogs({}));
    void load()
      .then((entries) => {
        if (alive) setDictLog(pickLatestDictLog(entries));
      })
      .catch(() => {
        // 读不到日志不影响引导：词库状态那一条会显示"尚未载入"
      });
    return () => {
      alive = false;
    };
  }, [loadLogs]);

  const section = (block: OnboardingBlock) => ({ 'data-block': block });

  return (
    <section
      aria-label={t('onboarding.aria')}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '12px 14px',
        margin: '12px 0',
        background: 'var(--hover)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: '.95rem' }}>{t('onboarding.title')}</strong>
        <span className="muted" style={{ fontSize: '.78rem' }}>
          {t('onboarding.subtitle')}
        </span>
        <button
          onClick={() => {
            setDismissing(true);
            onDismiss();
          }}
          disabled={dismissing}
          style={{ marginLeft: 'auto' }}
        >
          {dismissing ? t('onboarding.dismissed') : t('onboarding.dismiss')}
        </button>
      </div>

      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        <div {...section('dict-status')}>
          <strong style={{ fontSize: '.86rem' }}>{titleOf('dict-status')}</strong>
          <div className="hint" style={{ marginTop: 2 }}>
            {dictStatusText(dictLog)}
          </div>
          <div className="hint">{t('onboarding.dictStatus.hint')}</div>
          {/* FR-B7：内置词表只覆盖常用词，低频词要用户自备词库 */}
          <div className="hint" style={{ marginTop: 2 }}>
            {t('onboarding.dictStatus.importHint')}
          </div>
        </div>

        <div {...section('uninstall-risk')}>
          <strong style={{ fontSize: '.86rem' }}>{titleOf('uninstall-risk')}</strong>
          <div className="hint" style={{ marginTop: 2 }}>
            <strong>{t('onboarding.uninstall.lead')}</strong>
            {t('onboarding.uninstall.rest')}
          </div>
        </div>

        <div {...section('core-switches')}>
          <strong style={{ fontSize: '.86rem' }}>{titleOf('core-switches')}</strong>
          <ul className="hint" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>
              <strong>{t('onboarding.switches.query.title')}</strong>
              {t('common.sep')}
              {t('onboarding.switches.query.body')}
            </li>
            <li>
              <strong>{t('onboarding.switches.underline.title')}</strong>
              {t('common.sep')}
              {t('onboarding.switches.underline.body')}
            </li>
            <li>
              <strong>{t('onboarding.switches.minLength.title')}</strong>
              {t('common.sep')}
              {t('onboarding.switches.minLength.body')}
            </li>
          </ul>
        </div>

        <div {...section('privacy')}>
          <strong style={{ fontSize: '.86rem' }}>{titleOf('privacy')}</strong>
          <div className="hint" style={{ marginTop: 2 }}>
            {t('onboarding.privacy.body')}
          </div>
        </div>
      </div>
      <div className="hint" style={{ marginTop: 8, fontSize: '.76rem' }}>
        {t('onboarding.footer')}
      </div>
    </section>
  );
}

export { ONBOARDING_BLOCKS };
