/**
 * 一轮同步的行为（PLAN.md FR-H2 / FR-H3 / FR-H6）。
 *
 * 重点验三件容易出事的事：
 *  - 远端坏了**一动不动**（既不覆盖远端，也不改本地）；
 *  - 需要上传时先写远端（PUT 失败不写本地；其后本地失败可由远端快照恢复）；
 *  - 失败时 `lastSyncAt`**不前移**（否则用户以为成功了）。
 */
import { describe, expect, it, vi } from 'vitest';
import { makeWord } from '../manager/testing';
import { buildPayload } from './payload';
import { syncOnce, type SyncEngineDeps } from './engine';
import type { Scene, Word } from '../db/types';
import { sceneHash } from '../hash';

const scene = (id: string, wordId: string, capturedAt = 1): Scene => ({
  id,
  wordId,
  text: `sentence ${id}`,
  highlightFrom: 0,
  highlightTo: 1,
  translation: null,
  sourceUrl: 'https://example.com',
  sourceTitle: '',
  domain: 'example.com',
  capturedAt,
  contentHash: id,
});

function harness(options: {
  localWords?: Word[];
  localScenes?: Scene[];
  remoteRaw?: string | null;
  failSave?: boolean;
  failWrite?: boolean;
}) {
  const state = {
    words: options.localWords ?? [],
    scenes: options.localScenes ?? [],
    remote: options.remoteRaw ?? null,
    marked: [] as number[],
    writes: 0,
  };

  const deps: SyncEngineDeps = {
    loadWords: async () => state.words,
    loadScenes: async () => state.scenes,
    saveWords: async (rows) => {
      if (options.failSave) throw new Error('本地写失败');
      const byId = new Map(state.words.map((w) => [w.id, w]));
      for (const row of rows) byId.set(row.id, row);
      state.words = [...byId.values()];
    },
    saveScenes: async (rows) => {
      const byId = new Map(state.scenes.map((s) => [s.id, s]));
      for (const row of rows) byId.set(row.id, row);
      state.scenes = [...byId.values()];
    },
    readRemote: async () => state.remote,
    writeRemote: async (body) => {
      if (options.failWrite) throw new Error('远端写失败');
      state.writes += 1;
      state.remote = body;
    },
    markSynced: async (at) => {
      state.marked.push(at);
    },
    now: () => 5000,
    log: vi.fn(),
  };

  return { deps, state };
}

describe('远端为空（第一次同步）', () => {
  it('把本地整份上传，并记下同步时间', async () => {
    const { deps, state } = harness({ localWords: [makeWord({ lemma: 'run', updatedAt: 10 })] });

    const outcome = await syncOnce(deps);

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.uploaded).toBe(true);
    expect(state.writes).toBe(1);
    expect(state.marked).toEqual([5000]);
    expect(state.remote).toContain('leximate-sync');
  });
});

