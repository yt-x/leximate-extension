/**
 * 从语料词元表算出**候选词表**（PLAN.md FR-B8 / FR-B1，M1-9）。
 *
 *   node scripts/build-wordlist.ts --freq .local/corpus/freq-lemma.tsv --target 2000
 *
 * ## 输入为什么是"词元表"
 *
 * 屈折归并**已经在语料那边做完了**：BNC 的每个 `<w>` 都带 `hw`（head word），
 * 实测它只做屈折不做事（`said → say`、`children → child`、`ca → can`、`n't → not`；
 * `runner`/`quickly` 保持自身）。所以这一层不再需要外部词形还原——
 * `scripts/count-corpus.ts` 直接按 `hw` 聚合，本脚本只负责**挑词**。
 *
 * ## 挑选口径（三条，都要能说出为什么）
 *
 * 1. **剔除语料的口语转录拼写**：`cos`/`na`/`gon` 是 `because`/`to`/`going` 在口语
 *    转写里的写法（BNC 自己的 `hw` 也没能收回它们）。它们不是标准拼写，
 *    留着会让词表出现查不到的"词"。丢掉的 token 量会打印出来（约占 0.2%）。
 * 2. **剔除填充停顿**：`mm`/`er`/`uh` 这类不是词（`yeah`/`oh` 这类真感叹词保留）。
 * 3. **按次数排序取到目标条数**，并把"已在内置词表里"和"CMUdict 有没有读音"标出来——
 *    后者决定它能不能通过 `scripts/build-phonetics.ts` 拿到音标（FR-B5）。
 *
 * 产物是**工作数据**（`.local/`，不入库）；入库的是最终 `data/core-words.tsv`。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * BNC `c5` 标签 → 本项目的词性词表。
 *
 * 词表取值对齐现有 920 条（`n. / v. / adj. / adv. / pron. / prep. / conj. / num. / art.`），
 * 再加一个 `int.`（感叹词：`yeah`/`oh` 这类，原词表里没有对应先例）。
 *
 * 依据（现有词表的人工口径，逐条核对过）：
 * `the`=art.、`this/that/which/what/some/his`=pron.、`there`=adv.、`not/no`=adv.、
 * `of/in`=prep.、`if/or/than`=conj.、`one/two/three`=num.、`be/have/do`=v.
 */
export const BNC_TO_POS: Record<string, string> = {
  NN0: 'n.', NN1: 'n.', NN2: 'n.', NP0: 'n.', NNT1: 'n.', NNT2: 'n.',
  VVB: 'v.', VVD: 'v.', VVG: 'v.', VVI: 'v.', VVN: 'v.', VVZ: 'v.', VV0: 'v.',
  VBB: 'v.', VBD: 'v.', VBG: 'v.', VBI: 'v.', VBN: 'v.', VBZ: 'v.', VB0: 'v.',
  VHB: 'v.', VHD: 'v.', VHG: 'v.', VHI: 'v.', VHN: 'v.', VHZ: 'v.',
  VDB: 'v.', VDD: 'v.', VDG: 'v.', VDI: 'v.', VDN: 'v.', VDZ: 'v.',
  VM0: 'v.',
  AJ0: 'adj.', AJC: 'adj.', AJS: 'adj.',
  AV0: 'adv.', AVP: 'adv.', AVQ: 'adv.',
  PRP: 'prep.', PRF: 'prep.', TO0: 'prep.',
  PNP: 'pron.', PNX: 'pron.', PNQ: 'pron.', PNI: 'pron.',
  DT0: 'pron.', DTQ: 'pron.', DPS: 'pron.',
  AT0: 'art.',
  CJC: 'conj.', CJS: 'conj.', CJT: 'conj.',
  CRD: 'num.', ORD: 'num.',
  ITJ: 'int.',
  EX0: 'adv.',
  XX0: 'adv.',
};

