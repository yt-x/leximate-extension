/**
 * 设置页的 WebDAV 状态块（PLAN.md FR-H1 / FR-H6）。
 *
 * 只做两件事：把**上次成功时间 / 上次错误**说清楚，并提供手动同步按钮。
 * 它不自己发请求——请求在后台（`utils/sync/assembly.ts::runSync`），
 * 这里只发一条消息让后台跑，因此内容脚本与页面的网络边界都不受影响。
 */
import { useEffect, useState } from 'react';
import { getMeta } from '@/utils/db/kv';
import { tx } from '@/utils/i18n';

export interface SyncStatusProps {
  /** 覆盖读取（用例用） */
  loadMeta?: typeof getMeta;
  /** 手动同步（用例用；默认发消息给后台） */
  requestSync?: () => Promise<{ ok: boolean; message?: string }>;
}

type State =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'done'; at: number; pulled: number; pushed: number }
  | { phase: 'failed'; error: string };

export function SyncStatus({ loadMeta, requestSync }: SyncStatusProps = {}) {
  const [lastSyncAt, setLastSyncAt] = useState<number | null | undefined>(undefined);
  const [state, setState] = useState<State>({ phase: 'idle' });

  useEffect(() => {
    let alive = true;
    void (loadMeta ?? getMeta)()
      .then((meta) => {
        if (!alive) return;
        setLastSyncAt(meta.lastSyncAt);
        if (meta.syncState === 'running') setState({ phase: 'busy' });
        else if (meta.syncState === 'error') {
          setState({ phase: 'failed', error: meta.lastSyncError ?? tx('同步未完成') });
        }
      })
      .catch(() => {
        // 读不到就显示"未知"，不编一个时间出来
      });
    return () => {
      alive = false;
    };
  }, [loadMeta]);

  const run = async () => {
    setState({ phase: 'busy' });
    try {
      const send =
        requestSync ??
        (async () => {
          const response = (await browser.runtime.sendMessage({ type: 'leximate:sync-now' })) as
            | { ok?: boolean; message?: string }
            | undefined;
          return { ok: response?.ok === true, message: response?.message };
        });
      const result = await send();

      // 不管成没成，都重读一次真实时间——界面上的时间只能来自库里
      const meta = await (loadMeta ?? getMeta)();
      setLastSyncAt(meta.lastSyncAt);

      setState(
        result.ok
          ? { phase: 'done', at: meta.lastSyncAt ?? Date.now(), pulled: 0, pushed: 0 }
          : { phase: 'failed', error: result.message ?? tx('同步未完成') },
      );
    } catch (error) {
      setState({ phase: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div data-block="sync-status">
      <h3 style={{ fontSize: '.85rem', color: 'var(--muted)', marginTop: 22 }}>{tx('同步状态')}</h3>

      <p className="hint" style={{ margin: '6px 0 0' }}>
        {lastSyncAt === undefined && tx('正在读取同步状态…')}
        {lastSyncAt === null && tx('还没有成功同步过。')}
        {typeof lastSyncAt === 'number' &&
          tx('上次成功同步：{time}', { time: new Date(lastSyncAt).toLocaleString() })}
      </p>

      <button onClick={() => void run()} disabled={state.phase === 'busy'}>
        {state.phase === 'busy' ? tx('同步中…') : tx('立即同步')}
      </button>

      {state.phase === 'done' && <p className="saved">{tx('同步完成。')}</p>}
      {state.phase === 'failed' && (
        <p className="error" role="alert">
          {tx('同步失败：{error}', { error: state.error })}
        </p>
      )}
    </div>
  );
}