describe('正常合并', () => {
  it('远端有更新的词 → 落到本地', async () => {
    const local = [makeWord({ lemma: 'run', updatedAt: 10 })];
    const remoteWord = { ...makeWord({ lemma: 'run', updatedAt: 20 }), defZh: ['远程释义'] as never };
    const { deps, state } = harness({
      localWords: local,
      remoteRaw: JSON.stringify(buildPayload({ words: [remoteWord as never], scenes: [], now: 1 })),
    });

    const outcome = await syncOnce(deps);

    expect(outcome.status).toBe('ok');
    expect(state.words[0]?.updatedAt).toBe(20);
  });

  it('本地有更新的词 → 上传，远端被更新', async () => {
    const local = [makeWord({ lemma: 'run', updatedAt: 30 })];
    const remoteWord = makeWord({ lemma: 'run', updatedAt: 10 });
    const { deps, state } = harness({
      localWords: local,
      remoteRaw: JSON.stringify(buildPayload({ words: [remoteWord], scenes: [], now: 1 })),
    });

    const outcome = await syncOnce(deps);

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.uploaded).toBe(true);
    expect(JSON.parse(String(state.remote)).words[0].updatedAt).toBe(30);
  });

  it('两侧一致 → 不上传（避免无意义写入，坚果云对连写有限流）', async () => {
    const same = makeWord({ lemma: 'run', updatedAt: 10 });
    const { deps, state } = harness({
      localWords: [same],
      remoteRaw: JSON.stringify(buildPayload({ words: [same], scenes: [], now: 1 })),
    });

    const outcome = await syncOnce(deps);

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.uploaded).toBe(false);
    expect(state.writes).toBe(0);
  });

  it('例句一起同步（远端新增的例句落到本地）', async () => {
    const { deps, state } = harness({
      remoteRaw: JSON.stringify(
        buildPayload({ words: [], scenes: [scene('s1', 'w1')], now: 1 }),
      ),
    });

    await syncOnce(deps);

    expect(state.scenes.map((s) => s.id)).toEqual(['s1']);
  });

  it('同 id Scene 的远端译文不会被本地旧空值覆盖，且双向合并结果一致', async () => {
    const stale = { ...scene('same-scene', 'w1'), translation: null, sourceTitle: '旧标题' };
    const translated = { ...scene('same-scene', 'w1'), translation: '远端译文', sourceTitle: '新标题' };

    for (const [localScene, remoteScene] of [[stale, translated], [translated, stale]] as const) {
      const { deps, state } = harness({
        localScenes: [localScene],
        remoteRaw: JSON.stringify(buildPayload({ words: [], scenes: [remoteScene], now: 1 })),
      });

      const outcome = await syncOnce(deps);

      expect(outcome.status).toBe('ok');
      expect(state.scenes[0]).toMatchObject({ translation: '远端译文', sourceTitle: '新标题' });
      const uploaded = JSON.parse(String(state.remote)) as { scenes: Scene[] };
      expect(uploaded.scenes[0]).toMatchObject({ translation: '远端译文', sourceTitle: '新标题' });
    }
  });
});

