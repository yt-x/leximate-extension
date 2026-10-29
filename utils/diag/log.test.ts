/**
 * 诊断日志表的读写（PLAN.md FR-L4）。
 *
 * 纯逻辑（级别映射、清洗）在 `levels.test.ts`；这里只验**这张本地表本身**：
 * 写入、倒序读取、上限裁剪、清空，以及"不可信输入不会写坏它"。
 */
import { describe, expect, it } from 'vitest';
import { addScene, upsertWord } from '../db/words';
import { clearLogs, countLogs, listLogs, writeLog } from './log';
import { MAX_MESSAGE_LENGTH, MAX_SCOPE_LENGTH } from './levels';

describe('写入与读取', () => {
  it('写进去的能按时间倒序读出来（最新在前）', async () => {
    await writeLog({ level: 'info', scope: 'install', message: '扩展已安装', at: 1000 });
    await writeLog({ level: 'warn', scope: 'badge', message: '角标刷新失败', at: 2000 });

    const logs = await listLogs();

    expect(logs.map((entry) => entry.message)).toEqual(['角标刷新失败', '扩展已安装']);
    expect(logs[0]!.level).toBe('warn');
    expect(logs[0]!.scope).toBe('badge');
    expect(await countLogs()).toBe(2);
  });

  it('limit 生效（诊断页只取最近的若干条）', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await writeLog({ level: 'debug', scope: 'content', message: `事件 ${i}`, at: i * 1000 });
    }

    expect((await listLogs({ limit: 2 })).map((entry) => entry.message)).toEqual(['事件 5', '事件 4']);
  });

  it('清空之后就没了', async () => {
    await writeLog({ level: 'info', scope: 'install', message: 'x' });
    await clearLogs();

    expect(await countLogs()).toBe(0);
    expect(await listLogs()).toEqual([]);
  });

  it('空库读出来是空数组，不报错', async () => {
    expect(await listLogs()).toEqual([]);
  });
});

describe('上限：本地日志不能无限涨', () => {
  it('超过上限时丢掉最旧的（体积自检里的占用不会莫名涨）', async () => {
    for (let i = 1; i <= 8; i += 1) {
      await writeLog({ level: 'debug', scope: 'content', message: `事件 ${i}`, at: i * 1000 }, { max: 5 });
    }

    expect(await countLogs()).toBe(5);
    expect((await listLogs()).map((entry) => entry.message)).toEqual([
      '事件 8',
      '事件 7',
      '事件 6',
      '事件 5',
      '事件 4',
    ]);
  });

  it('恰好等于上限时不裁', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await writeLog({ level: 'debug', scope: 'content', message: `事件 ${i}` }, { max: 3 });
    }
    expect(await countLogs()).toBe(3);
  });
});

describe('不可信输入不会写坏这张表', () => {
  it('非法级别退回 info，未知 scope/message 有兜底', async () => {
    await writeLog({ level: 'fatal', scope: '', message: '   ' });
    const [entry] = await listLogs();

    expect(entry!.level).toBe('info');
    expect(entry!.scope).toBe('unknown');
    expect(entry!.message).toBe('(无消息)');
  });

  it('过长的 scope / message 被截断', async () => {
    await writeLog({
      level: 'info',
      scope: 'x'.repeat(MAX_SCOPE_LENGTH + 50),
      message: 'y'.repeat(MAX_MESSAGE_LENGTH + 50),
    });
    const [entry] = await listLogs();

    expect(entry!.scope).toHaveLength(MAX_SCOPE_LENGTH + 1);
    expect(entry!.message).toHaveLength(MAX_MESSAGE_LENGTH + 1);
  });

  it('带函数的 detail 不会让写入失败（IndexedDB 克隆不了函数）', async () => {
    await expect(
      writeLog({ level: 'info', scope: 'x', message: 'y', detail: { cb: () => {} } }),
    ).resolves.toBeUndefined();

    const [entry] = await listLogs();
    expect(entry!.detail).toEqual({});
  });

  it('时间不是数字时用当前时间兜底', async () => {
    const before = Date.now();
    await writeLog({ level: 'info', scope: 'x', message: 'y', at: Number.NaN });
    const [entry] = await listLogs();

    expect(entry!.at).toBeGreaterThanOrEqual(before);
  });
});

describe('日志与其它数据互不干扰', () => {
  it('写日志不影响词与例句', async () => {
    const { word } = await upsertWord({ lemma: 'run', surface: 'run' });
    await addScene({
      wordId: word.id,
      text: 'I run daily.',
      highlightFrom: 2,
      highlightTo: 5,
      sourceUrl: 'https://example.com/a',
    });
    await writeLog({ level: 'info', scope: 'content', message: 'popup-shown' });

    expect(await countLogs()).toBe(1);
  });
});
