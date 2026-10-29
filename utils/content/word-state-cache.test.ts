/**
 * 内容脚本词状态缓存的单测。
 *
 * 核心语义：**未命中按生词处理**（FR-A10——首次遇见就该被标注）。
 * 这个默认值如果反了，用户会看不到任何下划线，而且不会有任何报错。
 */
import { describe, expect, it } from 'vitest';
import { createWordStateCache } from './word-state-cache';
import { UNSEEN } from './word-state-shared';

describe('createWordStateCache', () => {
  it('空缓存按 UNSEEN 处理（首次遇见就该标）', () => {
    const cache = createWordStateCache();
    expect(cache.get('run')).toBeUndefined();
    expect(cache.get('run')).toBeUndefined();
  });

  it('空词与纯空白也回 UNSEEN，不写进缓存', () => {
    const cache = createWordStateCache();
    expect(cache.get('')).toBeUndefined();
    expect(cache.get('   ')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('查词大小写与首尾空白不敏感', () => {
    const cache = createWordStateCache();
    cache.set('Run', { status: 'known', meetCount: 2 });

    expect(cache.get('run')!.status).toBe('known');
    expect(cache.get(' RUN ')!.meetCount).toBe(2);
  });

  it('replaceAll 整体覆盖并清掉旧值', () => {
    const cache = createWordStateCache();
    cache.set('stale', { status: 'known', meetCount: 9 });

    cache.replaceAll([{ word: 'run', state: { status: 'new', meetCount: 1 } }]);

    expect(cache.get('run')!.meetCount).toBe(1);
    // 旧值必须消失——否则后台删掉的词会一直以旧状态被标注
    expect(cache.get('stale')).toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  it('replaceAll 忽略空词', () => {
    const cache = createWordStateCache();
    cache.replaceAll([
      { word: '', state: { status: 'known', meetCount: 1 } },
      { word: 'run', state: { status: 'known', meetCount: 1 } },
    ]);
    expect(cache.size()).toBe(1);
  });

  it('set 单条写入', () => {
    const cache = createWordStateCache();
    cache.set('run', { status: 'ignored', meetCount: 4 });

    expect(cache.get('run')).toEqual({ status: 'ignored', meetCount: 4 });
    expect(cache.size()).toBe(1);
  });

  it('clear 清空', () => {
    const cache = createWordStateCache();
    cache.set('run', { status: 'known', meetCount: 1 });
    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.get('run')).toBeUndefined();
  });

  it('UNSEEN 是冻结的，防止调用方改坏共享默认值', () => {
    expect(Object.isFrozen(UNSEEN)).toBe(true);
  });
});
