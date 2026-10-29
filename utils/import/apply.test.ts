/**
 * 写入层的测试（PLAN.md FR-J4 / FR-J6 / FR-J7 的落库部分）。
 *
 * 前三层都是纯函数，"能不能真的导进去"只有这一层能证：
 * 真实 IndexedDB（fake-indexeddb）+ 真实写入路径（`upsertWord` / `addScene`）做夹具，
 * 因此 FR-B9 / FR-B10 的不变式会在夹具上先失败（`CONSTRAINTS.md` 第 16 条）。
 */
import { describe, expect, it } from 'vitest';
import { req, readTx, STORE, writeTx } from '../db/schema';
import type { Word } from '../db/types';
import { addScene, listScenesByWord, listWords, upsertWord } from '../db/words';
import { applyImportPlan } from './apply';
import { loadExistingData } from './collect';
import { parseImport } from './parse';
import { planImport, type DictProbe, type ImportPlan, type ImportStats } from './plan';
import { metwordExport } from './testing';

const probe: DictProbe = {
  lookup(surface) {
    const table: Record<string, { lemma: string; phoneticUs: string; defZh: string[]; pos: string[] }> = {
      run: { lemma: 'run', phoneticUs: 'rʌn', defZh: ['v. 跑'], pos: ['v.'] },
      running: { lemma: 'run', phoneticUs: 'rʌn', defZh: ['v. 跑'], pos: ['v.'] },
      // 收录的第二个词：用来把"未收录"限定在 `proof` 一条上
      gone: { lemma: 'gone', phoneticUs: 'ɡɒn', defZh: ['go 的过去分词'], pos: ['v.'] },
    };
    return table[surface.trim().toLowerCase()];
  },
};

/** 真实文件的一次导入：解析 → 预演 → 执行 */
async function importFile(json: unknown): Promise<{ plan: ImportPlan; stats: ImportStats }> {
  const bundle = parseImport(JSON.stringify(json));
  const existing = await loadExistingData();
  const plan = planImport(bundle, existing, { probe, now: 1_700_000_000_000 });
  const stats = await applyImportPlan(plan);
  return { plan, stats };
}

/** 六个 store 的原始内容（预演不该改动其中任何一条） */
async function snapshot(): Promise<Record<string, unknown>> {
  const stores = [STORE.words, STORE.scenes, STORE.translations, STORE.queue, STORE.settings, STORE.meta] as const;
  return readTx([...stores], async (tx) => {
    const out: Record<string, unknown> = {};
    for (const store of stores) out[store] = await req(tx.objectStore(store).getAll());
    return out;
  });
}

const FILE = metwordExport([
  {
    word: 'running',
    meetCount: 3,
    defZh: ['v. 跑（原平台）'],
    phoneticUs: 'ˈrʌnɪŋ',
    scenes: [
      { text: 'I am running.', sourceUrl: 'https://a.com/1', capturedAt: '2026-09-02' },
      { text: 'Running is fun.', sourceUrl: 'https://b.com/2', capturedAt: '2026-09-03' },
    ],
  },
  { word: 'proof', meetCount: 2, defZh: ['n. 证据'], scenes: [{ text: 'This is a proof.' }] },
  { word: 'gone', status: 'known' },
]);

describe('FR-J4 / FR-J5：真的写进库', () => {
  it('词、例句、来源域名、时间都落库；未收录的词带兜底释义', async () => {
    const { stats } = await importFile(FILE);

    expect(stats.words).toBe(3);
    expect(stats.newWords).toBe(3);
    expect(stats.newScenes).toBe(3);
    expect(stats.unlistedWords).toBe(1); // proof

    const words = await listWords({ orderBy: 'lemma', direction: 'asc' });
    expect(words.map((word) => word.lemma)).toEqual(['gone', 'proof', 'run']);

    const run = words.find((word) => word.lemma === 'run')!;
    expect(run.phoneticUs).toBe('rʌn');
    expect(run.phoneticSrc).toBe('pipeline');
    expect(run.defZh).toEqual(['v. 跑']);
    expect(run.defSrc).toBe('authored');
    expect(run.meetCount).toBe(3);
    expect(run.origin).toBe('migrated');
    expect(run.createdAt).toBe(Date.parse('2026-09-01'));

    const scenes = await listScenesByWord(run.id);
    expect(scenes.map((scene) => scene.text)).toEqual(['I am running.', 'Running is fun.']);
    expect(scenes[0]!.domain).toBe('a.com');
    expect(scenes[0]!.capturedAt).toBe(Date.parse('2026-09-02'));

    const proof = words.find((word) => word.lemma === 'proof')!;
    expect(proof.isUnlisted).toBe(true);
    expect(proof.defZh).toEqual([]);
    expect(proof.fallbackDef).toEqual(['n. 证据']);
  });

  it('库里已有的音标与释义不被导入值覆盖（FR-J4 的验收原话）', async () => {
    // 夹具走真实写入路径：自撰释义 + pipeline 音标
    await upsertWord({
      lemma: 'run',
      surface: 'runs',
      defZh: ['自撰释义'],
      defSrc: 'authored',
      phoneticUs: 'rʌn',
      phoneticSrc: 'pipeline',
      now: 100,
    });

    await importFile(metwordExport([{ word: 'running', defZh: ['原平台释义'], phoneticUs: 'ˈrʌnɪŋ' }]));

    const run = (await listWords()).find((word) => word.lemma === 'run')!;
    expect(run.defZh).toEqual(['自撰释义']);
    expect(run.defSrc).toBe('authored');
    expect(run.phoneticUs).toBe('rʌn');
    expect(run.phoneticSrc).toBe('pipeline');
    expect(run.surface).toBe('runs'); // 首次遇见的形态也不改写
    expect(run.createdAt).toBe(100);
  });
});

