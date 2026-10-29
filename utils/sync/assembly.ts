/**
 * 后台侧的同步装配（PLAN.md FR-H1 / FR-H4 / FR-H6）。
 *
 * 与翻译的 `assembly.ts` 同一定位：只做接线，把可判断的东西留在可注入的纯模块里
 * （`trigger.ts` 决定该不该跑，`engine.ts` 决定怎么合）。
 *
 * 三个必须遵守的边界：
 *  - **没配置就什么都不做**（不建 alarm、不读远端）；
 *  - 并发保护用模块级 `running` 标志，MV3 的 worker 单线程，这个标志够用；
 *  - 成功才写 `Meta.lastSyncAt`，失败只记日志（FR-H6 的"失败可见"）。
 */
import { getMeta, getSettings, setMeta } from '../db/kv';
import { listScenesByWord } from '../db/words';
import { readTx, req, STORE, writeTx } from '../db/schema';
import type { Scene, Word } from '../db/types';
import { createWebdavClient } from './webdav';
import { syncOnce, type SyncOutcome } from './engine';
import {
  DEFAULT_CHANGE_DELAY_MS,
  DEFAULT_MIN_INTERVAL_MS,
  createChangeWindow,
  shouldRunSync,
  type SyncTriggerKind,
} from './trigger';

export interface SyncRunnerDeps {
  /** 覆盖读依赖（用例用） */
  readWords?(): Promise<Word[]>;
  readScenes?(): Promise<Scene[]>;
  saveWords?(rows: Word[]): Promise<void>;
  saveScenes?(rows: Scene[]): Promise<void>;
  writeRemote?(body: string): Promise<void>;
  readRemote?(): Promise<string | null>;
  log?(entry: { level: 'info' | 'warn'; message: string; detail?: unknown }): void;
  /** 远端数据写回本地后，刷新角标、广播并重算缓存。 */
  onDataChanged?(): void;
  now?(): number;
}

/** 模块级状态：单线程的 Service Worker 里够用 */
let running = false;
let lastRunAt = 0;
const changeWindow = createChangeWindow();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export function resetSyncRunnerForTests(): void {
  running = false;
  lastRunAt = 0;
  changeWindow.clear();
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/** 读本地全量（含墓碑） */
async function readAllWords(): Promise<Word[]> {
  return readTx(STORE.words, (tx) => req<Word[]>(tx.objectStore(STORE.words).getAll()));
}

async function readAllScenes(): Promise<Scene[]> {
  return readTx(STORE.scenes, (tx) => req<Scene[]>(tx.objectStore(STORE.scenes).getAll()));
}

async function saveWords(rows: Word[]): Promise<void> {
  await writeTx(STORE.words, async (tx) => {
    const store = tx.objectStore(STORE.words);
    for (const row of rows) await req(store.put(row));
  });
}

async function saveScenes(rows: Scene[]): Promise<void> {
  await writeTx(STORE.scenes, async (tx) => {
    const store = tx.objectStore(STORE.scenes);
    for (const row of rows) await req(store.put(row));
  });
}

/**
 * 跑一次同步。`kind` 决定是否受最短间隔限制。
 *
 * 返回 `null` 表示"没跑"（未配置 / 正在跑 / 太近），不是失败。
 */
export async function runSync(kind: SyncTriggerKind, deps: SyncRunnerDeps = {}): Promise<SyncOutcome | null> {
  const now = deps.now ?? Date.now;

  const settings = await getSettings();
  const configured = settings.webdav !== null && settings.webdav.url.trim() !== '';
  const decision = shouldRunSync({
    kind,
    now: now(),
    state: { lastRunAt, minIntervalMs: DEFAULT_MIN_INTERVAL_MS },
    configured,
    running,
  });
  if (!decision.run) {
    deps.log?.({ level: 'info', message: '同步未启动', detail: decision });
    return null;
  }

  running = true;
  lastRunAt = now();
  changeWindow.clear();

  try {
    const webdav = settings.webdav;
    if (!webdav) return null;
    await setMeta({ syncState: 'running', lastSyncError: null });
    const client = createWebdavClient(webdav);

    const outcome = await syncOnce({
      loadWords: deps.readWords ?? readAllWords,
      loadScenes: deps.readScenes ?? readAllScenes,
      saveWords: deps.saveWords ?? saveWords,
      saveScenes: deps.saveScenes ?? saveScenes,
      // FR-H5：口令随配置走；非空即加密
      passphrase: webdav.passphrase && webdav.passphrase.trim() !== '' ? webdav.passphrase : undefined,
      readRemote: deps.readRemote ?? (() => client.read()),
      writeRemote: deps.writeRemote ?? ((body) => client.write(body)),
      markSynced: async (at) => {
        await setMeta({ lastSyncAt: at });
      },
      log: deps.log,
      now: deps.now,
    });

    if (outcome.status === 'ok') {
      await setMeta({ syncState: 'ok', lastSyncError: null });
      // 同步成功统一失效并刷新；即使只回了 Scene，也不能靠 pulled 的词数猜本地是否变化。
      deps.onDataChanged?.();
    } else {
      await setMeta({
        syncState: 'error',
        lastSyncError: outcome.status === 'remote-broken' ? outcome.reason : outcome.error,
      });
    }

    deps.log?.({
      level: outcome.status === 'ok' ? 'info' : 'warn',
      message: outcome.status === 'ok' ? '同步完成' : '同步未完成',
      detail: outcome,
    });
    return outcome;
  } finally {
    running = false;
  }
}

/**
 * 本地变更后的延迟同步（FR-H4 的第三种触发）。
 *
 * 连续划词只会在**同一个窗口**里排一次，因此不会变成连续上传。
 * 计时器在后台被回收时窗口自然丢失——下一次变更或下一次 alarm 会补上，这是可接受的。
 */
export function scheduleSyncAfterChange(deps: SyncRunnerDeps = {}): void {
  const now = (deps.now ?? Date.now)();
  const { dueAt, alreadyScheduled } = changeWindow.schedule(now, DEFAULT_CHANGE_DELAY_MS);
  if (alreadyScheduled) return;

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void runSync('change', deps)
      .then(async (outcome) => {
        if (outcome !== null) return;
        // running / too-soon 不是“窗口已消费”。仍配置时重排，否则 pendingAt
        // 会永远停在原地，后续变更也一直得到 alreadyScheduled。
        const settings = await getSettings();
        if (settings.webdav?.url.trim()) {
          changeWindow.clear();
          scheduleSyncAfterChange(deps);
        }
      })
      .catch(() => {
        // runSync 内部已兜住错误并记日志
      });
  }, Math.max(0, dueAt - now));
}

/** 当前是否有待跑的变更窗口（诊断页与用例用） */
export function pendingChangeAt(): number | null {
  return changeWindow.pendingAt;
}

export { listScenesByWord };
