/**
 * 管理台的翻译状态块（PLAN.md FR-D6 / FR-D7）。
 *
 * 两件事：
 *   1. **待翻译 N 条** + 一键重试（FR-D6）。计数把"还能再试"与"到顶停下"分开说——
 *      合成一个数字的话，失败到顶时它永远不归零，用户会以为程序卡住。
 *   2. **首次开启告知**（FR-D7）：翻译会让被划的那一句离开浏览器，必须由用户明确确认。
 *      未确认时 worker 一条请求都不发（`utils/translate/worker.ts` 的 ①′ 分支）。
 *
 * 组件不自己判断"该不该发请求"——那是 worker 的事；这里只展示与收集用户意图。
 */
import { useEffect, useState } from 'react';
import { getMeta, setMeta } from '@/utils/db/kv';
import { retryAllFailed } from '@/utils/db/translations';
import { tx } from '@/utils/i18n';
import { MAX_ATTEMPTS } from '@/utils/translate/worker';
import { queueStats } from '@/utils/db/translations';

export interface TranslateStatusProps {
  /** 覆盖读取（用例用） */
  loadStats?: typeof queueStats;
  loadMeta?: typeof getMeta;
  saveMeta?: typeof setMeta;
  retry?: typeof retryAllFailed;
  /** 重试后通知外面刷新（可选） */
  onRetried?(count: number): void;
}

export function TranslateStatus({
  loadStats,
  loadMeta,
  saveMeta,
  retry,
  onRetried,
}: TranslateStatusProps = {}) {
  const [stats, setStats] = useState<{ waiting: number; exhausted: number } | null>(null);
  const [acknowledged, setAcknowledged] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const readStats = loadStats ?? queueStats;
    const readMeta = loadMeta ?? getMeta;

    void readStats(MAX_ATTEMPTS)
      .then((value) => {
        if (alive) setStats({ waiting: value.waiting, exhausted: value.exhausted });
      })
      .catch(() => {
        // 读不到就不显示统计：这块是增益信息，不该阻塞设置页
      });
    void readMeta()
      .then((meta) => {
        if (alive) setAcknowledged(meta.translationNoticeAt !== null);
      })
      .catch(() => {
        // 读不到 meta 就当作"没确认过"——宁可少发，不可多发
        if (alive) setAcknowledged(false);
      });

    return () => {
      alive = false;
    };
  }, [loadStats, loadMeta]);

  /** FR-D7：用户点了"我知道了"才写标记 */
  const acknowledge = async () => {
    const write = saveMeta ?? setMeta;
    setBusy(true);
    try {
      await write({ translationNoticeAt: Date.now() });
      setAcknowledged(true);
    } finally {
      setBusy(false);
    }
  };

  const retryAll = async () => {
    const doRetry = retry ?? retryAllFailed;
    setBusy(true);
    try {
      const count = await doRetry();
      const fresh = await (loadStats ?? queueStats)(MAX_ATTEMPTS);
      setStats({ waiting: fresh.waiting, exhausted: fresh.exhausted });
      onRetried?.(count);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-block="translate-status">
      <h3 style={{ fontSize: '.85rem', color: 'var(--muted)', marginTop: 22 }}>
        {tx('句子翻译')}
      </h3>

      {/* FR-D7：首次开启告知。没确认前不显示"待翻译"，因为那时不会有任何请求 */}
      {acknowledged === false && (
        // 用 role="status" 而不是 alertdialog：它不是"要你确认才继续"的模态，
        // 而是一段必须被看到、且下方就有按钮的说明。用 alertdialog 还会和
        // 设置页"清空数据"的确认框抢同一个角色（既有用例按角色断言"没有对话框"）。
        <div className="danger" role="status" aria-label={tx('翻译隐私告知')}>
          <p style={{ margin: '0 0 6px' }}>
            {tx('开启翻译后，只有你划选的那一句会离开浏览器，发给你配置的翻译服务；词的释义、例句与凭据都不会上传。未开启时不会发出任何请求。')}
          </p>
          <button onClick={() => void acknowledge()} disabled={busy}>
            {tx('我知道了，开启翻译')}
          </button>
        </div>
      )}

      {acknowledged === true && stats !== null && (
        <p className="hint" style={{ margin: '6px 0 0' }}>
          {stats.waiting > 0
            ? tx('待翻译 {n} 条。', { n: stats.waiting })
            : tx('没有待翻译的句子。')}
          {stats.exhausted > 0 && ` ${tx('其中 {n} 条已连续失败 {max} 次，已停止自动重试。', { n: stats.exhausted, max: MAX_ATTEMPTS })}`}
          {(stats.waiting > 0 || stats.exhausted > 0) && (
            <>
              {' '}
              <button onClick={() => void retryAll()} disabled={busy}>
                {tx('全部重试')}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
