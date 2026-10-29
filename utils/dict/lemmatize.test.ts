/**
 * 词形还原单测（PLAN.md FR-B3a–B3d）。
 *
 * 覆盖规格点名的验收判定：
 * - FR-B3：`running` / `went` / `studies` / `bigger` 能查到原形
 * - FR-B3b：三类屈折各有用例；派生词明确**不**还原
 * - FR-B3c：`saw` / `left` / `better` / `found` 同形冲突，独立词条优先
 * - FR-A16 边界：`COVID-19` / `naïve` 的形态处理
 */
import { describe, expect, it } from 'vitest';
import {
  buildReverseIndex,
  candidatesFor,
  createLemmatizer,
  featureLabel,
  shouldKeepForm,
  type InflectionRecord,
} from './lemmatize';

/**
 * Wikidata 的 grammaticalFeature QID。
 *
 * ⚠️ 这些值是**从 Wikidata 实测拉取的英文标签核对后写下的**，不是凭语感猜的
 * （见 docs/reference/wikidata-lexemes.md §5）。凭印象填会全错：
 * 过去式是 `Q1392475`(simple past) 而非 "Q1271766"，
 * 现在分词是 `Q10345583`(present participle) 而非 "Q145599"。
 */
const F = {
  thirdPersonSingular: 'Q3910936', // simple present
  presentParticiple: 'Q10345583', // present participle
  pastTense: 'Q1392475', // simple past
  pastParticiple: 'Q1230649', // past participle
  plural: 'Q146786', // plural
  thirdPerson: 'Q51929074', // third person
  comparative: 'Q14169499', // comparative
  superlative: 'Q1817208', // superlative
} as const;

function rec(lemma: string, form: string, feature: string): InflectionRecord {
  return { lemma, form, feature };
}

/** FR-B3 点名的四类屈折 + FR-B3c 点名的四个同形词，取自真实 Wikidata 形态 */
const FIXTURE: InflectionRecord[] = [
  // 动词：规则
  rec('run', 'running', F.presentParticiple),
  rec('run', 'runs', F.thirdPersonSingular),
  rec('run', 'ran', F.pastTense),
  rec('study', 'studies', F.thirdPersonSingular),
  rec('study', 'studied', F.pastTense),
  rec('study', 'studying', F.presentParticiple),
  // 动词：不规则
  rec('go', 'went', F.pastTense),
  rec('go', 'goes', F.thirdPersonSingular),
  rec('go', 'gone', F.pastParticiple),
  rec('see', 'saw', F.pastTense),
  rec('see', 'seen', F.pastParticiple),
  rec('find', 'found', F.pastTense),
  rec('leave', 'left', F.pastTense),
  rec('lie', 'lay', F.pastTense),
  // 名词：规则 + 不规则
  rec('book', 'books', F.plural),
  rec('child', 'children', F.plural),
  rec('mouse', 'mice', F.plural),
  // 形容词：比较级
  rec('big', 'bigger', F.comparative),
  rec('big', 'biggest', F.superlative),
  rec('good', 'better', F.comparative),
  rec('good', 'best', F.superlative),
  // 噪声：必须被过滤
  rec('child', "child's", F.plural),
  rec('have', "'ve", F.pastTense),
  rec('do', "didn't", F.pastTense),
  rec('beautiful', 'beautifuller', F.comparative),
];

describe('shouldKeepForm：过滤规则', () => {
  it('拒绝含撇号的形式（缩略形 / 所有格）', () => {
    expect(shouldKeepForm('child', "child's", F.plural)).toBe(false);
    expect(shouldKeepForm('have', "'ve", F.pastTense)).toBe(false);
    expect(shouldKeepForm('do', 'didn’t', F.pastTense)).toBe(false);
  });

  it('拒绝含空格的多词形式（FR-B3b 不做短语）', () => {
    expect(shouldKeepForm('ice', 'ice cream', F.plural)).toBe(false);
  });

  it('拒绝与原形相同的形式（那不是变形）', () => {
    expect(shouldKeepForm('run', 'run', F.pastTense)).toBe(false);
  });

  it('接受正常屈折', () => {
    expect(shouldKeepForm('run', 'running', F.presentParticiple)).toBe(true);
    expect(shouldKeepForm('child', 'children', F.plural)).toBe(true);
    expect(shouldKeepForm('big', 'bigger', F.comparative)).toBe(true);
  });
});

