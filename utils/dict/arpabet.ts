/**
 * ARPAbet → IPA 转换。
 *
 * 数据源是 CMUdict（BSD-2 等价，见 `data/pronunciation/LICENSE-cmudict.txt`），
 * 它给出的是 ARPAbet 音素序列加上重音数字（0 无重音 / 1 主重音 / 2 次重音）。
 *
 * 本项目**不用**通用的语言学转写惯例，而是对齐中文英语教材的标注习惯：
 *   - `r` 而不是 `ɹ`
 *   - `ʌ` 而不是 `ə`（STRUT 元音）
 *   - `e` 而不是 `ɛ`
 *   - 不写送气（`tʰ`）与齿化（`d̪`）等附加符号
 *   - 单音节词不标重音（教材写 `/æsk/` 而不是 `/ˈæsk/`）
 *
 * 映射表与音节切分规则都是本项目自己写的，因此成品只受 MIT 与 CMUdict 的
 * BSD 条款约束。
 */

/** CMUdict 用到的全部音素（元音带重音数字，辅音不带） */
export const ARPA_VOWELS = [
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY',
  'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
] as const;

/**
 * 少于这个音节数就不标次重音。
 * CMUdict 把 `include` 记作 `IH2 N K L UW1 D`，逐字转出来是 `/ˌɪnˈklud/`，
 * 而教材写 `/ɪnˈklud/`；到 `information`（4 音节）这种长度才写 `/ˌɪnfərˈmeɪʃən/`。
 */
export const SECONDARY_STRESS_MIN_SYLLABLES = 4;

const VOWEL_SET: ReadonlySet<string> = new Set<string>(ARPA_VOWELS);

/** 无重音区分的辅音映射 */
const CONSONANT_MAP: Readonly<Record<string, string>> = {
  P: 'p', B: 'b', T: 't', D: 'd', K: 'k', G: 'ɡ',
  CH: 'tʃ', JH: 'dʒ',
  F: 'f', V: 'v', TH: 'θ', DH: 'ð',
  S: 's', Z: 'z', SH: 'ʃ', ZH: 'ʒ',
  HH: 'h', M: 'm', N: 'n', NG: 'ŋ',
  L: 'l', R: 'r', Y: 'j', W: 'w',
};

/** 重音无关的元音映射（AH 与 ER 三个重音档位走不同符号，单独处理） */
const PLAIN_VOWEL_MAP: Readonly<Record<string, string>> = {
  AA: 'ɑ', AE: 'æ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ',
  EH: 'e', EY: 'eɪ', IH: 'ɪ', IY: 'i',
  OW: 'oʊ', OY: 'ɔɪ', UH: 'ʊ', UW: 'u',
};

/**
 * 合法英语首音丛（IPA）。用于"最大首音原则"：两个元音之间的辅音串，
 * 从右往左取最长的合法首音丛给后一个音节，剩下的留给前一个音节的尾音。
 */
const LEGAL_ONSETS: ReadonlySet<string> = new Set([
  'p', 'b', 't', 'd', 'k', 'ɡ', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'h',
  'm', 'n', 'l', 'r', 'j', 'w', 'tʃ', 'dʒ',
  'pr', 'br', 'tr', 'dr', 'kr', 'ɡr', 'fr', 'θr', 'ʃr',
  'pl', 'bl', 'kl', 'ɡl', 'fl', 'sl',
  'sp', 'st', 'sk', 'sm', 'sn', 'sw', 'tw', 'dw', 'kw', 'ɡw', 'hw',
  'pj', 'bj', 'kj', 'fj', 'vj', 'mj', 'nj', 'lj', 'hj',
  'spr', 'str', 'skr', 'spl', 'skl', 'skw', 'spj', 'stj', 'skj',
]);

export interface ArpaUnit {
  base: string;
  /** '0' 无重音 / '1' 主重音 / '2' 次重音 */
  stress: string;
  isVowel: boolean;
}

/** 拆一个 ARPAbet 音素，`AH0` → `{base:'AH', stress:'0'}` */
export function parsePhone(phone: string): ArpaUnit | null {
  const m = /^([A-Z]+)([012])?$/.exec(phone);
  if (!m?.[1]) return null;
  const base = m[1];
  return { base, stress: m[2] ?? '0', isVowel: VOWEL_SET.has(base) };
}

interface Syllable {
  vowelIndex: number;
  onset: string[];
  coda: string[];
  stress: string;
}

/**
 * 按"最大首音原则"切分音节。
 * 元音个数就是音节个数；两个元音之间的辅音串决定边界。
 */
