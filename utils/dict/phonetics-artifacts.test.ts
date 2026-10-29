/**
 * 对真实产物的校验：读盘上钉版的 CMUdict、覆盖表与词表，
 * 断言音标列确实可由它们重算出来。
 *
 * 这类测试的价值在于把"生成脚本跑过一次"变成"每次 CI 都重新验证一遍"。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arpaPhonesToIpa, lookupIpa, parseCmudict, wrapIpa } from './arpabet';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DICT_PATH = `${ROOT}data/pronunciation/cmudict.dict`;
const OVERRIDE_PATH = `${ROOT}data/pronunciation/overrides.tsv`;
const TSV_PATH = `${ROOT}data/core-words.tsv`;

interface Row {
  lemma: string;
  phoneticUs: string;
  phoneticUk: string;
  pos: string;
  defZh: string;
}

function readRows(): Row[] {
  return readFileSync(TSV_PATH, 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const c = line.split('\t');
      return {
        lemma: c[0] ?? '',
        phoneticUs: c[1] ?? '',
        phoneticUk: c[2] ?? '',
        pos: c[3] ?? '',
        defZh: c[4] ?? '',
      };
    });
}

function readOverrides(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(OVERRIDE_PATH, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [lemma, ipa] = line.split('\t');
    if (lemma && ipa) out.set(lemma, ipa);
  }
  return out;
}

const dict = parseCmudict(readFileSync(DICT_PATH, 'utf8'));
const rows = readRows();
const overrides = readOverrides();

describe('词表音标产物', () => {
  it('词表非空', () => {
    expect(rows.length).toBeGreaterThan(500);
  });

  it('每一行都有 lemma 与美音音标', () => {
    for (const r of rows) {
      expect(r.lemma, 'lemma 为空').not.toBe('');
      expect(r.phoneticUs, `${r.lemma} 缺音标`).not.toBe('');
    }
  });

  it('音标都写成 /…/ 形式', () => {
    for (const r of rows) {
      expect(r.phoneticUs, `${r.lemma}`).toMatch(/^\/[^/]+\/$/);
    }
  });

  it('每个 lemma 都能在钉版 CMUdict 里查到', () => {
    const missing = rows.filter((r) => !dict.has(r.lemma)).map((r) => r.lemma);
    expect(missing).toEqual([]);
  });

  it('非覆盖行的音标等于从 CMUdict 重算的结果', () => {
    const mismatched: string[] = [];
    for (const r of rows) {
      if (overrides.has(r.lemma)) continue;
      if (lookupIpa(dict, r.lemma) !== r.phoneticUs) mismatched.push(r.lemma);
    }
    expect(mismatched).toEqual([]);
  });

  it('覆盖表里的值确实是 CMUdict 列出的某个变体', () => {
    const bad: string[] = [];
    for (const [lemma, ipa] of overrides) {
      const variants = (dict.get(lemma) ?? [])
        .map((p) => {
          const body = arpaPhonesToIpa(p);
          return body === null ? null : wrapIpa(body);
        })
        .filter((x): x is string => x !== null);
      if (!variants.includes(ipa)) bad.push(`${lemma}: ${ipa}`);
    }
    expect(bad).toEqual([]);
  });

  it('覆盖表里的每个词都真的出现在词表里', () => {
    const lemmas = new Set(rows.map((r) => r.lemma));
    const unused = [...overrides.keys()].filter((k) => !lemmas.has(k));
    expect(unused).toEqual([]);
  });

  it('同形异音词取的是与释义相符的读音', () => {
    // 这些词若改回 CMUdict 首变体就会读成另一个词，用测试钉住
    const expected: Record<string, string> = {
      read: '/rid/',
      live: '/lɪv/',
      wind: '/wɪnd/',
      lead: '/lid/',
      close: '/kloʊz/',
      use: '/juz/',
      subject: '/ˈsʌbdʒɪkt/',
      record: '/ˈrekərd/',
      impact: '/ˈɪmpækt/',
    };
    for (const [lemma, ipa] of Object.entries(expected)) {
      const row = rows.find((r) => r.lemma === lemma);
      expect(row, `${lemma} 不在词表里`).toBeDefined();
      expect(row?.phoneticUs, `${lemma}`).toBe(ipa);
    }
  });

  it('短词不写次重音', () => {
    // 音节数按 CMUdict 的元音音素个数算，与实现同一口径；
    // 从 IPA 字符串反推会被双元音和 ə/ɜ 坑到。
    const isVowel = (p: string): boolean => /^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)\d?$/.test(p);
    const odd: string[] = [];
    for (const r of rows) {
      if (!r.phoneticUs.includes('ˌ')) continue;
      const phones = dict.get(r.lemma)?.[0] ?? [];
      const syllables = phones.filter(isVowel).length;
      if (syllables < 4) odd.push(`${r.lemma} ${r.phoneticUs} (${syllables} 音节)`);
    }
    expect(odd).toEqual([]);
  });

  it('英音列按当前决策留空', () => {
    const filled = rows.filter((r) => r.phoneticUk !== '').map((r) => r.lemma);
    expect(filled).toEqual([]);
  });
});

/**
 * 与外部来源交叉校验重音安放。
 *
 * 音节切分与重音位置在本项目里都是规则推导出来的，是全管线最不确定的一环。
 * 这里拿 NVIDIA NeMo 的成品 IPA 版 CMUdict 当独立参照物：
 * 只比「主重音落在第几个音节」，不比符号（两边符号约定刻意不同）。
 *
 * 已知会不一致的三处是本项目有意为之的同形异音词覆盖，见下面的豁免表。
 */