describe('FR-H3：双设备同 lemma 的不同 UUID 收敛', () => {
  it('按 lemma 合并内容，生成 idAliases，重映射并去重 Scene，后续双端不再反复上传', async () => {
    const deviceAId = 'device-a-uuid-not-the-lemma';
    const deviceBId = 'device-b-uuid-not-the-lemma';
    const text = 'The same sentence captured on both devices.';
    const deviceAWord = makeWord({ id: deviceAId, lemma: 'run', updatedAt: 10, defZh: ['旧释义'] });
    const deviceBWord = makeWord({ id: deviceBId, lemma: 'run', updatedAt: 20, defZh: ['新释义'] });
    const deviceAScene = {
      ...scene('scene-a', deviceAId),
      text,
      contentHash: sceneHash(deviceAId, text),
    };
    const deviceBScene = {
      ...scene('scene-b', deviceBId),
      text,
      contentHash: sceneHash(deviceBId, text),
    };

    const first = harness({
      localWords: [deviceAWord],
      localScenes: [deviceAScene],
      remoteRaw: JSON.stringify(buildPayload({ words: [deviceBWord], scenes: [deviceBScene], now: 1 })),
    });
    const firstOutcome = await syncOnce(first.deps);

    expect(firstOutcome.status).toBe('ok');
    if (firstOutcome.status === 'ok') expect(firstOutcome.uploaded).toBe(true);
    expect(first.state.words.filter((word) => word.deletedAt === null).map((word) => word.id)).toEqual([deviceBId]);
    expect(first.state.words.find((word) => word.id === deviceAId)?.deletedAt).not.toBeNull();
    expect(first.state.scenes).toHaveLength(1);
    expect(first.state.scenes[0]).toMatchObject({
      wordId: deviceBId,
      contentHash: sceneHash(deviceBId, text),
    });

    const canonical = JSON.parse(String(first.state.remote)) as {
      words: Word[];
      scenes: Scene[];
      idAliases: Record<string, string>;
    };
    expect(canonical.words.filter((word) => word.deletedAt === null)).toHaveLength(1);
    expect(canonical.words[0]).toMatchObject({ id: deviceBId, updatedAt: 20, defZh: ['新释义'] });
    expect(canonical.idAliases).toMatchObject({ [deviceAId]: deviceBId });
    expect(canonical.scenes).toHaveLength(1);
    expect(canonical.scenes[0]).toMatchObject({
      wordId: deviceBId,
      contentHash: sceneHash(deviceBId, text),
    });

    const second = harness({
      localWords: [deviceBWord],
      localScenes: [deviceBScene],
      remoteRaw: String(first.state.remote),
    });
    const secondOutcome = await syncOnce(second.deps);
    expect(secondOutcome.status).toBe('ok');
    if (secondOutcome.status === 'ok') expect(secondOutcome.uploaded).toBe(false);
    expect(second.state.words.filter((word) => word.deletedAt === null).map((word) => word.id)).toEqual([deviceBId]);
    expect(second.state.scenes).toHaveLength(1);
    expect(second.state.scenes[0]?.wordId).toBe(deviceBId);

    const third = harness({
      localWords: first.state.words,
      localScenes: first.state.scenes,
      remoteRaw: String(second.state.remote),
    });
    const thirdOutcome = await syncOnce(third.deps);
    expect(thirdOutcome.status).toBe('ok');
    if (thirdOutcome.status === 'ok') expect(thirdOutcome.uploaded).toBe(false);
    expect(third.state.remote).toBe(second.state.remote);
  });

  it('旧别名 UUID 离线产生较新内容时重定向到新胜者，不形成循环或孤儿 Scene', async () => {
    const oldId = 'offline-old-uuid';
    const remoteId = 'remote-winner-uuid';
    const text = 'sentence after offline edit';
    const remoteRaw = JSON.stringify(buildPayload({
      words: [makeWord({ id: remoteId, lemma: 'run', updatedAt: 20 })],
      scenes: [{ ...scene('remote-scene', remoteId), text, contentHash: sceneHash(remoteId, text) }],
      idAliases: { [oldId]: remoteId },
      now: 1,
    }));
    const { deps, state } = harness({
      localWords: [makeWord({ id: oldId, lemma: 'run', updatedAt: 30, defZh: ['离线新释义'] })],
      localScenes: [{ ...scene('local-scene', oldId), text, contentHash: sceneHash(oldId, text) }],
      remoteRaw,
    });

    const outcome = await syncOnce(deps);

    expect(outcome.status).toBe('ok');
    const canonical = JSON.parse(String(state.remote)) as {
      words: Word[];
      scenes: Scene[];
      idAliases: Record<string, string>;
    };
    expect(canonical.words).toHaveLength(1);
    expect(canonical.words[0]).toMatchObject({ id: oldId, updatedAt: 30, defZh: ['离线新释义'] });
    expect(canonical.idAliases).toEqual({ [remoteId]: oldId });
    expect(canonical.scenes).toHaveLength(1);
    expect(canonical.scenes[0]?.wordId).toBe(oldId);
  });
});

describe('远端坏了一动不动（FR-H6 的"失败不改数据"）', () => {
  it('版本不符 → remote-broken，本地与远端都不变', async () => {
    const bad = JSON.stringify({ kind: 'leximate-sync', schemaVersion: 99, updatedAt: 1, words: [], scenes: [] });
    const { deps, state } = harness({ localWords: [makeWord({ lemma: 'run', updatedAt: 10 })], remoteRaw: bad });

    const outcome = await syncOnce(deps);

    expect(outcome).toMatchObject({ status: 'remote-broken', reason: 'version' });
    expect(state.words[0]?.updatedAt).toBe(10);
    expect(state.remote).toBe(bad);
    expect(state.marked).toEqual([]);
  });

  it('不是同步文件 → 同样不动', async () => {
    const { deps, state } = harness({ remoteRaw: '{"kind":"leximate-backup"}' });

    const outcome = await syncOnce(deps);

    expect(outcome).toMatchObject({ status: 'remote-broken', reason: 'not-sync' });
    expect(state.writes).toBe(0);
  });

  it('残缺 Word 在 save / markSynced 前整体拒绝，且不写本地', async () => {
    const malformed = JSON.parse(
      JSON.stringify(buildPayload({ words: [makeWord({ lemma: 'run', updatedAt: 20 })], scenes: [], now: 1 })),
    ) as { words: Array<Record<string, unknown>> };
    delete malformed.words[0]?.defZh;
    const remoteRaw = JSON.stringify(malformed);
    const { deps, state } = harness({
      localWords: [makeWord({ lemma: 'run', updatedAt: 10 })],
      remoteRaw,
    });
    const saveWords = vi.fn(deps.saveWords);
    const saveScenes = vi.fn(deps.saveScenes);
    const markSynced = vi.fn(deps.markSynced);

    const outcome = await syncOnce({ ...deps, saveWords, saveScenes, markSynced });

    expect(outcome).toMatchObject({ status: 'remote-broken', reason: 'shape' });
    expect(saveWords).not.toHaveBeenCalled();
    expect(saveScenes).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
    expect(state.words[0]?.updatedAt).toBe(10);
    expect(state.remote).toBe(remoteRaw);
  });
});

