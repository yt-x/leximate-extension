import { describe, expect, it } from 'vitest';
import {
  arpaPhonesToIpa,
  lookupIpa,
  parseCmudict,
  parsePhone,
  syllabify,
  wrapIpa,
  type ArpaUnit,
} from './arpabet';

/** 把空格分隔的音素串转成 IPA，省得每条测试都写数组 */
function ipa(phones: string): string | null {
  const body = arpaPhonesToIpa(phones.split(/\s+/));
  return body === null ? null : wrapIpa(body);
}

function units(phones: string): ArpaUnit[] {
  return phones.split(/\s+/).map((p) => {
    const u = parsePhone(p);
    if (!u) throw new Error(`测试数据里出现了非法音素: ${p}`);
    return u;
  });
}

describe('parsePhone', () => {
  it('拆出基式与重音', () => {
    expect(parsePhone('AH1')).toEqual({ base: 'AH', stress: '1', isVowel: true });
    expect(parsePhone('AH0')).toEqual({ base: 'AH', stress: '0', isVowel: true });
  });

  it('辅音没有重音数字，默认按无重音处理', () => {
    expect(parsePhone('K')).toEqual({ base: 'K', stress: '0', isVowel: false });
  });

  it('非法音素返回 null', () => {
    expect(parsePhone('ah1')).toBeNull();
    expect(parsePhone('')).toBeNull();
    expect(parsePhone('1')).toBeNull();
  });
});

describe('syllabify', () => {
  it('元音个数即音节个数', () => {
    expect(syllabify(units('S T AH1 D IY0'))).toHaveLength(2);
    expect(syllabify(units('R AH1 N'))).toHaveLength(1);
  });

  it('没有元音就切不出音节', () => {
    expect(syllabify(units('S T'))).toBeNull();
  });

  it('最大首音原则：合法首音丛归后一个音节', () => {
    // computer = K AH0 M P Y UW1 T ER0 → 中间的 M P Y 里 "pj" 是合法首音丛
    const syls = syllabify(units('K AH0 M P Y UW1 T ER0'));
    expect(syls).toHaveLength(3);
    expect(syls?.[0]?.coda).toEqual(['M']);
    expect(syls?.[1]?.onset).toEqual(['P', 'Y']);
  });

  it('不合法首音丛拆开，前一个音节的尾音接住剩余辅音', () => {
    // government = G AH1 V ER0 N M AH0 N T → "NM" 不是合法首音丛，"M" 才是
    const syls = syllabify(units('G AH1 V ER0 N M AH0 N T'));
    expect(syls?.[1]?.coda).toEqual(['N']);
    expect(syls?.[2]?.onset).toEqual(['M']);
    expect(syls?.[2]?.coda).toEqual(['N', 'T']);
  });

  it('词首辅音全部归第一个音节', () => {
    const syls = syllabify(units('S T R IY1 T'));
    expect(syls?.[0]?.onset).toEqual(['S', 'T', 'R']);
  });
});

describe('arpaPhonesToIpa', () => {
  it('单音节词不标重音（教材写法）', () => {
    expect(ipa('R AH1 N')).toBe('/rʌn/');
    expect(ipa('AE1 S K')).toBe('/æsk/');
    expect(ipa('B EH1 D')).toBe('/bed/');
  });

  it('多音节词标出主重音与次重音', () => {
    expect(ipa('S T AH1 D IY0')).toBe('/ˈstʌdi/');
    expect(ipa('K AH0 M P Y UW1 T ER0')).toBe('/kəmˈpjutər/');
    expect(ipa('IH2 N F ER0 M EY1 SH AH0 N')).toBe('/ˌɪnfərˈmeɪʃən/');
  });

  it('AH 与 ER 按重音分流符号', () => {
    expect(ipa('AH0 B AW1 T')).toBe('/əˈbaʊt/'); // 无重音 AH → ə
    expect(ipa('AH1 P')).toBe('/ʌp/'); // 主重音 AH → ʌ
    expect(ipa('W AO1 T ER0')).toBe('/ˈwɔtər/'); // 无重音 ER → ər
    expect(ipa('B ER1 D')).toBe('/bɜrd/'); // 主重音 ER → ɜr
  });

  it('用 r 而不是 ɹ，用 e 而不是 ɛ，不带送气符号', () => {
    expect(ipa('R IY1 D')).toBe('/rid/');
    expect(ipa('T EH1 N')).toBe('/ten/');
    expect(ipa('K AE1 T')).toBe('/kæt/');
  });

  it('保留词尾辅音，不做口语删音', () => {
    expect(ipa('L AE1 S T')).toBe('/læst/');
  });

  it('不认识的音素返回 null，不静默输出', () => {
    expect(arpaPhonesToIpa(['R', 'ZZ', 'N'])).toBeNull();
    expect(arpaPhonesToIpa(['R', 'AH1', 'N'])).toBe('rʌn'); // 正文不带斜杠
  });

  it('空输入返回 null', () => {
    expect(arpaPhonesToIpa([])).toBeNull();
  });

  it('短词的次重音省略，长词保留', () => {
    // CMUdict 给 in- 前缀标了次重音，但教材不标
    expect(ipa('IH2 N K L UW1 D')).toBe('/ɪnˈklud/');
    expect(ipa('IH2 M P R UW1 V')).toBe('/ɪmˈpruv/');
    expect(ipa('IH2 T S EH1 L F')).toBe('/ɪtˈself/');
    // 四音节起才写次重音
    expect(ipa('IH2 N F ER0 M EY1 SH AH0 N')).toBe('/ˌɪnfərˈmeɪʃən/');
    expect(ipa('IH2 N T ER0 N AE1 SH AH0 N AH0 L')).toBe('/ˌɪntərˈnæʃənəl/');
  });

  it('重音标记的数法与音节数一致', () => {
    const body = arpaPhonesToIpa(['IH2', 'N', 'F', 'ER0', 'M', 'EY1', 'SH', 'AH0', 'N']);
    expect((body ?? '').match(/[ˈˌ]/g)).toHaveLength(2);
  });
});

describe('parseCmudict', () => {
  const SAMPLE = [
    ';;; 注释要跳过',
    '',
    'run R AH1 N',
    'run(2) R AH1 N',
    'either IY1 DH ER0',
    'either(2) AY1 DH ER0',
    "don't D OW1 N T",
  ].join('\n');

  it('归并 word(2) 变体到同一个词条', () => {
    const dict = parseCmudict(SAMPLE);
    expect(dict.get('run')).toHaveLength(2);
    expect(dict.get('either')).toHaveLength(2);
  });

  it('跳过注释与空行', () => {
    const dict = parseCmudict(SAMPLE);
    expect(dict.has(';;;')).toBe(false);
    expect([...dict.keys()]).toEqual(['run', 'either', "don't"]);
  });

  it('词条统一转小写', () => {
    const dict = parseCmudict('Run R AH1 N');
    expect(dict.has('run')).toBe(true);
  });

  it('取第一个变体作为首选发音', () => {
    const dict = parseCmudict(SAMPLE);
    expect(lookupIpa(dict, 'either')).toBe('/ˈiðər/');
    expect(lookupIpa(dict, 'run')).toBe('/rʌn/');
  });

  it('查不到的词返回 null', () => {
    const dict = parseCmudict(SAMPLE);
    expect(lookupIpa(dict, 'zzz')).toBeNull();
  });

  it('大小写与空白不影响查询', () => {
    const dict = parseCmudict(SAMPLE);
    expect(lookupIpa(dict, '  RUN ')).toBe('/rʌn/');
  });
});
