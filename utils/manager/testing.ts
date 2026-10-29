/**
 * 管理台单测的公共夹具。
 *
 * 造 `Word` 的字段很多，逐个用例写一遍会淹没测试意图；
 * 也让"新增字段"只需改一处。
 */
import type { Word } from '../db/types';
import type { ListRow } from './filter';

export function makeWord(over: Partial<Word> & { lemma: string }): Word {
  const { lemma, ...rest } = over;
  return {
    id: lemma,
    lemma,
    surface: lemma,
    phoneticUs: '',
    phoneticUk: '',
    phoneticSrc: null,
    defSrc: null,
    defZh: [],
    pos: [],
    examTags: [],
    freqBnc: 0,
    freqCoca: 0,
    exchange: '',
    status: 'new',
    meetCount: 1,
    isLemmatized: false,
    inflectionOf: null,
    isUnlisted: false,
    origin: 'native',
    fallbackDef: [],
    llmDef: [],
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...rest,
  };
}

/**
 * 造一行。`domains` 传数组时会自动算出 `domainCounts`
 * （与 `load.ts` 的口径一致），避免用例里两处对不上。
 */
export function makeRow(
  over: Partial<Word> & { lemma: string },
  extra: { sceneCount?: number; domains?: string[]; domainCounts?: Record<string, number> } = {},
): ListRow {
  const domains = extra.domains ?? [];
  const domainCounts: Record<string, number> = extra.domainCounts ?? {};
  if (extra.domainCounts === undefined) {
    for (const d of domains) {
      if (d === '') continue;
      domainCounts[d] = (domainCounts[d] ?? 0) + 1;
    }
  }

  return {
    word: makeWord(over),
    sceneCount: extra.sceneCount ?? domains.filter((d) => d !== '').length,
    domains: [...new Set(domains.filter((d) => d !== ''))],
    domainCounts,
  };
}
