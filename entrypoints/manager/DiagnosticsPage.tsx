/**
 * 本地诊断页（PLAN.md FR-L4）。
 *
 * 验收原话："记录运行日志（安装、词库初始化、翻译失败、同步失败），
 * **可查看、可导出、不上报任何数据**"。
 *
 * 三件事对应三处：
 * - **记录**：写入在 `utils/diag/log.ts`（后台侧），内容脚本经 `MSG.log` 上报；
 * - **可查看**：本页（级别 / 来源 / 文本三个筛选 + 最新在前）；
 * - **可导出**：导出**当前筛选后**的日志为 JSON（复用 M1-7 的下载层）；
 * - **不上报**：本页与 `utils/diag/` 不引用任何网络 API，
 *   由 `utils/diag/no-network.test.ts` 扫源码守住。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import type { LogEntry, LogLevel } from '@/utils/db/types';
import { downloadExportFile } from '@/utils/export';
import { tx } from '@/utils/i18n';
import {
  availableScopes,
  clearLogs,
  countLogs,
  detailText,
  diagnosticsFilename,
  filterLogs,
  LEVEL_LABEL,
  listLogs,
  LOG_LEVELS,
  logsToJson,
} from '@/utils/diag';

/** 列表里 detail 显示的字符数（完整内容在导出的 JSON 里） */
const DETAIL_PREVIEW = 120;

export function DiagnosticsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [scope, setScope] = useState<string>('all');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [clearStep, setClearStep] = useState<'idle' | 'confirm'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [logs, count] = await Promise.all([listLogs(), countLogs()]);
      setEntries(logs);
      setTotal(count);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const scopes = useMemo(() => availableScopes(entries), [entries]);
  const visible = useMemo(
    () => filterLogs(entries, { level, scope, text }),
    [entries, level, scope, text],
  );

  const exportLogs = async () => {
    setBusy(true);
    setError(null);
    try {
      const filename = diagnosticsFilename();
      await downloadExportFile({
        filename,
        text: logsToJson(visible, { appVersion: browser.runtime.getManifest().version }),
        mime: 'application/json',
        bom: false,
        hint: tx('日志只含本机事件，可直接贴进 issue。'),
      });
      setExported(filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmClear = async () => {
    setBusy(true);
    try {
      await clearLogs();
      setClearStep('idle');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 style={{ fontSize: '1.05rem' }}>{tx('诊断')}</h2>
      <div className="hint">
        {tx('日志只保存在本机，不会上传到任何服务器；导出的是当前筛选后的内容。')}
      </div>

      <div className="toolbar">
        <select
          aria-label={tx('日志级别')}
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel | 'all')}
        >
          <option value="all">{tx('全部级别')}</option>
          {LOG_LEVELS.map((item) => (
            <option key={item} value={item}>
              {tx(LEVEL_LABEL[item])}
            </option>
          ))}
        </select>

        <select aria-label={tx('日志来源')} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">{tx('全部来源')}</option>
          {scopes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>

        <input
          className="grow"
          type="search"
          placeholder={tx('搜索日志内容')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <button onClick={() => void reload()} disabled={busy}>
          {tx('刷新')}
        </button>
        <button onClick={() => void exportLogs()} disabled={busy || visible.length === 0}>
          {tx('导出日志')}
        </button>
        <button onClick={() => setClearStep('confirm')} disabled={busy || total === 0}>
          {tx('清空日志')}
        </button>
        <span className="muted count">
          {visible.length} / {total}
        </span>
      </div>

      {clearStep === 'confirm' && (
        <div className="danger" role="alertdialog" aria-label={tx('确认清空日志')}>
          <p style={{ margin: '0 0 8px' }}>
            {tx('确认清空全部 {total} 条日志？清掉之后就没有排查线索了（建议先导出）。', { total })}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => void confirmClear()} disabled={busy}>
              {tx('确认清空')}
            </button>
            <button onClick={() => setClearStep('idle')} disabled={busy}>
              {tx('取消')}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {tx('读取日志失败：{error}', { error })}
        </p>
      )}

      {exported && (
        <p className="saved" role="status">
          {tx('已导出 {exported}', { exported })}
        </p>
      )}

      <div className="scroller" style={{ height: 'calc(100vh - 360px)' }}>
        {visible.length === 0 ? (
          <div className="empty">
            {entries.length === 0 ? tx('还没有日志。') : tx('没有符合筛选条件的日志。')}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: '6px 8px' }}>
            {visible.map((entry) => {
              const detail = detailText(entry.detail);
              return (
                <li key={entry.id} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className="muted" style={{ fontSize: '.78rem' }}>
                    {new Date(entry.at).toLocaleString()}
                  </span>{' '}
                  <span className="badge" data-s={entry.level === 'error' ? 'new' : undefined}>
                    {tx(LEVEL_LABEL[entry.level])}
                  </span>{' '}
                  <span className="muted">{entry.scope}</span> {entry.message}
                  {detail && (
                    <span className="muted" style={{ fontSize: '.78rem' }} title={detail}>
                      {' '}
                      {detail.length > DETAIL_PREVIEW ? `${detail.slice(0, DETAIL_PREVIEW)}…` : detail}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 说明各来源是什么意思：用户看到 "dict"/"badge" 这些 scope 得知道去哪找 */}
      <p className="hint">
        {tx('来源：install（安装/更新）、background（后台启动）、dict（词库初始化）、content（网页上的动作）、badge（角标失败）。翻译与同步的失败日志随 M3 的相应节点接入。')}
      </p>
    </>
  );
}