describe('重音安放与外部来源交叉校验', () => {
  const FIXTURE = `${ROOT}data/pronunciation/nemo-stress-fixture.tsv`;

  const DIPHTHONGS = ['aɪ', 'aʊ', 'eɪ', 'oʊ', 'ɔɪ'];
  const VOWELS = /[ɑæʌeioɔuəɜɪʊ]/;

  /** 把两边符号拉到同一套，只为比结构不比写法 */
  function normalize(ipa: string): string {
    return ipa
      .replace(/ɹ/g, 'r')
      .replace(/ɝ/g, 'ɜr')
      .replace(/ɚ/g, 'ər')
      .replace(/ɛ/g, 'e')
      .replace(/ɡ/g, 'g')
      .replace(/ː/g, '')
      .replace(/\s+/g, '');
  }

  function countNuclei(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      if (DIPHTHONGS.includes(s.slice(i, i + 2))) {
        n++;
        i++;
        continue;
      }
      if (VOWELS.test(s[i] ?? '')) n++;
    }
    return n;
  }

  /** 主重音在第几个音节（1 起）；无标记或单音节返回 null */
  function stressIndex(ipa: string): number | null {
    const s = normalize(ipa);
    const pri = s.indexOf('ˈ');
    if (pri < 0) return null;
    if (countNuclei(s) <= 1) return null;
    return countNuclei(s.slice(0, pri)) + 1;
  }

  const fixture = new Map(
    readFileSync(FIXTURE, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'))
      .slice(1)
      .map((l) => {
        const [lemma, ipa] = l.split('\t');
        return [lemma ?? '', ipa ?? ''] as const;
      }),
  );

  // 本项目按词性/释义刻意选的另一个读音：名词与形容词取靠前重音、动词取靠后重音，
  // 而对照数据（与 CMUdict 一样）自己排了个首变体，多数时候排的是另一个。
  // 逐条理由在 data/pronunciation/overrides.tsv。
  const INTENTIONAL = new Set([
    'abstract',
    'attribute',
    'combine',
    'convert',
    'convict',
    'exploit',
    'impact',
    'import',
    'perfect',
    'recall',
    'record',
    'research',
    'subject',
    'survey',
    'transfer',
    'transport',
    'update',
  ]);

  // 外部对照文件没有收录的词条（`mg` 只收了 MGM；`singularity` 整体缺失）。
  // 它们的音标仍来自本项目管线（CMUdict 有读音），只是无法参与重音对照。
  const NO_EXTERNAL_REFERENCE = new Set(['mg', 'singularity']);

  it('对照数据覆盖整份词表（除显式豁免的外部未收录项）', () => {
    const missing = rows
      .filter((r) => !fixture.has(r.lemma) && !NO_EXTERNAL_REFERENCE.has(r.lemma))
      .map((r) => r.lemma);
    expect(missing).toEqual([]);
  });

  it('豁免的外部未收录项确实不在对照数据里，且本项目音标非空', () => {
    for (const lemma of NO_EXTERNAL_REFERENCE) {
      const row = rows.find((r) => r.lemma === lemma);
      expect(row, `${lemma} 不在词表`).toBeDefined();
      expect(fixture.has(lemma), `${lemma} 已在对照数据里，豁免应删除`).toBe(false);
      expect(row?.phoneticUs).not.toBe('');
    }
  });

  it('多音节词的主重音落点与外部来源一致（豁免有意为之的同形异音词）', () => {
    const mismatched: string[] = [];
    for (const r of rows) {
      if (INTENTIONAL.has(r.lemma)) continue;
      const mine = stressIndex(r.phoneticUs);
      const theirs = stressIndex(fixture.get(r.lemma) ?? '');
      if (mine === null || theirs === null) continue;
      if (mine !== theirs) {
        mismatched.push(`${r.lemma}: 本项目第 ${mine} 音节 / 外部第 ${theirs} 音节`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('被豁免的同形异音词确实是各自的另一个读音，不是悄悄放过', () => {
    for (const lemma of INTENTIONAL) {
      const row = rows.find((r) => r.lemma === lemma);
      const theirs = fixture.get(lemma) ?? '';
      expect(row, `${lemma} 不在词表`).toBeDefined();
      expect(row?.phoneticUs, `${lemma} 不该与外部来源相同`).not.toBe(theirs);
    }
  });

  /**
   * 同形异音词（名词/形容词 与 动词的主重音对立）。
   *
   * 这一类**两个来源都看不见**：本项目取 CMUdict 首变体，对照数据也按它自己的顺序取首变体，
   * 两边顺序还一致（`convict`/`perfect` 实测如此）。所以只能靠"词性 ↔ 重音落点"的显式清单守住：
   * 名词与形容词取靠前重音，动词取靠后重音。清单里的词都带 overrides.tsv 条目。
   */
  const STRESS_PAIRS: Array<[string, string, number]> = [
    ['abstract', 'adj.', 1],
    ['attribute', 'n.', 1],
    ['combine', 'v.', 2],
    ['convert', 'v.', 2],
    ['convict', 'v.', 2],
    ['exploit', 'v.', 2],
    ['impact', 'n.', 1],
    ['import', 'n.', 1],
    ['perfect', 'adj.', 1],
    ['recall', 'v.', 2],
    ['record', 'n.,v.', 1],
    ['research', 'n.,v.', 1],
    ['subject', 'n.', 1],
    ['survey', 'n.', 1],
    ['transfer', 'n.', 1],
    ['transport', 'n.', 1],
    ['update', 'n.', 1],
  ];

  it('同形异音词按词性取对应的重音变体', () => {
    const wrong: string[] = [];
    for (const [lemma, pos, expected] of STRESS_PAIRS) {
      const row = rows.find((r) => r.lemma === lemma);
      expect(row, `${lemma} 不在词表`).toBeDefined();
      expect(row?.pos, `${lemma} 的词性变了，重音该重新定`).toBe(pos);
      const mine = stressIndex(row?.phoneticUs ?? '');
      if (mine !== expected) wrong.push(`${lemma}(${pos}): 主重音在第 ${mine} 音节，应为第 ${expected} 音节`);
    }
    expect(wrong).toEqual([]);
  });
});
