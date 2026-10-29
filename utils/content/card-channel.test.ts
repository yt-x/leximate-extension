/**
 * 卡片 ④段读通道的验收（PLAN.md FR-A5 ④段）。
 *
 * 覆盖三层：协议解析（响应不可信）、后台取数（首条例句与首次日期）、消息分支。
 * 控制器的接线在 `controller.test.ts` 里测（那里有现成的弹窗/事件替身）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbHandle } from '../db/schema';
import { addScene, upsertWord } from '../db/words';
import { parseCardResponse } from './gateway';
import { handleContentMessage, type HandlerEnv } from './message-handler';
import { MSG } from './messages';
import { createWordStateStore, type WordStateStore } from './word-state';

async function freshStore(): Promise<WordStateStore> {
  const { clearAllData } = await import('../db/maintenance');
  await clearAllData();
  resetDbHandle();
  return createWordStateStore();
}

function makeEnv(store: WordStateStore): HandlerEnv {
  return {
    store,
    getSettings: async () => ({ enabled: true }),
    openManager: () => {},
    refreshBadge: () => {},
    onWordsChanged: () => {},
    writeLog: async () => {},
  } as unknown as HandlerEnv;
}

describe('parseCardResponse：响应不可信', () => {
  it('合法响应被解析', () => {
    const detail = parseCardResponse({
      firstSeenAt: 1000,
      examples: [{ text: 'He ran fast.', source: 'example.com', at: 900 }],
    });
    expect(detail).toEqual({
      firstSeenAt: 1000,
      examples: [{ text: 'He ran fast.', source: 'example.com', at: 900 }],
    });
  });

  it('examples 不是数组 → undefined（不拿半个对象去改卡片）', () => {
    expect(parseCardResponse({ firstSeenAt: 1, examples: 'nope' })).toBeUndefined();
    expect(parseCardResponse(null)).toBeUndefined();
    expect(parseCardResponse('nope')).toBeUndefined();
    expect(parseCardResponse({ firstSeenAt: 1 })).toBeUndefined();
  });

  it('缺 text 的条目被跳过，其余的照常', () => {
    const detail = parseCardResponse({
      firstSeenAt: 1,
      examples: [{ text: 'ok', source: 'a.com', at: 2 }, { source: 'b.com' }, null],
    });
    expect(detail?.examples).toHaveLength(1);
    expect(detail?.examples[0]?.text).toBe('ok');
  });

  it('firstSeenAt 非数字 → null；source/at 非法 → null', () => {
    const detail = parseCardResponse({
      firstSeenAt: 'yesterday',
      examples: [{ text: 'ok', source: '', at: Number.NaN }],
    });
    expect(detail?.firstSeenAt).toBeNull();
    expect(detail?.examples[0]).toEqual({ text: 'ok', source: null, at: null });
  });
});

describe('FR-A5 ④段：后台 getCard', () => {
  it('首次日期取词条 createdAt，例句只回最早一条并带域名', async () => {
    const store = await freshStore();
    const { word } = await upsertWord({ lemma: 'run', surface: 'run' });
    await addScene({
      wordId: word.id,
      text: 'Later sentence.',
      highlightFrom: 0,
      highlightTo: 5,
      sourceUrl: 'https://later.example.com/x',
      capturedAt: 2000,
    });
    await addScene({
      wordId: word.id,
      text: 'Earlier sentence.',
      highlightFrom: 0,
      highlightTo: 7,
      sourceUrl: 'https://early.example.com/y',
      capturedAt: 1000,
    });

    const card = await store.getCard('run');
    expect(card?.firstSeenAt).toBe(word.createdAt);
    expect(card?.examples).toHaveLength(1);
    expect(card?.examples[0]?.text).toBe('Earlier sentence.');
    expect(card?.examples[0]?.source).toBe('early.example.com');
    expect(card?.examples[0]?.at).toBe(1000);
  });

  it('没有例句时 examples 是空数组（卡片显示"例句尚未采集"）', async () => {
    const store = await freshStore();
    await upsertWord({ lemma: 'walk', surface: 'walk' });

    const card = await store.getCard('walk');
    expect(card?.examples).toEqual([]);
    expect(typeof card?.firstSeenAt).toBe('number');
  });

  it('库里没有这个词 → undefined', async () => {
    const store = await freshStore();
    expect(await store.getCard('neverseen')).toBeUndefined();
  });

  it('空词不查库', async () => {
    const store = await freshStore();
    expect(await store.getCard('   ')).toBeUndefined();
  });
});

describe('FR-A5 ④段：fetch-card 消息', () => {
  it('合法词回 store 的结果', async () => {
    const detail = {
      firstSeenAt: 123,
      examples: [{ text: 'He ran fast.', source: 'example.com', at: 5 }],
    };
    const getCard = vi.fn(async () => detail);
    const store = { getCard } as unknown as WordStateStore;

    const result = await handleContentMessage({ type: MSG.fetchCard, word: 'run' }, makeEnv(store));

    expect(getCard).toHaveBeenCalledWith('run');
    expect(result).toEqual({ handled: true, response: detail });
  });

  it('词不合法 → null，且不查库', async () => {
    const getCard = vi.fn(async () => undefined);
    const store = { getCard } as unknown as WordStateStore;

    const result = await handleContentMessage(
      { type: MSG.fetchCard, word: 42 } as never,
      makeEnv(store),
    );

    expect(getCard).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, response: null });
  });

  it('store 没有这个词 → null（而不是 undefined 穿透消息通道）', async () => {
    const store = { getCard: async () => undefined } as unknown as WordStateStore;
    const result = await handleContentMessage({ type: MSG.fetchCard, word: 'nope' }, makeEnv(store));
    expect(result).toEqual({ handled: true, response: null });
  });
});
