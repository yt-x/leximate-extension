/**
 * 词形还原（PLAN.md FR-B3a–B3d、§4.5 P4）。
 *
 * 变形表来源是 Wikidata Lexeme（CC0）的**构建期产物**，运行时零网络。
 * 本模块只做两件事：把原始拉取结果**过滤**成可用变形表，以及在查词时**还原**。
 *
 * 关键取舍（FR-B3c）：surface 本身是词库词条时，**独立词条优先**，变形只作附注。
 * `saw` 既是"锯子"又是 `see` 的过去式——让屈折优先会让用户查到错词义。
 */

/**
 * 词性歧义特征：Wikidata 对"名词复数"与"动词第三人称单数"用**同一组**特征标注。
 *
 * 实测 387 条 form 带 `Q110786(单数),Q146786(复数),Q3910936(一般现在),Q51929074(第三人称)`
 * 这样的组合——`walks` 既可能是 `walk` 的复数名词也可能是第三人称单数动词，
 * Wikidata 不区分。若照字面译成"复数"，用户划选动词 `walks` 会看到"walk 的复数"，**是错话**。
 *
 * 因此这类**不单说"复数"**，改用不区分词性的「复数 / 第三人称单数」。
 * 宁可话长一点，不可说错。
 */
const AMBIGUOUS_PLURAL_OR_THIRD_PERSON = '复数 / 第三人称单数';

/** 判定一组特征是否落在上述歧义区 */
function isAmbiguousPluralOrThirdPerson(features: Set<string>): boolean {
  return features.has('Q146786') && features.has('Q51929074');
}

/**
 * Wikidata 语法特征 QID → 中文提示语（FR-B3c 的"see 的过去式"）。
 *
 * ⚠️ QID 是**从 Wikidata 实测拉取**的英文标签逐条核对后写下的
 * （见 docs/reference/wikidata-lexemes.md §5）。凭印象填会全错：
 * 过去式是 `Q1392475`（simple past）而不是语感上的 "past tense"，
 * 现在分词是 `Q10345583`（present participle）。
 *
 * 未列入的特征不显示提示语（返回空串），界面只显示原形——宁可不提示，不可提示错。
 */
const FEATURE_LABELS: Record<string, string> = {
  // 动词
  Q3910936: '第三人称单数', // simple present
  Q10345583: '现在分词', // present participle
  Q1392475: '过去式', // simple past
  Q442485: '过去式', // preterite（与 simple past 同义，实测并存）
  Q1230649: '过去分词', // past participle
  Q179230: '不定式', // infinitive
  Q22716: '祈使', // imperative
  // 名词
  Q146786: '复数', // plural
  // 形容词 / 副词
  Q14169499: '比较级', // comparative
  Q65248385: '比较级', // comparative adverb
  Q1817208: '最高级', // superlative
  Q65248545: '最高级', // superlative adverb
};

/**
 * 会被整体过滤掉的特征 QID。
 *
 * 实测发现 Wikidata 会**自己给脏数据打标**：
 * - `Q1984758` misspelling —— 官方标为拼写错误（`beautifuller` 之类）
 * - `Q102786` abbreviation / `Q30619513` USPS abbreviation —— 缩略形
 * - `Q2105891` possessive / `Q1861696` English possessive —— 所有格
 * - `Q1478451` negation —— 否定形（`didn't`）
 *
 * 这些都不是屈折变化，进变形表会污染还原结果。
 */
const EXCLUDED_FEATURES = new Set<string>([
  'Q1984758', // misspelling
  'Q102786', // abbreviation
  'Q30619513', // USPS abbreviation
  'Q2105891', // possessive
  'Q1861696', // English possessive
  'Q1478451', // negation
]);

export interface InflectionRecord {
  /** 原形（词条形） */
  lemma: string;
  /** 屈折形式 */
  form: string;
  /** Wikidata grammaticalFeature 的 QID */
  feature: string;
}

/** 还原结果：用户查到的 surface 该落到哪个词条 */
export interface LemmatizeResult {
  /** 词库里的原形 */
  lemma: string;
  /** 变形提示语，如"过去式"；用于 FR-B3c 的附注行 */
  hint: string;
}

/**
 * 比较级 / 最高级的原形长度上限。
 *
 * 英语的 -er / -est 基本只加在单音节与部分双音节形容词上，更长的走 more / most。
 * 实测 Wikidata 把 `beautiful` → `beautifuller`、`present` → `presenter` 这类
 * **错误甚至是他词**的形式标成了 comparative（见 decisions/0008）。
 * 其中 `presenter`（主持人）被还原成 `present` 是用户可见的错误，必须滤掉。
 *
 * 取 6 是保守值：`pretty`(6) → `prettier`、`happy`(5) → `happier` 这类正确的
 * 双音节比较级保留，而实测的 10 条脏数据原形长度全部 ≥ 7。
 */
const MAX_COMPARATIVE_LEMMA_LENGTH = 6;

/** 参与长度上限判定的比较类特征 */
const COMPARATIVE_FEATURES = new Set<string>(['Q14169499', 'Q1817208']);

