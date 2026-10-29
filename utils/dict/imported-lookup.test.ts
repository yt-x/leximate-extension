/**
 * 导入词典的查询验收（`decisions/0031`：查 `dict` store，不碰生词本）。
 *
 * 判定：
 * - 直接命中（lemma 就是它自己）
 * - 变形命中（`constraints` → `constraint`，靠 `Meta.importedInflections` 映射）
 * - 未命中返回 null（调用方据此判 FR-B4 的「未收录」）
 * - `lemmaFromExchange` / `formLabelFromExchange` 解析正确
 * - 生词本里的词不影响词典查询，反之亦然
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { clearAllData } from '../db/maintenance';
import { setMeta } from '../db/kv';
import { clearDict, writeDictEntries } from './dict-store';
import type { DictEntry } from '../db/types';
import {
  countImportedWords,
  formLabelFromExchange,
  lemmaFromExchange,
  lookupImported,
} from './imported-lookup';

function entry(fields: Partial<DictEntry> & { lemma: string }): DictEntry {
  return {
    surface: fields.lemma,
    phoneticUs: '',
    phoneticSrc: null,
    defZh: [`释义 ${fields.lemma}`],
    pos: [],
    examTags: [],
    freqBnc: 0,
    freqCoca: 0,
    exchange: '',
    source: 'ecdict',
    ...fields,
  };
}

beforeEach(async () => {
  await clearAllData({ keepSettings: true });
  await clearDict();
});

describe('exchange 解析', () => {
  it('从 0: 取原形', () => {
    expect(lemmaFromExchange('s:constraints')).toBeNull();
    expect(lemmaFromExchange('0:constraint/1:s')).toBe('constraint');
    expect(lemmaFromExchange('p:ran/i:running/d:run/0:run/1:d/3:runs/s:runs')).toBe('run');
  });

  it('从 1: 取形态名', () => {
    expect(formLabelFromExchange('0:constraint/1:s')).toBe('复数形式');
    expect(formLabelFromExchange('0:run/1:d')).toBe('过去式');
    expect(formLabelFromExchange('s:constraints')).toBeNull();
  });
});

describe('lookupImported', () => {
  it('直接命中', async () => {
    await writeDictEntries([entry({ lemma: 'constraint', defZh: ['n. 约束'] })]);
    const hit = await lookupImported('constraint');
    expect(hit?.entry.defZh).toEqual(['n. 约束']);
    expect(hit?.hint).toBeNull();
  });

  it('大小写不敏感', async () => {
    await writeDictEntries([entry({ lemma: 'pc', surface: 'PC' })]);
    expect((await lookupImported('PC'))?.entry.lemma).toBe('pc');
  });

  it('变形靠映射命中并给出提示', async () => {
    await writeDictEntries([entry({ lemma: 'constraint', exchange: 's:constraints' })]);
    await setMeta({ importedInflections: { constraints: { lemma: 'constraint', label: '复数形式' } } });
    const hit = await lookupImported('constraints');
    expect(hit?.entry.lemma).toBe('constraint');
    expect(hit?.hint).toBe('复数形式');
  });

  it('映射指向不存在的条目时返回 null（不留悬空引用）', async () => {
    await setMeta({ importedInflections: { ghosts: { lemma: 'ghost', label: '复数形式' } } });
    expect(await lookupImported('ghosts')).toBeNull();
  });

  it('词典里没有就返回 null', async () => {
    expect(await lookupImported('nosuchword')).toBeNull();
  });

  it('空串返回 null，不查库', async () => {
    expect(await lookupImported('   ')).toBeNull();
  });
});

describe('与生词本解耦', () => {
  it('生词本里有词也不影响词典判定：词典为空时查不到', async () => {
    // 只往 dict 写一条，生词本为空
    await writeDictEntries([entry({ lemma: 'constraint' })]);
    expect(await countImportedWords()).toBe(1);
    // 反向：清空词典后，即便生词本里有 constraint，词典查询也应返回 null
    const { upsertWord } = await import('../db/words');
    await upsertWord({ lemma: 'constraint', now: 1 });
    await clearDict();
    expect(await lookupImported('constraint')).toBeNull();
    expect(await countImportedWords()).toBe(0);
  });
});
