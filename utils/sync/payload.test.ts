/**
 * 同步载荷的打包与校验（PLAN.md FR-H2 / FR-H7）。
 *
 * 两条最容易出事的：**版本不符必须整体拒绝**、**凭据一个都不能出去**。
 */
import { describe, expect, it } from 'vitest';
import { makeWord } from '../manager/testing';
import {
  SYNC_SCHEMA_VERSION,
  buildPayload,
  findCredentialLeak,
  parsePayload,
} from './payload';
import type { Scene } from '../db/types';

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  wordId: 'w1',
  text: 'Hello there.',
  highlightFrom: 0,
  highlightTo: 5,
  translation: null,
  sourceUrl: 'https://example.com/a',
  sourceTitle: 'A',
  domain: 'example.com',
  capturedAt: 100,
  contentHash: 'h1',
  ...over,
});

describe('FR-H2：打包', () => {
  it('带上 kind / schemaVersion / updatedAt 与两类数据', () => {
    const payload = buildPayload({ words: [makeWord({ lemma: 'run' })], scenes: [scene()], now: 777 });

    expect(payload.kind).toBe('leximate-sync');
    expect(payload.schemaVersion).toBe(SYNC_SCHEMA_VERSION);
    expect(payload.updatedAt).toBe(777);
    expect(payload.words).toHaveLength(1);
    expect(payload.scenes).toHaveLength(1);
  });

  it('墓碑一起带走（删掉的词必须能同步过去，否则会复活）', () => {
    const payload = buildPayload({
      words: [makeWord({ lemma: 'gone', deletedAt: 999 })],
      scenes: [],
    });

    expect(payload.words[0]?.deletedAt).toBe(999);
  });

  it('不改动入参对象（打包是纯的）', () => {
    const word = makeWord({ lemma: 'run' });
    const before = JSON.stringify(word);
    buildPayload({ words: [word], scenes: [] });
    expect(JSON.stringify(word)).toBe(before);
  });
});

describe('FR-H2：校验', () => {
  const good = JSON.stringify(buildPayload({ words: [makeWord({ lemma: 'run' })], scenes: [scene()], now: 1 }));

  it('正常载荷能读通', () => {
    const result = parsePayload(good);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.words).toHaveLength(1);
  });

  it('不是 JSON → not-json', () => {
    expect(parsePayload('{oops')).toEqual({ ok: false, reason: 'not-json' });
  });

  it('不是同步载荷 → not-sync（不会误把备份当同步文件合并）', () => {
    expect(parsePayload(JSON.stringify({ kind: 'leximate-backup', schemaVersion: 1 }))).toEqual({
      ok: false,
      reason: 'not-sync',
    });
  });

  it('版本不符 → 整体拒绝，不做"尽力导一半"', () => {
    const payload = JSON.parse(good) as Record<string, unknown>;
    payload.schemaVersion = 99;
    expect(parsePayload(JSON.stringify(payload))).toEqual({ ok: false, reason: 'version' });
  });

  it('形状不对 → shape', () => {
    const noWords = JSON.parse(good) as Record<string, unknown>;
    delete noWords.words;
    expect(parsePayload(JSON.stringify(noWords))).toEqual({ ok: false, reason: 'shape' });

    const badRow = JSON.parse(good) as Record<string, unknown>;
    badRow.words = [{ updatedAt: 1 }];
    expect(parsePayload(JSON.stringify(badRow))).toEqual({ ok: false, reason: 'shape' });

    const badTime = JSON.parse(good) as Record<string, unknown>;
    badTime.updatedAt = '昨天';
    expect(parsePayload(JSON.stringify(badTime))).toEqual({ ok: false, reason: 'shape' });
  });

  it('Word / Scene 缺少任一完整模型字段都整体拒绝', () => {
    for (const key of Object.keys(makeWord({ lemma: 'run' }))) {
      const payload = JSON.parse(good) as { words: Array<Record<string, unknown>> };
      delete payload.words[0]?.[key];
      expect(parsePayload(JSON.stringify(payload)), `Word.${key}`).toEqual({ ok: false, reason: 'shape' });
    }
    for (const key of Object.keys(scene())) {
      const payload = JSON.parse(good) as { scenes: Array<Record<string, unknown>> };
      delete payload.scenes[0]?.[key];
      expect(parsePayload(JSON.stringify(payload)), `Scene.${key}`).toEqual({ ok: false, reason: 'shape' });
    }
  });

  it('Word / Scene 任一字段的运行时类型错误都整体拒绝', () => {
    const invalidWordValues: Record<string, unknown> = {
      id: 1, lemma: 1, surface: 1, phoneticUs: 1, phoneticUk: 1,
      phoneticSrc: 'unknown', defSrc: 'unknown', defZh: [1], pos: [1], examTags: [1],
      freqBnc: '0', freqCoca: '0', exchange: 1, status: 'other', meetCount: '1',
      isLemmatized: 1, inflectionOf: 1, isUnlisted: 1, origin: 'other',
      fallbackDef: [1], llmDef: [1], createdAt: '1', updatedAt: '1', deletedAt: 'null',
    };
    for (const [key, value] of Object.entries(invalidWordValues)) {
      const payload = JSON.parse(good) as { words: Array<Record<string, unknown>> };
      payload.words[0]![key] = value;
      expect(parsePayload(JSON.stringify(payload)), `Word.${key}`).toEqual({ ok: false, reason: 'shape' });
    }

    const invalidSceneValues: Record<string, unknown> = {
      id: 1, wordId: 1, text: 1, highlightFrom: '0', highlightTo: '1', translation: 1,
      sourceUrl: 1, sourceTitle: 1, domain: 1, capturedAt: '1', contentHash: 1,
    };
    for (const [key, value] of Object.entries(invalidSceneValues)) {
      const payload = JSON.parse(good) as { scenes: Array<Record<string, unknown>> };
      payload.scenes[0]![key] = value;
      expect(parsePayload(JSON.stringify(payload)), `Scene.${key}`).toEqual({ ok: false, reason: 'shape' });
    }
  });
});

describe('FR-H7：凭据不入载荷', () => {
  it('打包结果里没有任何凭据键', () => {
    const payload = buildPayload({ words: [makeWord({ lemma: 'run' })], scenes: [scene()] });
    expect(findCredentialLeak(payload)).toEqual([]);
  });

  it('凭据检查本身有效（塞一个就该被找出来）', () => {
    expect(findCredentialLeak({ a: { password: 'x' } })).toEqual(['$.a.password']);
    expect(findCredentialLeak({ list: [{ apiKey: 'k' }] })).toEqual(['$.list[0].apiKey']);
  });

  it('词条上的字段不会被"顺手全量拷贝"带出凭据（白名单重建）', () => {
    // 模拟调用方误传了带额外键的对象
    const leaky = { ...makeWord({ lemma: 'run' }), password: 'hunter2' } as never;
    const payload = buildPayload({ words: [leaky], scenes: [] });

    expect(findCredentialLeak(payload)).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('hunter2');
  });
});
