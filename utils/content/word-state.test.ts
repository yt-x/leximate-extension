/**
 * 词状态读写的单测（PLAN.md FR-A10、FR-A17）。
 *
 * 用真实 IndexedDB（fake-indexeddb）而不是打桩，因为这里要验的正是
 * "缓存与库的一致性"——打桩就测不出缓存骗人的情况。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbHandle } from '../db/schema';
import { getWordByLemma, listScenesByWord, upsertWord } from '../db/words';
import { createWordStateStore, UNSEEN } from './word-state';
import type { MeetRecord } from './word-state-shared';

/**
 * 造一条记账内容。
 *
 * 记账**不是一个裸字符串**（§2 数据模型）：要同时给出记账键（lemma）、
 * 页面原形（surface）与是否未收录（isUnlisted）。
 */
function meet(lemma: string, patch: Partial<MeetRecord> = {}): MeetRecord {
  return { lemma, surface: lemma, unlisted: false, ...patch };
}

async function freshStore() {
  // 每个用例清库，避免相互污染
  const { clearAllData } = await import('../db/maintenance');
  await clearAllData();
  resetDbHandle();
  return createWordStateStore();
}

describe('FR-A10：读状态', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('没见过的词按生词零次处理（首次遇见就该被标注）', async () => {
    const store = createWordStateStore();
    expect(await store.get('neverseen')).toEqual(UNSEEN);
  });

  it('peek 未缓存时返回 undefined（供同步标注路径）', () => {
    const store = createWordStateStore();
    expect(store.peek('run')).toBeUndefined();
  });

  it('get 之后 peek 能同步读到', async () => {
    const store = createWordStateStore();
    await store.get('run');
    expect(store.peek('run')).toEqual(UNSEEN);
  });

  it('大小写与空白归一：Run 与 run 同一条', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('Run'));
    expect(store.peek('run')!.meetCount).toBe(1);
    expect(store.peek('  run ')!.meetCount).toBe(1);
  });

  it('空词不会崩', async () => {
    const store = createWordStateStore();
    expect(await store.get('')).toEqual(UNSEEN);
    expect(await store.get('   ')).toEqual(UNSEEN);
  });

  it('读到已有记录的状态与次数', async () => {
    await upsertWord({ lemma: 'run' });
    await upsertWord({ lemma: 'run' });

    const store = createWordStateStore();
    const state = await store.get('run');
    expect(state.meetCount).toBe(2);
    expect(state.status).toBe('new');
  });
});

describe('FR-A17：遇见次数累加', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('首次遇见创建记录并计为 1', async () => {
    const store = createWordStateStore();
    const state = await store.recordMeet(meet('run'));
    expect(state.meetCount).toBe(1);
  });

  it('重复遇见累加', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    await store.recordMeet(meet('run'));
    const state = await store.recordMeet(meet('run'));
    expect(state.meetCount).toBe(3);
  });

  it('计数写穿缓存，peek 立刻能看到新值', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    // 不等下次 get，同步读就该是新值
    expect(store.peek('run')!.meetCount).toBe(1);
  });

  it('空词不计数', async () => {
    const store = createWordStateStore();
    expect(await store.recordMeet(meet(''))).toEqual(UNSEEN);
    expect(await store.recordMeet(meet('   '))).toEqual(UNSEEN);
  });

  it('不同词各自计数', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    await store.recordMeet(meet('go'));
    expect(store.peek('run')!.meetCount).toBe(1);
    expect(store.peek('go')!.meetCount).toBe(1);
  });
});

describe('FR-A6：改状态', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('标记为已掌握（FR-A10：之后不再标注）', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));

    const state = await store.setStatus('run', 'known');
    expect(state.status).toBe('known');
    expect(store.peek('run')!.status).toBe('known');
  });

  it('改状态**不动**遇见次数（点"已掌握"不是又遇见一次）', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    await store.recordMeet(meet('run'));

    const state = await store.setStatus('run', 'known');
    expect(state.meetCount).toBe(2);
  });

  it('改回生词', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    await store.setStatus('run', 'known');

    const state = await store.setStatus('run', 'new');
    expect(state.status).toBe('new');
  });

  it('忽略', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    expect((await store.setStatus('run', 'ignored')).status).toBe('ignored');
  });

  it('词库里没有时返回 UNSEEN（不凭空造记录）', async () => {
    const store = createWordStateStore();
    expect(await store.setStatus('absent', 'known')).toEqual(UNSEEN);
  });

  it('改状态后写穿缓存', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    await store.setStatus('run', 'known');
    expect(store.peek('run')!.status).toBe('known');
  });
});

describe('缓存管理', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('clear 后 peek 返回 undefined', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    store.clear();
    expect(store.peek('run')).toBeUndefined();
  });

  it('clear 后重新 get 仍能从库读回（缓存不是数据源）', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run'));
    store.clear();
    expect((await store.get('run')).meetCount).toBe(1);
  });
});

/**
 * 记账语义的验收（`PLAN.md` §2 数据模型 + FR-B3 / FR-B4 / FR-B9 / FR-B10）。
 *
 * 这些用例对应**用户报的两个现象**：
 * - "learning 可以匹配、learni 也可以匹配"：变形词与未收录词各自的记账方式
 * - "没匹配到任何单词也认定为正确的单词"：未收录词必须能被认出来
 */
