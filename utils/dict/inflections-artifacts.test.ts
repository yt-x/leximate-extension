/**
 * 变形索引**真产物**一致性检查。
 *
 * `lemmatize.test.ts` 用的是造的假数据，只证明逻辑对；这里直接读
 * `data/inflections/wikidata-forms.tsv` 与 `public/dict/inflections.json`，
 * 证明**交给用户的那份变形表**确实可用：规格点名的词能还原、脏数据没混进去。
 *
 * 内容出问题得在这里挡住，而不是等用户在浏览器里发现查错词。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { candidatesFor, type LemmaCandidate } from './lemmatize';

const root = fileURLToPath(new URL('../..', import.meta.url));
const artifactText = readFileSync(join(root, 'public', 'dict', 'inflections.json'), 'utf8');
const rawText = readFileSync(join(root, 'data', 'inflections', 'wikidata-forms.tsv'), 'utf8');

interface Artifact {
  version: number;
  dictVersion: string;
  source: string;
  count: number;
  entries: Record<string, LemmaCandidate[]>;
}

const artifact = JSON.parse(artifactText) as Artifact;

/** 把产物的 plain object 还原成查询层的 Map 形态 */
const index = new Map<string, Map<string, Set<string>>>(
  Object.entries(artifact.entries).map(([surface, candidates]) => [
    surface,
    new Map(candidates.map((c) => [c.lemma, new Set<string>()])),
  ]),
);

/** 直接用产物的 hint，绕开空特征集（产物里已算好 hint） */
function hintsFor(surface: string): Array<{ lemma: string; hint: string }> {
  return (artifact.entries[surface] ?? []).map((c) => ({ lemma: c.lemma, hint: c.hint }));
}

describe('变形索引产物结构', () => {
  it('产物版本与来源可查（FR-B3a 要求带版本号）', () => {
    expect(artifact.version).toBe(1);
    expect(artifact.source).toContain('Wikidata');
    expect(artifact.dictVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('体量在合理区间，没被截断也没爆掉', () => {
    expect(artifact.count).toBeGreaterThan(1000);
    expect(artifact.count).toBeLessThan(10_000);
    expect(Object.keys(artifact.entries).length).toBe(artifact.count);
  });

  it('每条候选都带原形，空值不会漏出去', () => {
    const bad: string[] = [];
    for (const [surface, candidates] of Object.entries(artifact.entries)) {
      if (candidates.length === 0) bad.push(`${surface}: 无候选`);
      for (const c of candidates) {
        if (!c.lemma) bad.push(`${surface}: 候选缺 lemma`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('不含撇号形式（缩略形 / 所有格已过滤）', () => {
    const withApostrophe = Object.keys(artifact.entries).filter((s) => /['’]/.test(s));
    expect(withApostrophe).toEqual([]);
  });
});

describe('FR-B3 验收：规格点名的词能还原', () => {
  it('running / went / studies / bigger 查得到原形', () => {
    expect(hintsFor('running')[0]?.lemma).toBe('run');
    expect(hintsFor('went')[0]?.lemma).toBe('go');
    expect(hintsFor('studies')[0]?.lemma).toBe('study');
    expect(hintsFor('bigger')[0]?.lemma).toBe('big');
  });

  it('三类屈折在真产物里都有实例', () => {
    // 动词
    expect(hintsFor('running').length).toBeGreaterThan(0);
    // 名词复数
    expect(hintsFor('children')[0]?.lemma).toBe('child');
    // 形容词比较级
    expect(hintsFor('biggest')[0]?.lemma).toBe('big');
  });

  it('不规则动词的过去式/过去分词都在', () => {
    expect(hintsFor('went')[0]?.lemma).toBe('go');
    expect(hintsFor('gone')[0]?.lemma).toBe('go');
    expect(hintsFor('saw')[0]?.lemma).toBe('see');
    expect(hintsFor('seen')[0]?.lemma).toBe('see');
    expect(hintsFor('found')[0]?.lemma).toBe('find');
  });

  it('还原出来的原形确实在核心词表里（否则还原没意义）', () => {
    const coreText = readFileSync(join(root, 'data', 'core-words.tsv'), 'utf8');
    const coreLemmas = new Set(
      coreText
        .split(/\r?\n/)
        .slice(1)
        .filter((l) => l.trim())
        .map((l) => (l.split('\t')[0] ?? '').toLowerCase()),
    );

    const checked = ['running', 'went', 'studies', 'bigger', 'children'];
    const orphans: string[] = [];
    for (const surface of checked) {
      const top = hintsFor(surface)[0];
      if (top && !coreLemmas.has(top.lemma)) orphans.push(`${surface} → ${top.lemma}`);
    }
    expect(orphans).toEqual([]);
  });
});

describe('FR-B3c 验收：四个同形词都能给出变形线索', () => {
  it('saw / left / better / found 都有候选原形', () => {
    expect(hintsFor('saw').map((c) => c.lemma)).toContain('see');
    expect(hintsFor('left').map((c) => c.lemma)).toContain('leave');
    expect(hintsFor('better').map((c) => c.lemma)).toContain('good');
    expect(hintsFor('found').map((c) => c.lemma)).toContain('find');
  });

  it('提示语是非空的（卡片上要显示"see 的过去式"）', () => {
    for (const surface of ['saw', 'left', 'found']) {
      expect(hintsFor(surface)[0]?.hint).toBeTruthy();
    }
  });

  it('better 同时指向 good 与 well，不丢候选', () => {
    const lemmas = hintsFor('better').map((c) => c.lemma);
    expect(lemmas).toContain('good');
    expect(lemmas).toContain('well');
  });
});

describe('decisions/0008 验收：脏数据不在真产物里', () => {
  it('长形容词的无效比较级被滤掉', () => {
    // 这四条在原始数据里只带 comparative 特征，靠长度规则拦下
    for (const bad of ['beautifuller', 'presenter', 'forwarder', 'certainer']) {
      expect(artifact.entries[bad]).toBeUndefined();
    }
  });

  it('但它们确实存在于原始拉取结果里（证明是过滤掉的，不是没拉到）', () => {
    const rawForms = rawText
      .split(/\r?\n/)
      .slice(1)
      .filter((l) => l.trim())
      .map((l) => l.split('\t')[1] ?? '');
    // 至少能证明上游确实给了这些噪声，过滤是必要的
    expect(rawForms).toContain('beautifuller');
    expect(rawForms).toContain('presenter');
  });

  it('正确的短形容词比较级仍然保留', () => {
    expect(hintsFor('bigger')[0]?.lemma).toBe('big');
    expect(hintsFor('easier')[0]?.lemma).toBe('easy');
    expect(hintsFor('happier')[0]?.lemma).toBe('happy');
  });
});

describe('歧义提示不说错话', () => {
  it('名词复数与动词第三人称同形时给合并提示', () => {
    // studies/books 这类 Wikidata 不区分词性，不能硬说"复数"
    expect(hintsFor('studies')[0]?.hint).toBe('复数 / 第三人称单数');
  });
});

describe('candidatesFor 与产物一致', () => {
  it('产物里的 surface 都能被 candidatesFor 命中', () => {
    for (const surface of ['running', 'went', 'children']) {
      expect(candidatesFor(index, surface).length).toBeGreaterThan(0);
      expect(candidatesFor(index, surface.toUpperCase()).length).toBeGreaterThan(0);
    }
  });

  it('产物里没有的 surface 返回空数组，不乱猜', () => {
    expect(candidatesFor(index, 'zzzznotaword')).toEqual([]);
  });
});
