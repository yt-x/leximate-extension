/**
 * 后台同步装配的判定（PLAN.md FR-H4 / FR-H6）。
 *
 * 这层要守住的三件事：没配置不跑、并发不重入、失败不写 `lastSyncAt`。
 */
import { describe, expect, it, vi } from 'vitest';
import { makeWord } from '../manager/testing';
import { buildPayload } from './payload';
import { pendingChangeAt, resetSyncRunnerForTests, runSync, scheduleSyncAfterChange } from './assembly';
import { DEFAULT_MIN_INTERVAL_MS } from './trigger';

const baseWord = makeWord({ lemma: 'run', updatedAt: 10 });

function fakeDeps(options: {
  configured: boolean;
  remoteRaw?: string | null;
  failWrite?: boolean;
} = { configured: true }) {
  const state = { remote: options.remoteRaw ?? null, writes: 0, words: [baseWord] as ReturnType<typeof makeWord>[] };
  const log = vi.fn();
  return {
    state,
    log,
    deps: {
      readWords: async () => state.words,
      readScenes: async () => [],
      saveWords: async (rows: typeof state.words) => {
        state.words = rows;
      },
      saveScenes: async () => undefined,
      readRemote: async () => state.remote,
      writeRemote: async (body: string) => {
        if (options.failWrite) throw new Error('远端写失败');
        state.writes += 1;
        state.remote = body;
      },
      log,
      now: () => 1000,
    },
  };
}

// 这些用例依赖「配置存在」——设置走真实 getSettings，因此先把 WebDAV 配好
async function withWebdav<T>(configured: boolean, fn: () => Promise<T>): Promise<T> {
  const { setSettings, getSettings } = await import('../db/kv');
  const before = await getSettings();
  await setSettings({
    ...before,
    webdav: configured
      ? { url: 'https://dav.example.com/dav', username: 'u', password: 'p', path: '/leximate/sync.json' }
      : null,
  });
  try {
    return await fn();
  } finally {
    await setSettings(before);
    resetSyncRunnerForTests();
  }
}

describe('没配置 WebDAV', () => {
  it('返回 null 且不读远端（一次请求都不发）', async () => {
    await withWebdav(false, async () => {
      const { deps } = fakeDeps({ configured: false });
      const readRemote = vi.fn(deps.readRemote);
      const outcome = await runSync('manual', { ...deps, readRemote });

      expect(outcome).toBeNull();
      expect(readRemote).not.toHaveBeenCalled();
    });
  });
});

describe('已配置', () => {
  it('手动触发：远端为空时上传，并写 lastSyncAt', async () => {
    await withWebdav(true, async () => {
      const { state, deps } = fakeDeps({ configured: true });

      const outcome = await runSync('manual', deps);

      expect(outcome).toMatchObject({ status: 'ok' });
      expect(state.writes).toBe(1);

      const { getMeta } = await import('../db/kv');
      expect((await getMeta()).lastSyncAt).toBe(1000);
    });
  });

  it('远端写失败：status 为 error，且 lastSyncAt 不写', async () => {
    await withWebdav(true, async () => {
      const { setMeta } = await import('../db/kv');
      await setMeta({ lastSyncAt: null });

      const { deps } = fakeDeps({ configured: true, failWrite: true });
      const outcome = await runSync('manual', deps);

      expect(outcome).toMatchObject({ status: 'error' });
      const { getMeta } = await import('../db/kv');
      expect((await getMeta()).lastSyncAt).toBeNull();
    });
  });

  it('定时触发受最短间隔限制：紧接着再跑一次会被跳过', async () => {
    await withWebdav(true, async () => {
      const first = fakeDeps({ configured: true });
      await runSync('alarm', first.deps);

      // 第二次用同样的 now，距上次 0ms < 最短间隔
      const second = fakeDeps({ configured: true });
      const outcome = await runSync('alarm', second.deps);

      expect(outcome).toBeNull();
      expect(second.state.writes).toBe(0);
    });
  });

  it('手动触发不受最短间隔限制', async () => {
    await withWebdav(true, async () => {
      await runSync('manual', fakeDeps({ configured: true }).deps);

      const again = fakeDeps({ configured: true });
      const outcome = await runSync('manual', again.deps);

      expect(outcome).toMatchObject({ status: 'ok' });
      expect(again.state.writes).toBe(1);
    });
  });
});

describe('变更后延迟同步（FR-H4）', () => {
  it('连续多次变更只排一个窗口', async () => {
    await withWebdav(true, async () => {
      scheduleSyncAfterChange({ now: () => 1000 });
      const first = pendingChangeAt();
      scheduleSyncAfterChange({ now: () => 2000 });
      const second = pendingChangeAt();

      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(first).toBeGreaterThanOrEqual(1000 + DEFAULT_MIN_INTERVAL_MS / 2);
    });
  });
});

describe('FR-H4 / FR-H6：写回通知、窗口恢复与持久状态', () => {
  it('远端较新数据写回后通知角标、管理台与内容脚本刷新', async () => {
    await withWebdav(true, async () => {
      const { deps } = fakeDeps({
        configured: true,
        remoteRaw: JSON.stringify(buildPayload({ words: [makeWord({ lemma: 'run', updatedAt: 20 })], scenes: [], now: 1 })),
      });
      const onDataChanged = vi.fn();

      const outcome = await runSync('manual', { ...deps, onDataChanged });

      expect(outcome).toMatchObject({ status: 'ok' });
      expect(onDataChanged).toHaveBeenCalledTimes(1);
    });
  });

  it('成功后持久化 ok，自动失败后的错误原因也能在重载后读到', async () => {
    await withWebdav(true, async () => {
      await runSync('manual', fakeDeps({ configured: true }).deps);
      const { getMeta } = await import('../db/kv');
      expect((await getMeta()).syncState).toBe('ok');

      const outcome = await runSync('manual', fakeDeps({ configured: true, failWrite: true }).deps);
      expect(outcome).toMatchObject({ status: 'error' });
      expect((await getMeta()).syncState).toBe('error');
      expect((await getMeta()).lastSyncError).toContain('远端写失败');
    });
  });

  it('最短间隔导致延迟窗口跳过后必须重排，不能永久卡死', async () => {
    await withWebdav(true, async () => {
      let now = 0;
      const { deps } = fakeDeps({ configured: true });
      const readRemote = vi.fn(deps.readRemote);
      const timedDeps = { ...deps, readRemote, now: () => now };
      await runSync('manual', timedDeps);
      expect(readRemote).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      try {
        now = 1000;
        scheduleSyncAfterChange(timedDeps);
        now = 31_000;
        await vi.advanceTimersByTimeAsync(31_000);
        expect(readRemote).toHaveBeenCalledTimes(1);
        expect(pendingChangeAt()).not.toBeNull();

        now = 61_000;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(readRemote).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('载荷形状可被引擎读回', () => {
  it('上传的内容确实是同步载荷（不是备份）', async () => {
    await withWebdav(true, async () => {
      const { state, deps } = fakeDeps({ configured: true });
      await runSync('manual', deps);

      const parsed = JSON.parse(String(state.remote)) as { kind: string; schemaVersion: number };
      expect(parsed.kind).toBe('leximate-sync');
      expect(parsed.schemaVersion).toBe(buildPayload({ words: [], scenes: [] }).schemaVersion);
    });
  });
});