describe('§2 数据模型：记账键是 lemma，未收录要标出来', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('变形词累加到**词条原形**上，不新建一条以页面词形为键的词条', async () => {
    const store = createWordStateStore();

    await store.recordMeet(meet('run', { surface: 'running' }));

    expect(store.peek('run')!.meetCount).toBe(1);
    // 旧实现会在库里造出 lemma='running' 的第二条记录
    expect(await getWordByLemma('running')).toBeUndefined();

    const word = await getWordByLemma('run');
    expect(word!.surface).toBe('running');
    expect(word!.isLemmatized).toBe(true);
  });

  it('未收录的词照常采集，但带 isUnlisted 标记（FR-B4）', async () => {
    const store = createWordStateStore();

    await store.recordMeet(meet('learni', { surface: 'Learnin', unlisted: true }));

    const word = await getWordByLemma('learni');
    expect(word!.isUnlisted).toBe(true);
    expect(word!.surface).toBe('Learnin');
    expect(store.peek('learni')!.meetCount).toBe(1);
  });

  it('未收录的词没有音标与释义也不被拒写（FR-B9/B10 只约束"有就必须标来源"）', async () => {
    const store = createWordStateStore();
    await expect(store.recordMeet(meet('qqqzzz', { unlisted: true }))).resolves.toMatchObject({
      meetCount: 1,
    });
  });

  it('命中时回填音标与释义，并标出来源（FR-B9 pipeline / FR-B10 authored）', async () => {
    const store = createWordStateStore();

    await store.recordMeet(
      meet('run', {
        surface: 'running',
        dict: { phoneticUs: '/rʌn/', pos: ['v.'], defZh: ['跑'] },
      }),
    );

    const word = await getWordByLemma('run');
    expect(word!.phoneticUs).toBe('/rʌn/');
    expect(word!.phoneticSrc).toBe('pipeline');
    expect(word!.defZh).toEqual(['跑']);
    expect(word!.defSrc).toBe('authored');
  });

  it('同一个词条被再次遇见时只累加次数，不改写首次的 surface', async () => {
    const store = createWordStateStore();

    await store.recordMeet(meet('run', { surface: 'running' }));
    await store.recordMeet(meet('run', { surface: 'runs' }));

    const word = await getWordByLemma('run');
    expect(word!.meetCount).toBe(2);
    expect(word!.surface).toBe('running');
  });

  it('升级场景：先以未收录身份记下的词，后来命中词库时标记被纠正', async () => {
    const store = createWordStateStore();

    await store.recordMeet(meet('covid', { unlisted: true }));
    expect((await getWordByLemma('covid'))!.isUnlisted).toBe(true);

    await store.recordMeet(
      meet('covid', { dict: { phoneticUs: '/ˈkoʊvɪd/', pos: ['n.'], defZh: ['新冠'] } }),
    );

    expect((await getWordByLemma('covid'))!.isUnlisted).toBe(false);
  });
});

describe('FR-C1：例句随记账写入', () => {
  const scene = (text: string, from: number, to: number) => ({
    text,
    highlightFrom: from,
    highlightTo: to,
    sourceUrl: 'https://example.com/a',
    sourceTitle: 'Example',
  });

  it('记账带例句 → 写进 scenes；域名与时间由存储层补', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run', { scene: scene('He ran fast.', 3, 6) }));

    const word = await getWordByLemma('run');
    expect(word).toBeDefined();
    const scenes = await listScenesByWord(word?.id ?? '');
    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.text).toBe('He ran fast.');
    expect(scenes[0]?.highlightFrom).toBe(3);
    expect(scenes[0]?.highlightTo).toBe(6);
    expect(scenes[0]?.domain).toBe('example.com');
    expect(typeof scenes[0]?.capturedAt).toBe('number');
  });

  it('返回真实 Scene.id，供翻译 worker 回查原文', async () => {
    const store = createWordStateStore();

    const result = await store.recordMeet(meet('run', { scene: scene('He ran fast.', 3, 6) }));

    const word = await getWordByLemma('run');
    const scenes = await listScenesByWord(word?.id ?? '');
    expect(result).toMatchObject({ sceneId: scenes[0]?.id });
    expect(result.sceneId).not.toBe('run');
  });

  it('不带例句的记账照旧（行为与没有例句采集时一致）', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('walk'));

    const word = await getWordByLemma('walk');
    expect(await listScenesByWord(word?.id ?? '')).toHaveLength(0);
  });

  it('同词同句只存一条（FR-C3）', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run', { scene: scene('He ran fast.', 3, 6) }));
    await store.recordMeet(meet('run', { scene: scene('He ran fast.', 3, 6) }));

    const word = await getWordByLemma('run');
    expect(await listScenesByWord(word?.id ?? '')).toHaveLength(1);
  });

  it('同词不同句各存一条（每个词可累积多条例句）', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run', { scene: scene('He ran fast.', 3, 6) }));
    await store.recordMeet(meet('run', { scene: scene('She ran home.', 4, 7) }));

    const word = await getWordByLemma('run');
    expect(await listScenesByWord(word?.id ?? '')).toHaveLength(2);
  });

  it('OQ14：状态为忽略的词不再采集例句', async () => {
    const store = createWordStateStore();
    await store.recordMeet(meet('run', { scene: scene('He ran fast.', 3, 6) }));
    await store.setStatus('run', 'ignored');
    await store.recordMeet(meet('run', { scene: scene('Another sentence.', 0, 7) }));

    const word = await getWordByLemma('run');
    expect(await listScenesByWord(word?.id ?? '')).toHaveLength(1);
    expect(word?.status).toBe('ignored');
  });
});