describe('FR-J5 / FR-J7：预演后执行时保护新状态', () => {
  it('旧计划不覆盖预演后新增的计数、状态、修改时间与墓碑', async () => {
    const { word: seeded } = await upsertWord({ lemma: 'run', now: 100 });
    const bundle = parseImport(JSON.stringify(metwordExport([{ word: 'running', meetCount: 3 }])));
    const plan = planImport(bundle, await loadExistingData(), { probe, now: 1_000 });

    await writeTx(STORE.words, async (tx) => {
      const store = tx.objectStore(STORE.words);
      const current = await req<Word>(store.get(seeded.id));
      await req(store.put({
        ...current,
        meetCount: 7,
        status: 'ignored',
        updatedAt: 2_000,
        deletedAt: 2_000,
      }));
    });

    const stats = await applyImportPlan(plan);
    const current = await readTx(STORE.words, (tx) =>
      req<Word>(tx.objectStore(STORE.words).get(seeded.id)),
    );
    expect(current).toMatchObject({
      meetCount: 7,
      status: 'ignored',
      updatedAt: 2_000,
      deletedAt: 2_000,
    });
    expect(stats).toBe(plan.stats);
  });

  it('未发生预演后修改时 MetWord 状态仍以导入值为准', async () => {
    const { word: seeded } = await upsertWord({ lemma: 'run', status: 'ignored', now: 2_000 });
    const bundle = parseImport(JSON.stringify(metwordExport([{ word: 'run', status: 'known' }])));
    const plan = planImport(bundle, await loadExistingData(), { probe, now: 1_000 });
    expect(plan.words[0]!.word.status).toBe('known');

    await applyImportPlan(plan);

    const current = await readTx(STORE.words, (tx) =>
      req<Word>(tx.objectStore(STORE.words).get(seeded.id)),
    );
    expect(current.status).toBe('known');
  });

  it('旧计划不覆盖预演后新增的同 hash 例句', async () => {
    const { word: seeded } = await upsertWord({ lemma: 'run', now: 100 });
    const bundle = parseImport(JSON.stringify(metwordExport([{
      word: 'running',
      scenes: [{ text: 'A concurrent scene.', sourceUrl: 'https://old.example/1' }],
    }])));
    const plan = planImport(bundle, await loadExistingData(), { probe, now: 1_000 });
    const { scene: concurrent } = await addScene({
      wordId: seeded.id,
      text: 'A concurrent scene.',
      highlightFrom: 0,
      highlightTo: 1,
      sourceUrl: 'https://new.example/2',
      capturedAt: 2_000,
    });

    await applyImportPlan(plan);

    const scenes = await listScenesByWord(seeded.id);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({
      id: concurrent.id,
      sourceUrl: 'https://new.example/2',
      capturedAt: 2_000,
    });
  });

  it('预演后新建同 lemma 词时沿用当前 id 并重算例句 hash', async () => {
    const bundle = parseImport(JSON.stringify(metwordExport([{
      word: 'running',
      meetCount: 3,
      scenes: [{ text: 'A scene created during confirmation.' }],
    }])));
    const plan = planImport(bundle, await loadExistingData(), { probe, now: 1_000 });
    const planned = plan.words[0]!.word;
    const { word: current } = await upsertWord({ lemma: 'run', now: 2_000 });
    const { scene: concurrent } = await addScene({
      wordId: current.id,
      text: 'A scene created during confirmation.',
      highlightFrom: 0,
      highlightTo: 1,
      sourceUrl: 'https://new.example/2',
      capturedAt: 2_000,
    });

    await applyImportPlan(plan);

    const words = await listWords();
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({ id: current.id, lemma: 'run', meetCount: 3 });
    expect(await listScenesByWord(current.id)).toEqual([concurrent]);
    expect(await listScenesByWord(planned.id)).toEqual([]);
  });
});

