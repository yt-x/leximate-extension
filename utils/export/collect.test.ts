/**
 * 数据装载与**无损性**（PLAN.md FR-G8）的测试。
 *
 * FR-G8 的原话是"导出前后 IndexedDB 内容逐条一致（含 meetCount 与 updatedAt）"，
 * 而"一致"必须由**快照比对**来证明——只看代码里有没有写库调用是静态论证，
 * 挡不住"某条路径顺手更新了 updatedAt"这种真实退化。
 *
 * 夹具走**真实写入路径**（`upsertWord` / `addScene`，不 mock 数据库）：
 * 这样 FR-B9 的音标来源、例句去重等不变式会在夹具上先失败
 * （`CONSTRAINTS.md` 第 16 条就是这么踩出来的）。
 */
import { describe, expect, it } from 'vitest';
import { req, readTx, STORE } from '../db/schema';
import { addScene, upsertWord } from '../db/words';
import type { Word } from '../db/types';
import { loadRows } from '../manager/load';
import { buildBackupPayload, buildExportFile, buildRecords } from './index';
import { collectBackupData, loadScenesByWord, toRecordInputs } from './collect';

async function seed(): Promise<{ run: Word; jump: Word }> {
  const { word: run } = await upsertWord({
    lemma: 'run',
    surface: 'running',
    defZh: ['v. 跑'],
    defSrc: 'authored',
    phoneticUs: 'rʌn',
    phoneticSrc: 'pipeline',
    examTags: ['CET4'],
    freqBnc: 1200,
  });
  const { word: jump } = await upsertWord({
    lemma: 'jump',
    surface: 'jump',
    defZh: ['v. 跳'],
    defSrc: 'authored',
  });

  await addScene({
    wordId: run.id,
    text: 'I run every morning.',
    highlightFrom: 2,
    highlightTo: 5,
    sourceUrl: 'https://a.com/1',
    // 显式给时间：同一毫秒时顺序要靠 uuid 兜底，用例会随运行而变
    capturedAt: 1000,
  });
  await addScene({
    wordId: run.id,
    text: 'She runs a company.',
    highlightFrom: 4,
    highlightTo: 8,
    sourceUrl: 'https://b.com/2',
    capturedAt: 2000,
  });
  await addScene({
    wordId: jump.id,
    text: 'Jump over it.',
    highlightFrom: 0,
    highlightTo: 4,
    sourceUrl: 'https://c.com/3',
  });

  return { run, jump };
}

/** 所有 store 的原始内容（导出不该改动其中任何一条） */
async function snapshot(): Promise<Record<string, unknown>> {
  const stores = [
    STORE.words,
    STORE.scenes,
    STORE.translations,
    STORE.queue,
    STORE.settings,
    STORE.meta,
  ] as const;

  return readTx([...stores], async (tx) => {
    const out: Record<string, unknown> = {};
    for (const store of stores) out[store] = await req(tx.objectStore(store).getAll());
    return out;
  });
}

describe('例句归组与顺序', () => {
  it('按 wordId 归组，且组内按采集时间升序（"首条例句"才有意义）', async () => {
    const { run } = await seed();
    const grouped = await loadScenesByWord();
    expect(grouped.get(run.id)?.map((scene) => scene.text)).toEqual([
      'I run every morning.',
      'She runs a company.',
    ]);
  });

  it('没有例句的词不在 map 里（调用方用 `?? []` 兜底，而不是拿到空数组假象）', async () => {
    const { jump } = await seed();
    await upsertWord({ lemma: 'quiet', surface: 'quiet' });
    const grouped = await loadScenesByWord();
    expect(grouped.has('quiet')).toBe(false);
    expect(grouped.get(jump.id)).toHaveLength(1);
  });

  it('toRecordInputs 按列表顺序取词与例句', async () => {
    await seed();
    const rows = await loadRows();
    const inputs = toRecordInputs(rows, await loadScenesByWord());
    expect(inputs.map((input) => input.word.lemma)).toEqual(rows.map((row) => row.word.lemma));
    const run = inputs.find((input) => input.word.lemma === 'run');
    expect(run?.scenes).toHaveLength(2);
  });

  it('collectBackupData 的词与例句顺序跟列表一致（回灌时不必再排）', async () => {
    await seed();
    const rows = await loadRows();
    const scenesByWord = await loadScenesByWord();
    const { words, scenes } = collectBackupData(rows, scenesByWord);

    expect(words.map((word) => word.lemma)).toEqual(rows.map((row) => row.word.lemma));
    // 例句按"词的顺序"分组排列，不交错（`listWords` 默认按 createdAt 倒序，因此不写死词序）
    let index = 0;
    for (const word of words) {
      for (const scene of scenesByWord.get(word.id) ?? []) {
        expect(scenes[index]?.wordId).toBe(word.id);
        index += 1;
      }
    }
    expect(index).toBe(scenes.length);
  });
});

describe('FR-G8：导出是无损的', () => {
  it('跑完五种格式的导出后，所有 store 逐条快照不变（含 meetCount 与 updatedAt）', async () => {
    const { run } = await seed();
    const before = await snapshot();

    // 夹具不能是空的：否则"前后相等"证明不了任何事
    expect(before[STORE.words]).toHaveLength(2);
    expect(before[STORE.scenes]).toHaveLength(3);

    const rows = await loadRows();
    const scenesByWord = await loadScenesByWord();
    const records = buildRecords(toRecordInputs(rows, scenesByWord));

    for (const target of ['anki', 'csv', 'bbdc', 'maimemo'] as const) {
      expect(buildExportFile({ target, records }).text.length).toBeGreaterThan(0);
    }
    const { words, scenes } = collectBackupData(rows, scenesByWord);
    expect(
      buildExportFile({
        target: 'json',
        records,
        backup: buildBackupPayload({ words, scenes, appVersion: 'test', dictVersion: 'test' }),
      }).text.length,
    ).toBeGreaterThan(0);

    const after = await snapshot();
    expect(after).toEqual(before);

    // 顺带锁住"哪些字段会被导出脚本碰到"这件事：导出不会让 meetCount 涨
    const afterRun = (after[STORE.words] as Word[]).find((word) => word.lemma === 'run');
    expect(afterRun?.meetCount).toBe(run.meetCount);
    expect(afterRun?.updatedAt).toBe(run.updatedAt);
  });
});