/**
 * 语料的口语转录拼写：**不是标准词**。
 *
 * | 词 | 次数 | BNC 标签 | 是什么 |
 * |---|---|---|---|
 * | `cos` | 2793 | CJS | `because`（英式口语转写） |
 * | `na` | 2605 | TO0 | `to`（`going to` → `gonna` 被切成 `gon`+`na`） |
 * | `gon` | 2037 | VVG | `going`（同上） |
 *
 * 【推测】这三条对应关系是按"标签 + 口语体裁 + 拼写"判断的，不是语料给的标注
 * （BNC 的 `hw` 对它们也只写了自身）。**因为它们都属于已经在词表前列的词
 * （`to`/`because`/`go`），剔掉不影响入选边界**；丢掉的 token 会打印出来备查。
 */
export const SPOKEN_SPELLING_ARTIFACTS = new Set(['cos', 'na', 'gon']);

/** 填充停顿：不是词（`never mind` 里的 `mm`、`er`、`uh` 之类） */
export const FILLED_PAUSES = new Set(['mm', 'mhm', 'er', 'erm', 'uh', 'um', 'hm', 'hmm', 'ahm']);

/**
 * 英式拼写 → 美式拼写。
 *
 * **BNC 是英式语料**，候选里因此混着 `centre`/`colour`/`organise` 这类拼写；
 * 而现有 920 条用的是美式（实测：有 `center`/`color`/`realize`/`defense`/`program`，
 * 没有对应的英式）。不归一，同一件事会以两种拼写各进一条，还会与已收录的词重复。
 *
 * 只收"同一词的两种拼写"（`-re → -er`、`-our → -or`、`-ise → -ize` 等）；
 * **不碰** `practise`——现有词表明确收了英式的 `practise`，改掉会与已收录条目打架。
 */
export const BRITISH_TO_AMERICAN: Record<string, string> = {
  centre: 'center',
  theatre: 'theater',
  metre: 'meter',
  litre: 'liter',
  fibre: 'fiber',
  labour: 'labor',
  colour: 'color',
  favour: 'favor',
  honour: 'honor',
  behaviour: 'behavior',
  neighbour: 'neighbor',
  rumour: 'rumor',
  harbour: 'harbor',
  armour: 'armor',
  flavour: 'flavor',
  humour: 'humor',
  savour: 'savor',
  vigour: 'vigor',
  endeavour: 'endeavor',
  defence: 'defense',
  offence: 'offense',
  licence: 'license',
  pretence: 'pretense',
  organise: 'organize',
  realise: 'realize',
  recognise: 'recognize',
  apologise: 'apologize',
  criticise: 'criticize',
  specialise: 'specialize',
  analyse: 'analyze',
  paralyse: 'paralyze',
  programme: 'program',
  catalogue: 'catalog',
  dialogue: 'dialog',
  grey: 'gray',
  jewellery: 'jewelry',
  storey: 'story',
  travelling: 'traveling',
  marvellous: 'marvelous',
  woollen: 'woolen',
};

/**
 * ⚠️ 用 `Object.hasOwn` 查表：**不能用 `TABLE[key] ?? fallback`**。
 *
 * 语料里真的会出现 `constructor` / `toString` / `valueOf` 这些词
 * （实测 BNC Baby 里就有一次 `constructor`），而普通对象会从原型链上
 * 返回 `Object.prototype.constructor` 这个**函数**——于是"词性"变成函数、
 * 排序时 `localeCompare is not a function` 才炸，排查成本很高。
 */
export function americanize(lemma: string): string {
  return Object.hasOwn(BRITISH_TO_AMERICAN, lemma) ? (BRITISH_TO_AMERICAN[lemma] as string) : lemma;
}

export interface FreqRow {
  lemma: string;
  count: number;
  tag: string;
  surfaces: number;
}

export interface CandidateRow extends FreqRow {
  pos: string;
  inCore: boolean;
  /** CMUdict 里有没有这个词（没有就拿不到音标） */
  inCmudict: boolean;
}

export function readFreq(path: string): FreqRow[] {
  const rows: FreqRow[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [lemma = '', count = '0', tag = '', surfaces = '1'] = line.split('\t');
    const parsed = Number(count);
    if (lemma && Number.isFinite(parsed)) {
      rows.push({ lemma, count: parsed, tag, surfaces: Number(surfaces) || 1 });
    }
  }
  return rows;
}