describe('FR-J6：幂等', () => {
  it('同一份文件连导两次：词数、句数、meetCount 都不变', async () => {
    const first = await importFile(FILE);

    const wordsAfterFirst = await listWords();
    const scenesAfterFirst = await listScenesByWord(
      wordsAfterFirst.find((word) => word.lemma === 'run')!.id,
    );
    const meetsAfterFirst = wordsAfterFirst.map((word) => [word.lemma, word.meetCount] as const).sort();

    // 第二次：同一份文件、同样的入口
    const second = await importFile(FILE);

    const wordsAfterSecond = await listWords();
    const scenesAfterSecond = await listScenesByWord(
      wordsAfterSecond.find((word) => word.lemma === 'run')!.id,
    );

    expect(wordsAfterSecond).toHaveLength(wordsAfterFirst.length);
    expect(scenesAfterSecond).toHaveLength(scenesAfterFirst.length);
    expect(wordsAfterSecond.map((word) => [word.lemma, word.meetCount] as const).sort()).toEqual(
      meetsAfterFirst,
    );

    // 第二次的统计：一个新词一个新句都不该有
    expect(second.stats.newWords).toBe(0);
    expect(second.stats.mergedWords).toBe(3);
    expect(second.stats.newScenes).toBe(0);
    expect(second.stats.duplicateScenes).toBe(3);
    expect(second.stats.words).toBe(first.stats.words);
  });

  it('例句 id 不变（第二次没有重建它们）', async () => {
    await importFile(FILE);
    const before = (await listWords()).find((word) => word.lemma === 'run')!;
    const idsBefore = (await listScenesByWord(before.id)).map((scene) => scene.id);

    await importFile(FILE);
    const after = (await listWords()).find((word) => word.lemma === 'run')!;
    expect((await listScenesByWord(after.id)).map((scene) => scene.id)).toEqual(idsBefore);
  });
});

describe('FR-J7：预演不写库，且数字与导入结果一致', () => {
  it('只做预演：六个 store 逐条快照不变', async () => {
    await upsertWord({ lemma: 'keep', surface: 'keep', defZh: ['x'], defSrc: 'authored' });
    const before = await snapshot();

    const bundle = parseImport(JSON.stringify(FILE));
    const plan = planImport(bundle, await loadExistingData(), { probe });

    expect(plan.stats.newWords).toBe(3);
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('预演返回的 stats 与导入返回的 stats 逐字段相等（同一条代码路径）', async () => {
    const { plan, stats } = await importFile(FILE);
    expect(stats).toEqual(plan.stats);
    // 而且真的写进去了——否则"相等"毫无意义
    expect(await listWords()).toHaveLength(3);
  });

  it('预演数字在已有一半数据时也准（新增/合并分开算）', async () => {
    await importFile(metwordExport([{ word: 'run' }]));

    const bundle = parseImport(JSON.stringify(FILE));
    const plan = planImport(bundle, await loadExistingData(), { probe });

    expect(plan.stats.words).toBe(3);
    expect(plan.stats.newWords).toBe(2);
    expect(plan.stats.mergedWords).toBe(1);
  });
});

describe('备份回灌（M1-7 的 JSON）', () => {
  it('导出的备份能被导回来（词与例句都在）', async () => {
    // 造一条真实的库，导出成备份，再清空后回灌
    const { word } = await upsertWord({
      lemma: 'run',
      surface: 'running',
      defZh: ['v. 跑'],
      defSrc: 'authored',
      phoneticUs: 'rʌn',
      phoneticSrc: 'pipeline',
      examTags: ['CET4'],
    });
    await addScene({
      wordId: word.id,
      text: 'I run daily.',
      highlightFrom: 2,
      highlightTo: 5,
      sourceUrl: 'https://a.com/1',
      capturedAt: 111,
    });

    const backup = {
      app: 'leximate',
      schemaVersion: 1,
      exportedAt: '2026-10-16T00:00:00.000Z',
      appVersion: '0.1.0',
      dictVersion: '0.1.0',
      counts: { words: 1, scenes: 1 },
      words: [word],
      scenes: await listScenesByWord(word.id),
    };

    // 清空数据 store（保留设置），回灌
    await writeTx([STORE.words, STORE.scenes], (tx) => {
      tx.objectStore(STORE.words).clear();
      tx.objectStore(STORE.scenes).clear();
    });

    const { stats } = await importFile(backup);

    expect(stats.newWords).toBe(1);
    expect(stats.newScenes).toBe(1);
    const restored = (await listWords())[0]!;
    expect(restored.lemma).toBe('run');
    expect(restored.surface).toBe('running');
    expect(restored.examTags).toEqual(['CET4']);
    expect((await listScenesByWord(restored.id))[0]!.text).toBe('I run daily.');
  });
});
