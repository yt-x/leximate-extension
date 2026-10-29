/**
 * 设置与元数据的读写（PLAN.md FR-E1 的 `settings` / `meta` 两个 store）。
 *
 * 两个 store 都用 `{ key, value }` 形态：设置整体存成一条，扩容时加字段不需要改结构版本。
 * 读的时候一律与默认值合并，因此老版本写下的数据缺字段也不会崩。
 *
 * ⚠️ **默认值不在这里**，在 `./defaults.ts`。原因：内容脚本需要
 * `DEFAULT_SETTINGS`，而本模块读写 IndexedDB；若默认值住在这里，
 * 内容脚本就会为了一个常量把存储层拉进依赖图（详见 `defaults.ts` 的说明）。
 * 这里重新导出以保持既有调用点不变。
 */
import { readTx, req, STORE, writeTx } from './schema';
import type { KeyValue, Meta, Settings } from './types';
import { DEFAULT_SETTINGS, SETTINGS_KEY, META_KEY, defaultMeta } from './defaults';
import { notifySettingsWritten } from '../settings-bus';

// 重新导出，保持既有调用点（`import { DEFAULT_SETTINGS } from '@/utils/db/kv'`）不变
export { DEFAULT_SETTINGS, SETTINGS_KEY, META_KEY, defaultMeta };

/** 丢掉值为 undefined 的键，避免浅合并把已有值覆盖成 undefined */
function compact<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  const clean = compact(patch);
  return {
    ...base,
    ...clean,
    translation: { ...base.translation, ...(clean.translation ?? {}) },
    ui: { ...base.ui, ...(clean.ui ?? {}) },
  };
}

export async function getSettings(): Promise<Settings> {
  const row = await readTx(STORE.settings, (tx) =>
    req<KeyValue<Settings> | undefined>(tx.objectStore(STORE.settings).get(SETTINGS_KEY)),
  );
  return mergeSettings(DEFAULT_SETTINGS, row?.value ?? {});
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = await writeTx(STORE.settings, async (tx) => {
    const store = tx.objectStore(STORE.settings);
    const row = await req<KeyValue<Settings> | undefined>(store.get(SETTINGS_KEY));
    const merged = mergeSettings(mergeSettings(DEFAULT_SETTINGS, row?.value ?? {}), patch);
    await req(store.put({ key: SETTINGS_KEY, value: merged }));
    return merged;
  });

  // 设置存在 IndexedDB 里，**不会**产生 `browser.storage.onChanged` 事件。
  // 因此写入路径必须显式通知，否则 FR-A14 的"不重载页面即生效"根本不成立。
  //
  // ⚠️ 这里只通知**本上下文**（后台自己刷新角标、再向各标签页投递）。
  // 跨上下文投递由后台用 `tabs.sendMessage` 完成——
  // `runtime.sendMessage` 到不了内容脚本（`docs/reference/extension-storage-and-messaging.md` §2）。
  //
  // 放在 setSettings 内部而不是各个调用点，是为了让"改了设置就一定通知"
  // 成为不可绕过的一步。
  notifySettingsWritten();

  return next;
}

export async function getMeta(): Promise<Meta> {
  const row = await readTx(STORE.meta, (tx) =>
    req<KeyValue<Meta> | undefined>(tx.objectStore(STORE.meta).get(META_KEY)),
  );
  // 元数据不合并默认时间戳：已存在的记录就是权威，缺失字段才补默认
  return row ? { ...defaultMeta(), ...row.value } : defaultMeta();
}

export async function setMeta(patch: Partial<Meta>): Promise<Meta> {
  return writeTx(STORE.meta, async (tx) => {
    const store = tx.objectStore(STORE.meta);
    const row = await req<KeyValue<Meta> | undefined>(store.get(META_KEY));
    const base = row?.value ?? defaultMeta();
    const next: Meta = { ...base, ...compact(patch) };
    await req(store.put({ key: META_KEY, value: next }));
    return next;
  });
}