export function syllabify(units: readonly ArpaUnit[]): Syllable[] | null {
  const vowelIdx: number[] = [];
  units.forEach((u, i) => {
    if (u.isVowel) vowelIdx.push(i);
  });
  const first = vowelIdx[0];
  if (first === undefined) return null;

  const syls: Syllable[] = vowelIdx.map((vi) => ({
    vowelIndex: vi,
    onset: [],
    coda: [],
    stress: units[vi]?.stress ?? '0',
  }));

  // 词首辅音全部归第一个音节
  for (let i = 0; i < first; i++) syls[0]?.onset.push(units[i]?.base ?? '');

  // 元音之间的辅音串：最长的合法首音丛归后一个音节，其余归前一个音节的尾音
  for (let k = 0; k < vowelIdx.length - 1; k++) {
    const from = vowelIdx[k];
    const to = vowelIdx[k + 1];
    if (from === undefined || to === undefined) continue;
    const cons: string[] = [];
    for (let i = from + 1; i < to; i++) cons.push(units[i]?.base ?? '');

    let take = 0;
    for (let n = Math.min(3, cons.length); n >= 1; n--) {
      const candidate = cons.slice(cons.length - n).map(toIpaSymbol).join('');
      if (LEGAL_ONSETS.has(candidate)) {
        take = n;
        break;
      }
    }
    syls[k]?.coda.push(...cons.slice(0, cons.length - take));
    syls[k + 1]?.onset.push(...cons.slice(cons.length - take));
  }

  // 词尾辅音归最后一个音节
  const lastIdx = vowelIdx[vowelIdx.length - 1];
  if (lastIdx !== undefined) {
    for (let i = lastIdx + 1; i < units.length; i++) {
      syls[syls.length - 1]?.coda.push(units[i]?.base ?? '');
    }
  }
  return syls;
}

/** 单个音素 → IPA 符号；元音只看基式，重音分流由 nucleusOf 负责 */
function toIpaSymbol(base: string): string {
  if (base === 'AH') return 'ə';
  if (base === 'ER') return 'ər';
  return PLAIN_VOWEL_MAP[base] ?? CONSONANT_MAP[base] ?? base;
}

/** 本项目认识这个音素基式吗（AH 与 ER 单独有重音分流表，也算认识） */
function isKnownBase(base: string): boolean {
  return base === 'AH' || base === 'ER' || base in PLAIN_VOWEL_MAP || base in CONSONANT_MAP;
}

/** 音节核的 IPA：AH 与 ER 随重音变符号 */
function nucleusOf(unit: ArpaUnit): string {
  if (unit.base === 'AH') return unit.stress === '0' ? 'ə' : 'ʌ';
  if (unit.base === 'ER') return unit.stress === '0' ? 'ər' : 'ɜr';
  return PLAIN_VOWEL_MAP[unit.base] ?? unit.base;
}

/**
 * ARPAbet 音素序列 → IPA 正文（**不带**首尾斜杠）。
 * 音素里有本项目不认识的符号时返回 null，由调用方决定怎么报错。
 */
export function arpaPhonesToIpa(phones: readonly string[]): string | null {
  const units: ArpaUnit[] = [];
  for (const p of phones) {
    const u = parsePhone(p);
    if (!u) return null;
    // 不认识的音素直接判失败，不要静默原样输出
    if (!isKnownBase(u.base)) return null;
    units.push(u);
  }
  const syls = syllabify(units);
  if (!syls) return null;

  const monosyllabic = syls.length === 1;
  // CMUdict 会给 in-/im-/un- 这类前缀标次重音（ˌɪnˈklud），教材不标。
  // 短词的次重音一律省略，长词保留（ˌɪnfərˈmeɪʃən 是教材写法）。
  const showSecondary = syls.length >= SECONDARY_STRESS_MIN_SYLLABLES;
  let out = '';
  for (const s of syls) {
    const unit = units[s.vowelIndex];
    if (!unit) return null;
    if (!monosyllabic && s.stress === '1') out += 'ˈ';
    else if (!monosyllabic && s.stress === '2' && showSecondary) out += 'ˌ';
    out += s.onset.map(toIpaSymbol).join('');
    out += nucleusOf(unit);
    out += s.coda.map(toIpaSymbol).join('');
  }
  return out;
}

/** IPA 正文 → 词表里存放的形式，带斜杠 */
export function wrapIpa(body: string): string {
  return `/${body}/`;
}

/**
 * 解析 CMUdict 文本。
 * 返回 lemma → 全部发音变体；`word(2)` 这类编号后缀被归并到同一个 key。
 */
export function parseCmudict(text: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';;;')) continue;
    const parts = line.split(/\s+/);
    const head = parts[0];
    if (!head) continue;
    const lemma = head.replace(/\(\d+\)$/, '').toLowerCase();
    const phones = parts.slice(1);
    if (phones.length === 0) continue;
    const existing = out.get(lemma);
    if (existing) existing.push(phones);
    else out.set(lemma, [phones]);
  }
  return out;
}

/**
 * 取一个词的首选发音并转成 IPA。
 * 取第一个变体：CMUdict 的第一个变体通常是最常见的读法，但并非绝对
 * （例如 `either` 的第一个变体是 `IY1` 一路），词表评审时需要抽查这类词。
 */
export function lookupIpa(dict: ReadonlyMap<string, string[][]>, lemma: string): string | null {
  const variants = dict.get(lemma.trim().toLowerCase());
  const first = variants?.[0];
  if (!first) return null;
  const body = arpaPhonesToIpa(first);
  return body === null ? null : wrapIpa(body);
}
