/**
 * FR-E7「一键清空所有数据」的数据语义（PLAN.md §1.E）。
 *
 * 验收原话：**「清空后所有 store 为空且设置保留；未确认时不执行」**。
 *
 * 前一半是数据层的事（本文件），后一半是界面的事
 * （`entrypoints/manager/SettingsPage.test.tsx`）。
 *
 * ⚠️ 旧实现是 **`indexedDB.deleteDatabase()`**——整库删掉，
 * 于是**设置也一起没了**，与"设置保留"直接冲突。
 * 而且删库会被其它标签页的连接阻塞（要用户先关掉别的 Leximate 页面）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addScene, countScenes, listWords, softDeleteWord, upsertWord } from './words';
import { getMeta, getSettings, setMeta, setSettings } from './kv';
import { clearAllData, readDataHealth } from './maintenance';
import { STORE, openDb, readTx, req } from './schema';

/** 造一条最小数据集：1 个词 + 1 条例句 + 非默认设置 + 一条 meta */
async function seed() {
  const { word } = await upsertWord({ lemma: 'run', phoneticUs: '/rʌn/', phoneticSrc: 'pipeline' });
  await addScene({
    wordId: word.id,
    text: 'I run every day.',
    highlightFrom: 2,
    highlightTo: 5,
    sourceUrl: 'https://example.com/a',
  });
  await setSettings({ enabled: false, underlineColor: '#123456' });
  await setMeta({ persistGranted: true });
}

async function countStore(store: (typeof STORE)[keyof typeof STORE]): Promise<number> {
  return readTx(store, (tx) => req<number>(tx.objectStore(store).count()));
}

describe('FR-E7：清空数据但保留设置', () => {
  beforeEach(async () => {
    await seed();
  });

  it('数据 store 清空（words / scenes / translations / queue / logs）', async () => {
    await clearAllData();

    for (const store of [
      STORE.words,
      STORE.scenes,
      STORE.translations,
      STORE.queue,
      STORE.logs,
    ] as const) {
      expect(await countStore(store)).toBe(0);
    }
  });

  it('设置**保留**（验收原话：清空后……且设置保留）', async () => {
    await clearAllData();

    const settings = await getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.underlineColor).toBe('#123456');
  });

  it('meta 保留（结构版本、安装时间、持久化授权不是用户数据）', async () => {
    await clearAllData();

    expect((await getMeta()).persistGranted).toBe(true);
  });

  it('清空后库仍然可用（不删库，因此不需要关掉其它标签页）', async () => {
    await clearAllData();

    // 不 resetDbHandle 也能继续写：旧实现删了库，句柄必须重建才不报错
    await upsertWord({ lemma: 'again' });

    expect((await listWords()).map((w) => w.lemma)).toEqual(['again']);
    expect(await countScenes()).toBe(0);
    expect(await countStore(STORE.words)).toBe(1);
  });

  it('库的连接没被丢弃（句柄仍指向同一个库）', async () => {
    const before = await openDb();
    await clearAllData();
    const after = await openDb();

    expect(after).toBe(before);
  });

  it('keepSettings: false 时连设置一起清（测试与"彻底重置"用）', async () => {
    await clearAllData({ keepSettings: false });

    const settings = await getSettings();
    // 回到默认值，而不是"读到 123456 这条被保留的记录"
    expect(settings.enabled).toBe(true);
    expect(settings.underlineColor).toBe('#d98b2b');
    expect(await countStore(STORE.settings)).toBe(0);
  });
});

/**
 * FR-L5 / FR-L6 的事实来源（PLAN.md §1.L）。
 *
 * 这一层只保证"读到的是真值"：个数、最近一次变化的时间、上次导出时间、配额。
 * "该不该提醒"是 `utils/manager/backup-health.ts` 的事（纯函数，那边测）。
 */
describe('readDataHealth：数据健康的真实读数', () => {
  it('词数 / 句数 / 最大变化时间 / 上次导出时间 / 持久化标记', async () => {
    const { word } = await upsertWord({ lemma: 'run', now: 1_000 });
    await addScene({
      wordId: word.id,
      text: 'I run daily.',
      highlightFrom: 2,
      highlightTo: 5,
      sourceUrl: 'https://example.com/a',
      capturedAt: 5_000,
    });
    await setMeta({ lastExportAt: 9_000, persistGranted: true });

    const health = await readDataHealth();

    expect(health.words).toBe(1);
    expect(health.scenes).toBe(1);
    expect(health.lastExportAt).toBe(9_000);
    expect(health.persistGranted).toBe(true);
    // 例句比词新：取两个索引里的较大者
    expect(health.latestChangeAt).toBe(5_000);
  });

  it('空库：计数为 0、最近变化为 null（不是 0——0 会被当成"1970 年变过"）', async () => {
    const health = await readDataHealth();

    expect(health.words).toBe(0);
    expect(health.scenes).toBe(0);
    expect(health.latestChangeAt).toBeNull();
    expect(health.lastExportAt).toBeNull();
  });

  it('墓碑也算一次变化（删词之后提醒才可能出现）', async () => {
    const { word } = await upsertWord({ lemma: 'run', now: 1_000 });
    await softDeleteWord(word.id);

    const health = await readDataHealth();
    // 词数不含墓碑，但"变过"要算
    expect(health.words).toBe(0);
    expect(health.latestChangeAt).not.toBeNull();
    expect(health.latestChangeAt! > 1_000).toBe(true);
  });

  it('配额拿不到时是 null（jsdom 里没有 navigator.storage）', async () => {
    const health = await readDataHealth();
    expect(health.usage).toBeNull();
    expect(health.quota).toBeNull();
  });
});