/** 现成的词表用的是什么（用于排除已收录的词） */
export function readCoreLemmas(path = `${ROOT}data/core-words.tsv`): Set<string> {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(1);
  const out = new Set<string>();
  for (const line of lines) {
    const lemma = line.split('\t')[0]?.trim();
    if (lemma) out.add(lemma);
  }
  return out;
}

/** CMUdict 里有哪些词（键去掉 `(2)` 这类异读编号） */
export function readCmudict(path = `${ROOT}data/pronunciation/cmudict.dict`): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const word = line.split(' ')[0]?.toLowerCase().replace(/\(\d+\)$/, '');
    if (word) out.add(word);
  }
  return out;
}

/** 主导 BNC 标签 → 词性；处理 `AJ0-NN1` 这种复合标签（取第一段） */
export function posOfTag(tag: string): string {
  const first = tag.split('-')[0] ?? '';
  // 同 `americanize`：查表必须防原型链（`posOfTag('constructor')` 不能返回函数）
  return Object.hasOwn(BNC_TO_POS, first) ? (BNC_TO_POS[first] as string) : '';
}

export interface BuildOptions {
  target: number;
  coreLemmas: ReadonlySet<string>;
  cmudict?: ReadonlySet<string>;
}

export interface BuildResult {
  candidates: CandidateRow[];
  ranked: CandidateRow[];
  needNew: number;
  dropped: {
    spokenArtifacts: FreqRow[];
    filledPauses: FreqRow[];
    /** CMUdict 里没有读音的（拿不到音标，FR-B5 要求每条都有音标，所以不收） */
    noPronunciation: FreqRow[];
    /** 标签没映射到词性的（会以空词性进表，需要人工补规则） */
    unmappedPos: FreqRow[];
  };
  stats: {
    freqLemmas: number;
    tokens: number;
    coreInTarget: number;
    cmudictMissingAmongNew: number;
    /** 有多少行是英式拼写被并进美式拼写的 */
    britishMerged: number;
  };
}

export function buildWordlist(freq: readonly FreqRow[], options: BuildOptions): BuildResult {
  const dropped = {
    spokenArtifacts: [] as FreqRow[],
    filledPauses: [] as FreqRow[],
    noPronunciation: [] as FreqRow[],
    unmappedPos: [] as FreqRow[],
  };

  // 1) 英式拼写归一到美式：同一词的两种拼写**合并计数**（`centre` 的次数算进 `center`）
  const merged = new Map<string, FreqRow>();
  let britishMerged = 0;
  for (const row of freq) {
    const lemma = americanize(row.lemma);
    if (lemma !== row.lemma) britishMerged += 1;
    const existing = merged.get(lemma);
    if (existing) {
      existing.count += row.count;
      existing.surfaces += row.surfaces;
    } else {
      merged.set(lemma, { ...row, lemma });
    }
  }

  // 2) 剔除口语转录拼写、填充停顿、以及拿不到音标的词；词性从主导标签映射
  const kept: CandidateRow[] = [];
  for (const row of merged.values()) {
    if (SPOKEN_SPELLING_ARTIFACTS.has(row.lemma)) {
      dropped.spokenArtifacts.push(row);
      continue;
    }
    if (FILLED_PAUSES.has(row.lemma)) {
      dropped.filledPauses.push(row);
      continue;
    }
    // 没有读音 = 拿不到音标（FR-B5 要求每条都有音标），不收。
    // 实测被挡下的是 `mp`/`gi`/`gp`/`eqn`（缩写）、`ii`（罗马数字）、`year-old`（带连字符的复合词）。
    if (options.cmudict && !options.cmudict.has(row.lemma)) {
      dropped.noPronunciation.push(row);
      continue;
    }
    const pos = posOfTag(row.tag);
    if (pos === '') dropped.unmappedPos.push(row);

    kept.push({
      ...row,
      pos,
      inCore: options.coreLemmas.has(row.lemma),
      inCmudict: options.cmudict ? options.cmudict.has(row.lemma) : true,
    });
  }

  // 3) 排序与选边
  const ranked = kept.sort((a, b) => b.count - a.count || a.lemma.localeCompare(b.lemma));
  const candidates = ranked.slice(0, options.target);
  const coreInTarget = candidates.filter((row) => row.inCore).length;
  const cmudictMissingAmongNew = candidates.filter((row) => !row.inCore && !row.inCmudict).length;

  return {
    candidates,
    ranked,
    needNew: candidates.length - coreInTarget,
    dropped,
    stats: {
      freqLemmas: merged.size,
      tokens: freq.reduce((sum, row) => sum + row.count, 0),
      coreInTarget,
      cmudictMissingAmongNew,
      britishMerged,
    },
  };
}