/**
 * 判断一个 form 是否该进变形表。
 *
 * 过滤规则（每条都对应实测发现的噪声，见 docs/reference/wikidata-lexemes.md §5）：
 * 1. 含撇号的一律不要——`child's` / `'ve` / `hadn't` 不是词形变化
 * 2. 含空格的一律不要——`ice cream` 这类多词形式超出 FR-B3b 的"不做短语"
 * 3. 与原形相同的一律不要——不是变形
 * 4. 带排除特征的不要
 * 5. 长度 > 45 的不要（与 FR-A16 的单词长度上限保持一致）
 * 6. 长形容词的 -er / -est 不要（decisions/0008：`presenter` 是他词，会还原出错误词义）
 */
export function shouldKeepForm(lemma: string, form: string, feature: string): boolean {
  if (form === '' || lemma === '') return false;
  if (/['’]/.test(form)) return false;
  if (/\s/.test(form)) return false;
  if (form.toLowerCase() === lemma.toLowerCase()) return false;
  if (EXCLUDED_FEATURES.has(feature)) return false;
  if (form.length > 45) return false;
  if (
    COMPARATIVE_FEATURES.has(feature) &&
    lemma.length > MAX_COMPARATIVE_LEMMA_LENGTH
  ) {
    return false;
  }
  return true;
}

/**
 * 由原始记录构建**正向索引**：surface → 候选原形。
 *
 * 用 `Map<string, Map<lemma, feature>>` 而不是 `Map<string, lemma>`：
 * 一个 surface 可能对应多个原形（`left` ← `leave`；`lay` ← `lie`），
 * 冲突必须在还原时按 FR-B3c 判定，不能在这里靠覆盖悄悄丢掉一个。
 */
export function buildReverseIndex(
  records: InflectionRecord[],
): Map<string, Map<string, Set<string>>> {
  const index = new Map<string, Map<string, Set<string>>>();
  for (const r of records) {
    if (!shouldKeepForm(r.lemma, r.form, r.feature)) continue;
    const key = r.form.toLowerCase();
    let bucket = index.get(key);
    if (!bucket) {
      bucket = new Map();
      index.set(key, bucket);
    }
    // 存**整个特征集**而不是一个：提示语要看组合才能说对
    // （`Q146786` 单独出现是名词复数，与 `Q51929074` 同时出现则名词/动词两可）。
    let features = bucket.get(r.lemma);
    if (!features) {
      features = new Set();
      bucket.set(r.lemma, features);
    }
    if (r.feature !== '') features.add(r.feature);
  }
  return index;
}

/** 特征 QID → 提示语。认不出的返回空串，让界面只显示原形 */
export function featureLabel(qid: string): string {
  return FEATURE_LABELS[qid] ?? '';
}

/**
 * 由**一组**特征推出提示语。
 *
 * 优先级：先判歧义区，再按下面的顺序取第一个认得的特征。
 * 顺序是有意的——`Q146786`(复数) 排在 `Q3910936`(第三人称) 之前，
 * 但两者同时出现时已被歧义规则截住，不会误说成"复数"。
 */
const LABEL_PRIORITY = [
  'Q14169499', // 比较级
  'Q65248385', // 比较级（副词）
  'Q1817208', // 最高级
  'Q65248545', // 最高级（副词）
  'Q1230649', // 过去分词
  'Q1392475', // 过去式
  'Q442485', // 过去式（preterite）
  'Q10345583', // 现在分词
  'Q146786', // 复数
  'Q3910936', // 第三人称单数
  'Q179230', // 不定式
  'Q22716', // 祈使
];

export function labelForFeatures(features: Set<string>): string {
  if (isAmbiguousPluralOrThirdPerson(features)) return AMBIGUOUS_PLURAL_OR_THIRD_PERSON;
  for (const qid of LABEL_PRIORITY) {
    if (features.has(qid)) {
      const label = featureLabel(qid);
      if (label !== '') return label;
    }
  }
  return '';
}

/** 一个 surface 的全部还原候选，按原形字典序稳定排序 */
export interface LemmaCandidate {
  lemma: string;
  hint: string;
}

export function candidatesFor(
  index: Map<string, Map<string, Set<string>>>,
  surface: string,
): LemmaCandidate[] {
  const bucket = index.get(surface.toLowerCase());
  if (!bucket) return [];
  return [...bucket.entries()]
    .map(([lemma, features]) => {
      const qidHint = labelForFeatures(features);
      // 运行时 artifact 已存中文 hint；构建期索引则仍存 QID。
      const runtimeHint = [...features].find((feature) => /\p{Script=Han}/u.test(feature)) ?? '';
      return { lemma, hint: qidHint || runtimeHint };
    })
    .sort((a, b) => a.lemma.localeCompare(b.lemma));
}

/**
 * 造一个还原函数，供 `createDictLookup` 的 `lemmatize` 选项使用。
 *
 * `isKnown` 决定"这个原形是否真的在词库里"——变形表可能指向词库没收录的词，
 * 那样还原就没意义（查不到会走 FR-B4 的"未收录"）。
 *
 * FR-B3c 的"独立词条优先"由**调用方**在查词时先判，本函数只回答"能还原成什么"。
 */
export function createLemmatizer(
  index: Map<string, Map<string, Set<string>>>,
  isKnown: (lemma: string) => boolean,
): (surface: string) => LemmatizeResult | null {
  return (surface: string) => {
    for (const candidate of candidatesFor(index, surface)) {
      if (isKnown(candidate.lemma)) return { lemma: candidate.lemma, hint: candidate.hint };
    }
    return null;
  };
}
