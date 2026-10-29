/**
 * `rebuildImportedInflections`：从现有 dict 重建变形映射。
 *
 * 用途：修复「dict 有数据、映射为空」的不一致状态，不重新导入词典。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { STORE, writeTx } from './schema';
import type { DictEntry } from './types';
import { clearAllData } from './maintenance';
import { getMeta } from './kv';
import { clearDict, writeDictEntries } from '../dict/dict-store';
import { lookupImported } from '../dict/imported-lookup';
import { rebuildImportedInflections } from '../dict/rebuild-inflections';

function entry(lemma: string, exchange = ''): DictEntry {
  return {
    lemma,
    surface: lemma,
    phoneticUs: '',
    phoneticSrc: null,
    defZh: [`释义 ${lemma}`],
    pos: [],
    examTags: [],
    freqBnc: 0,
    freqCoca: 0,
    exchange,
    source: 'ecdict',
  };
}

beforeEach(async () => {
  await clearAllData({ keepSettings: true });
  await clearDict();
});

describe('rebuildImportedInflections', () => {
  it('dict 有数据但映射为空时，重建出映射', async () => {
    await writeDictEntries([
      entry('dispatch', 'd:dispatched/p:dispatched/s:dispatches/i:dispatching/3:dispatches'),
    ]);
    // 模拟用户状态：映射为空
    await writeTx(STORE.meta, (tx) => tx.objectStore(STORE.meta).put({ key: 'meta', value: { importedInflections: {} } }));

    expect(Object.keys((await getMeta()).importedInflections)).toHaveLength(0);

    const added = await rebuildImportedInflections();
    expect(added).toBeGreaterThanOrEqual(3);

    const { importedInflections } = await getMeta();
    expect(importedInflections['dispatching']).toEqual({ lemma: 'dispatch', label: '现在分词' });

    // 重建后 dispatched 能还原
    expect((await lookupImported('dispatched'))?.entry.lemma).toBe('dispatch');
  });

  it('dict 为空时重建得到空映射', async () => {
    const added = await rebuildImportedInflections();
    expect(added).toBe(0);
    expect(Object.keys((await getMeta()).importedInflections)).toHaveLength(0);
  });

  it('重建是幂等的：跑两次结果一致', async () => {
    await writeDictEntries([entry('run', 's:runs/p:ran/i:running')]);
    const first = await rebuildImportedInflections();
    const afterFirst = JSON.stringify((await getMeta()).importedInflections);
    const second = await rebuildImportedInflections();
    expect(second).toBe(first);
    expect(JSON.stringify((await getMeta()).importedInflections)).toBe(afterFirst);
  });
});