function parseArgs(argv: string[]): {
  freq: string;
  core: string;
  cmudict: string;
  out: string;
  target: number;
  top: number;
} {
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
  };
  return {
    freq: get('--freq', `${ROOT}.local/corpus/freq-lemma.tsv`),
    core: get('--core', `${ROOT}data/core-words.tsv`),
    cmudict: get('--cmudict', `${ROOT}data/pronunciation/cmudict.dict`),
    out: get('--out', `${ROOT}.local/corpus/candidates.tsv`),
    target: Number(get('--target', '2000')),
    top: Number(get('--top', '40')),
  };
}

function main(): void {
  const args = parseArgs(process.argv);

  if (!existsSync(args.freq)) {
    console.error(`词元表不存在：${args.freq}（先跑 scripts/count-corpus.ts）`);
    process.exit(2);
  }

  const freq = readFreq(args.freq);
  const coreLemmas = readCoreLemmas(args.core);
  const cmudict = existsSync(args.cmudict) ? readCmudict(args.cmudict) : undefined;
  const result = buildWordlist(freq, { target: args.target, coreLemmas, cmudict });

  const covered = result.candidates.reduce((sum, row) => sum + row.count, 0);
  const lostTokens = result.dropped.spokenArtifacts.reduce((sum, row) => sum + row.count, 0);

  writeFileSync(
    args.out,
    `lemma\tcount\tpos\ttag\tsurfaces\tinCore\tinCmudict\n` +
      result.candidates
        .map((row) =>
          [
            row.lemma,
            row.count,
            row.pos || '(未映射)',
            row.tag,
            row.surfaces,
            row.inCore ? 'yes' : 'no',
            row.inCmudict ? 'yes' : 'no',
          ].join('\t'),
        )
        .join('\n') +
      '\n',
    'utf8',
  );

  const newOnes = result.candidates.filter((row) => !row.inCore);

  console.log(
    JSON.stringify(
      {
        target: args.target,
        freqLemmas: result.stats.freqLemmas,
        tokens: result.stats.tokens,
        candidates: result.candidates.length,
        alreadyInCore: result.stats.coreInTarget,
        needNew: result.needNew,
        coverageOfTarget: Number((covered / result.stats.tokens).toFixed(4)),
        cmudictMissingAmongNew: result.stats.cmudictMissingAmongNew,
        droppedSpokenArtifacts: result.dropped.spokenArtifacts.map((row) => `${row.lemma}(${row.count})`),
        droppedTokensFromArtifacts: lostTokens,
        droppedFilledPauses: result.dropped.filledPauses.map((row) => `${row.lemma}(${row.count})`),
        droppedNoPronunciation: result.dropped.noPronunciation.map((row) => `${row.lemma}(${row.count})`),
        unmappedPosCount: result.dropped.unmappedPos.length,
        unmappedPosSample: result.dropped.unmappedPos.slice(0, 10).map((row) => `${row.lemma}/${row.tag}`),
        out: args.out,
        sampleNew: newOnes.slice(0, args.top).map((row) => `${row.lemma} ${row.count} ${row.pos}`),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1]?.includes('build-wordlist')) {
  try {
    main();
  } catch (error) {
    console.error('构建失败：', error);
    process.exit(1);
  }
}