describe('FR-B3b：三类屈折都能还原', () => {
  const index = buildReverseIndex(FIXTURE);

  it('动词：规则与不规则', () => {
    expect(candidatesFor(index, 'running')[0]?.lemma).toBe('run');
    expect(candidatesFor(index, 'went')[0]?.lemma).toBe('go');
    expect(candidatesFor(index, 'studies')[0]?.lemma).toBe('study');
    expect(candidatesFor(index, 'studied')[0]?.lemma).toBe('study');
  });

  it('名词：复数', () => {
    expect(candidatesFor(index, 'books')[0]?.lemma).toBe('book');
    expect(candidatesFor(index, 'children')[0]?.lemma).toBe('child');
    expect(candidatesFor(index, 'mice')[0]?.lemma).toBe('mouse');
  });

  it('形容词：比较级与最高级', () => {
    expect(candidatesFor(index, 'bigger')[0]?.lemma).toBe('big');
    expect(candidatesFor(index, 'biggest')[0]?.lemma).toBe('big');
  });

  it('派生词明确不还原（FR-B3b 做的是屈折不是派生）', () => {
    // quickly 不来自任何屈折表，因此查不到候选
    expect(candidatesFor(index, 'quickly')).toEqual([]);
  });

  it('长形容词的 -er/-est 被过滤，不产生错误还原（decisions/0008）', () => {
    // Wikidata 确实把 beautifuller 标成了 comparative，但它不是合法英语
    expect(candidatesFor(index, 'beautifuller')).toEqual([]);
    // 更危险的是他词：presenter 是"主持人"，不该被还原成 present
    expect(candidatesFor(index, 'presenter')).toEqual([]);
    expect(candidatesFor(index, 'forwarder')).toEqual([]);
  });

  it('但正确的双音节比较级要保留', () => {
    const shortCmp = buildReverseIndex([
      rec('pretty', 'prettier', F.comparative),
      rec('happy', 'happier', F.comparative),
      rec('easy', 'easier', F.comparative),
    ]);
    expect(candidatesFor(shortCmp, 'prettier')[0]?.lemma).toBe('pretty');
    expect(candidatesFor(shortCmp, 'happier')[0]?.lemma).toBe('happy');
    expect(candidatesFor(shortCmp, 'easier')[0]?.lemma).toBe('easy');
  });

  it('大小写不影响还原', () => {
    expect(candidatesFor(index, 'Running')[0]?.lemma).toBe('run');
    expect(candidatesFor(index, 'WENT')[0]?.lemma).toBe('go');
  });
});

describe('FR-B3c：同形冲突，独立词条优先', () => {
  const index = buildReverseIndex(FIXTURE);

  it('四个同形词都能给出"它同时是别的词"的线索', () => {
    expect(candidatesFor(index, 'saw').map((c) => c.lemma)).toEqual(['see']);
    expect(candidatesFor(index, 'left').map((c) => c.lemma)).toEqual(['leave']);
    expect(candidatesFor(index, 'found').map((c) => c.lemma)).toEqual(['find']);
    expect(candidatesFor(index, 'better').map((c) => c.lemma)).toEqual(['good']);
  });

  it('提示语是中文，用于卡片上的变形附注行', () => {
    expect(candidatesFor(index, 'saw')[0]?.hint).toBe('过去式');
    expect(candidatesFor(index, 'children')[0]?.hint).toBe('复数');
    expect(candidatesFor(index, 'bigger')[0]?.hint).toBe('比较级');
  });

  it('名词复数与动词第三人称同形时不硬说是"复数"', () => {
    // Wikidata 对 studies 同时标了 plural 与 third person，两者都可能
    const amb = buildReverseIndex([
      {
        lemma: 'study',
        form: 'studies',
        feature: 'Q146786', // plural
      },
      {
        lemma: 'study',
        form: 'studies',
        feature: 'Q51929074', // third person
      },
    ]);
    expect(candidatesFor(amb, 'studies')[0]?.hint).toBe('复数 / 第三人称单数');
  });

  it('独立词条存在时还原函数把它让出来', () => {
    // saw / left 同时是词库词条 → isKnown 命中 → 不问还原
    const dictWords = new Set(['saw', 'left', 'see', 'leave']);
    const lemmatize = createLemmatizer(index, (l) => dictWords.has(l));

    // 调用方必须先判独立词条（FR-B3c）；这里验证"若没判，还原结果是对的"
    expect(lemmatize('saw')?.lemma).toBe('see');
    expect(lemmatize('left')?.lemma).toBe('leave');
  });

  it('原形不在词库时返回 null，交给 FR-B4 的"未收录"', () => {
    const lemmatize = createLemmatizer(index, (l) => l === 'run');
    expect(lemmatize('went')).toBeNull(); // go 不在词库
    expect(lemmatize('running')?.lemma).toBe('run');
  });
});

describe('FR-A16 边界形态', () => {
  const index = buildReverseIndex(FIXTURE);

  it('naïve 这类带附加符号的词原样处理，不被拆开', () => {
    expect(candidatesFor(index, 'naïve')).toEqual([]);
    // 带附加符号的屈折也不该被撇号规则误伤
    expect(shouldKeepForm('naïve', 'naïves', F.plural)).toBe(true);
  });

  it('COVID-19 这类数字混排不被当作屈折形式', () => {
    expect(candidatesFor(index, 'covid-19')).toEqual([]);
    // 连字符词本身可以有一条屈折（如 COVID-19s），但不应含数字规范化逻辑
    expect(shouldKeepForm('covid-19', 'covid-19s', F.plural)).toBe(true);
  });

  it('超长形式被拒（与 FR-A16 的 45 字符上限一致）', () => {
    const long = 'a'.repeat(46);
    expect(shouldKeepForm('x', long, F.plural)).toBe(false);
  });
});

describe('featureLabel', () => {
  it('认得的特征给中文，认不得的给空串', () => {
    expect(featureLabel(F.pastTense)).toBe('过去式');
    expect(featureLabel('Q999999999')).toBe('');
  });
});
