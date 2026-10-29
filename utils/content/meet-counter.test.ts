/**
 * 遇见次数去抖单测（PLAN.md FR-A17）。
 *
 * 验收判定点名"30 秒去重有单元测试"，因此这里逐条锁住窗口语义——
 * 尤其**窗口边界**与**连续误触不推窗**这两个容易写错的地方。
 */
import { describe, expect, it } from 'vitest';
import { createMeetCounter, MEET_DEBOUNCE_MS } from './meet-counter';

describe('FR-A17：30 秒去抖', () => {
  it('首次遇见计数', () => {
    const counter = createMeetCounter();
    expect(counter.hit('run', 0)).toBe(true);
  });

  it('窗口内重复触发不计数', () => {
    const counter = createMeetCounter();
    expect(counter.hit('run', 0)).toBe(true);
    expect(counter.hit('run', 1_000)).toBe(false);
    expect(counter.hit('run', 29_999)).toBe(false);
  });

  it('窗口边界：恰好 30 秒时计数（用 < 而非 <=）', () => {
    const counter = createMeetCounter();
    expect(counter.hit('run', 0)).toBe(true);
    expect(counter.hit('run', MEET_DEBOUNCE_MS - 1)).toBe(false);
    expect(counter.hit('run', MEET_DEBOUNCE_MS)).toBe(true);
  });

  it('连续误触不会把窗口一直往后推', () => {
    const counter = createMeetCounter();
    expect(counter.hit('run', 0)).toBe(true);
    // 每 10 秒碰一次，碰 5 次
    expect(counter.hit('run', 10_000)).toBe(false);
    expect(counter.hit('run', 20_000)).toBe(false);
    expect(counter.hit('run', 30_000)).toBe(true); // 距首次 30 秒，该计数了
    expect(counter.hit('run', 40_000)).toBe(false);
  });

  it('去抖是按词的，不同词互不影响', () => {
    const counter = createMeetCounter();
    expect(counter.hit('run', 0)).toBe(true);
    expect(counter.hit('go', 0)).toBe(true);
    expect(counter.hit('run', 100)).toBe(false);
    expect(counter.hit('go', 100)).toBe(false);
  });

  it('大小写与空白归一：Run 与 run 是同一个词', () => {
    const counter = createMeetCounter();
    expect(counter.hit('Run', 0)).toBe(true);
    expect(counter.hit('  run ', 1_000)).toBe(false);
    expect(counter.hit('RUN', 2_000)).toBe(false);
  });

  it('空词不计数', () => {
    const counter = createMeetCounter();
    expect(counter.hit('', 0)).toBe(false);
    expect(counter.hit('   ', 0)).toBe(false);
    expect(counter.size()).toBe(0);
  });
});

describe('FR-A17：内部状态', () => {
  it('lastSeen 记录的是**真正计数**的那次时间', () => {
    const counter = createMeetCounter();
    counter.hit('run', 0);
    counter.hit('run', 5_000); // 被去抖，不该改 lastSeen
    expect(counter.lastSeen('run')).toBe(0);
  });

  it('lastSeen 对没见过的词返回 undefined', () => {
    const counter = createMeetCounter();
    expect(counter.lastSeen('never')).toBeUndefined();
  });

  it('clear 清空全部状态', () => {
    const counter = createMeetCounter();
    counter.hit('run', 0);
    counter.hit('go', 0);
    expect(counter.size()).toBe(2);
    counter.clear();
    expect(counter.size()).toBe(0);
    expect(counter.hit('run', 100)).toBe(true); // 清空后重新计数
  });

  it('窗口可注入，便于测试短窗口', () => {
    const counter = createMeetCounter(1_000);
    expect(counter.hit('run', 0)).toBe(true);
    expect(counter.hit('run', 999)).toBe(false);
    expect(counter.hit('run', 1_000)).toBe(true);
  });
});