describe('失败时的记账（FR-H6）', () => {
  it('远端写失败 → error，且 lastSyncAt 不前移', async () => {
    const { deps, state } = harness({ failWrite: true, localWords: [makeWord({ lemma: 'run' })] });

    const outcome = await syncOnce(deps);

    expect(outcome).toMatchObject({ status: 'error' });
    expect(state.marked).toEqual([]);
  });

  it('needsPush 时 PUT 失败 → 本轮 Word / Scene 合并修改都不写本地', async () => {
    const localOnly = makeWord({ id: 'local-only-uuid', lemma: 'local', updatedAt: 30 });
    const stale = { ...scene('same-scene', 'run'), translation: null };
    const translated = { ...scene('same-scene', 'run'), translation: '远端译文' };
    const remoteRaw = JSON.stringify(
      buildPayload({ words: [makeWord({ lemma: 'run', updatedAt: 20 })], scenes: [translated], now: 1 }),
    );
    const { deps, state } = harness({
      failWrite: true,
      localWords: [makeWord({ lemma: 'run', updatedAt: 10 }), localOnly],
      localScenes: [stale],
      remoteRaw,
    });
    const saveWords = vi.fn(deps.saveWords);
    const saveScenes = vi.fn(deps.saveScenes);
    const markSynced = vi.fn(deps.markSynced);

    const outcome = await syncOnce({ ...deps, saveWords, saveScenes, markSynced });

    expect(outcome).toMatchObject({ status: 'error' });
    expect(saveWords).not.toHaveBeenCalled();
    expect(saveScenes).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
    expect(state.words.find((word) => word.lemma === 'run')?.updatedAt).toBe(10);
    expect(state.scenes[0]?.translation).toBeNull();
    expect(state.remote).toBe(remoteRaw);
  });

  it('PUT 成功后本地写失败 → 远端保留合并快照，下一轮无需 PUT 即可恢复本地', async () => {
    const localOnly = makeWord({ id: 'local-only-uuid', lemma: 'local', updatedAt: 30 });
    const localWords = [makeWord({ lemma: 'run', updatedAt: 10 }), localOnly];
    const stale = { ...scene('same-scene', 'run'), translation: null };
    const translated = { ...scene('same-scene', 'run'), translation: '远端译文' };
    const remoteRaw = JSON.stringify(
      buildPayload({ words: [makeWord({ lemma: 'run', updatedAt: 20 })], scenes: [translated], now: 1 }),
    );
    const first = harness({ failSave: true, localWords, localScenes: [stale], remoteRaw });

    const failed = await syncOnce(first.deps);

    expect(failed).toMatchObject({ status: 'error' });
    expect(first.state.writes).toBe(1);
    expect(first.state.marked).toEqual([]);
    const remote = JSON.parse(String(first.state.remote)) as { words: Word[]; scenes: Scene[] };
    expect(remote.words.map((word) => word.lemma).sort()).toEqual(['local', 'run']);
    expect(remote.scenes[0]?.translation).toBe('远端译文');

    const recovery = harness({ localWords, localScenes: [stale], remoteRaw: String(first.state.remote) });
    const recovered = await syncOnce(recovery.deps);
    expect(recovered.status).toBe('ok');
    if (recovered.status === 'ok') expect(recovered.uploaded).toBe(false);
    expect(recovery.state.words.find((word) => word.lemma === 'run')?.updatedAt).toBe(20);
    expect(recovery.state.scenes[0]?.translation).toBe('远端译文');
    expect(recovery.state.marked).toEqual([5000]);
  });

  it('本地写失败 → error，且不写远端（远端保持上一份可用数据）', async () => {
    const remoteRaw = JSON.stringify(
      buildPayload({ words: [makeWord({ lemma: 'run', updatedAt: 20 })], scenes: [], now: 1 }),
    );
    const { deps, state } = harness({
      failSave: true,
      localWords: [makeWord({ lemma: 'run', updatedAt: 10 })],
      remoteRaw,
    });

    const outcome = await syncOnce(deps);

    expect(outcome).toMatchObject({ status: 'error' });
    expect(state.writes).toBe(0);
    expect(state.remote).toBe(remoteRaw);
    expect(state.marked).toEqual([]);
  });
});

