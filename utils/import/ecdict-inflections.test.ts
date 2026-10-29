/**
 * `buildImportedInflections` 的验收（FR-B7b）。
 *
 * 用户实测背景：完整档导入 77 万条后，`dict` 数据齐全，
 * 但 `Meta.importedInflections` 是空的（映射条目数 = 0），
 * 导致靠变形还原的词（如 `dispatched`）查不到。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { clearAllData } from '../db/maintenance';
import { getMeta } from '../db/kv';
import { buildImportedInflections, clearImportedInflections, exchangeForms } from './ecdict-apply';
import type { DictEntry } from '../db/types';

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
});

describe('buildImportedInflections', () => {
  it('把 exchange 摊平成 surface → { lemma, label }', async () => {
    await buildImportedInflections([
      entry('dispatch', 'd:dispatched/p:dispatched/s:dispatches/i:dispatching/3:dispatches'),
    ]);
    const { importedInflections } = await getMeta();
    expect(importedInflections['dispatching']).toEqual({ lemma: 'dispatch', label: '现在分词' });
    // exchanged 同时出现在 d:（过去式）与 p:（过去分词），后者覆盖前者
    expect(importedInflections['dispatched']).toEqual({ lemma: 'dispatch', label: '过去分词' });
    // dispatches 在 s: 与 3: 都有，3: 在后 → 第三人称单数形式
    expect(importedInflections['dispatches']).toEqual({ lemma: 'dispatch', label: '第三人称单数形式' });
  });

  it('大量映射（模拟完整档 5 万条量级）能一次写进 Meta 并读得回', async () => {
    // 造 20000 个词，每个 3 个变形 → 6 万条映射，覆盖完整档实测的 56718 条这个量级
    const entries: DictEntry[] = [];
    for (let i = 0; i < 20000; i += 1) {
      entries.push(entry(`w${i}`, `s:w${i}s/p:w${i}ed/i:w${i}ing`));
    }
    const added = await buildImportedInflections(entries);
    expect(added).toBeGreaterThan(50000);

    const { importedInflections } = await getMeta();
    const keys = Object.keys(importedInflections);
    expect(keys.length).toBe(added);
    // 抽查若干条真实读回
    expect(importedInflections['w0s']).toEqual({ lemma: 'w0', label: '复数形式' });
    expect(importedInflections['w19999ing']).toEqual({ lemma: 'w19999', label: '现在分词' });
  });

  it('再次导入同名映射时覆盖旧值（新的更权威）', async () => {
    await buildImportedInflections([entry('run', 's:runs')]);
    await buildImportedInflections([entry('run', 's:runs/p:ran')]);
    const { importedInflections } = await getMeta();
    expect(importedInflections['runs']).toEqual({ lemma: 'run', label: '复数形式' });
    expect(importedInflections['ran']).toEqual({ lemma: 'run', label: '过去分词' });
  });

  it('空 exchange 不产生映射', async () => {
    await buildImportedInflections([entry('plain', '')]);
    const { importedInflections } = await getMeta();
    expect(Object.keys(importedInflections)).toHaveLength(0);
  });

  it('clearImportedInflections 清空映射', async () => {
    await buildImportedInflections([entry('run', 's:runs')]);
    await clearImportedInflections();
    expect(Object.keys((await getMeta()).importedInflections)).toHaveLength(0);
  });
});