describe('FR-H5：可选口令加密', () => {
  it('配了口令 → 远端是密文，且能解回同一份数据', async () => {
    const { deps, state } = harness({ localWords: [makeWord({ lemma: 'run', updatedAt: 10 })] });

    const outcome = await syncOnce({ ...deps, passphrase: 'open sesame' });

    expect(outcome.status).toBe('ok');
    const remote = String(state.remote);
    expect(remote).toContain('leximate-sync-encrypted');
    expect(remote).not.toContain('"lemma"');

    // 再来一轮（同口令）应能解回并判定"两侧一致、无需上传"
    const second = harness({ localWords: [makeWord({ lemma: 'run', updatedAt: 10 })], remoteRaw: remote });
    const again = await syncOnce({ ...second.deps, passphrase: 'open sesame' });
    expect(again.status).toBe('ok');
    if (again.status === 'ok') expect(again.uploaded).toBe(false);
  });

  it('明文远端与本地相同但配了口令 → 仍 PUT 一次升级为密文', async () => {
    const same = makeWord({ lemma: 'run', updatedAt: 10 });
    const { deps, state } = harness({
      localWords: [same],
      remoteRaw: JSON.stringify(buildPayload({ words: [same], scenes: [], now: 1 })),
    });

    const outcome = await syncOnce({ ...deps, passphrase: 'open sesame' });

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.uploaded).toBe(true);
    expect(state.writes).toBe(1);
    expect(String(state.remote)).toContain('leximate-sync-encrypted');
    expect(String(state.remote)).not.toContain('"lemma"');
    expect(state.marked).toEqual([5000]);
  });

  it('口令不对 → remote-broken，本地与远端都不动', async () => {
    const first = harness({ localWords: [makeWord({ lemma: 'run', updatedAt: 10 })] });
    await syncOnce({ ...first.deps, passphrase: 'right' });
    const remote = String(first.state.remote);

    const second = harness({ localWords: [makeWord({ lemma: 'run', updatedAt: 10 })], remoteRaw: remote });
    const outcome = await syncOnce({ ...second.deps, passphrase: 'wrong' });

    expect(outcome).toMatchObject({ status: 'remote-broken', reason: 'wrong-password' });
    expect(second.state.remote).toBe(remote);
    expect(second.state.writes).toBe(0);
  });

  it('远端是密文但没配口令 → remote-broken（不假装成功）', async () => {
    const first = harness({ localWords: [makeWord({ lemma: 'run' })] });
    await syncOnce({ ...first.deps, passphrase: 'pw' });

    const second = harness({ remoteRaw: String(first.state.remote) });
    const outcome = await syncOnce(second.deps);

    expect(outcome).toMatchObject({ status: 'remote-broken', reason: 'encrypted-without-passphrase' });
  });

  it('把加密关掉后再同步：解不开就不覆盖远端（不会把密文冲成明文）', async () => {
    const first = harness({ localWords: [makeWord({ lemma: 'run' })] });
    await syncOnce({ ...first.deps, passphrase: 'pw' });
    const remote = String(first.state.remote);

    const second = harness({ localWords: [makeWord({ lemma: 'run' })], remoteRaw: remote });
    const outcome = await syncOnce(second.deps); // 没给口令

    expect(outcome).toMatchObject({ status: 'remote-broken' });
    expect(second.state.remote).toBe(remote);
  });
});
