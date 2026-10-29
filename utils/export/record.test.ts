/**
 * 导出记录的列结构与取值（PLAN.md §3.1）的测试。
 *
 * 这一层测的是"某一列到底填什么"——五种格式共用同一份取值，
 * 因此这里错了会让五个文件一起错，而文件本身看起来又是"有内容的"。
 */
import { describe, expect, it } from 'vitest';
import { makeWord } from '../manager/testing';
import {
  buildRecord,
  buildRecords,
  cleanSingleLine,
  cleanText,
  defaultCsvColumns,
  definitionOf,
  EXPORT_COLUMNS,
  formatFrequency,
  joinAligned,
  joinLines,
  sortScenes,
} from './record';
import { makeScene } from './testing';

describe('字段清洗（§3.2.5）', () => {
  it('把 CRLF / CR 归一成 LF', () => {
    expect(cleanText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('剥掉控制字符，但保留换行', () => {
    expect(cleanText('a\u0000b\u0007c\u001fd')).toBe('abcd');
    expect(cleanText('a\nb')).toBe('a\nb');
    // C1 区（0x7F~0x9F）也在清洗范围内
    expect(cleanText('a\u009cb')).toBe('ab');
  });

  it('制表符换成空格：TSV 里含制表符的字段没法人工核对', () => {
    expect(cleanText('a\tb')).toBe('a b');
  });

  it('每行 trim、丢掉空行', () => {
    expect(cleanText('  a  \n\n  b  ')).toBe('a\nb');
    expect(cleanText('   ')).toBe('');
  });

  it('单行字段把换行折成空格', () => {
    expect(cleanSingleLine('a\nb')).toBe('a b');
    expect(cleanSingleLine('  a  ')).toBe('a');
  });

  it('joinLines 逐项清洗后按行拼接', () => {
    expect(joinLines(['n. 跑', '  ', 'v. 经营'])).toBe('n. 跑\nv. 经营');
  });
});

describe('例句与译文按行对齐（decisions/0018）', () => {
  it('中间的空行保留——那是"这一句没翻译"', () => {
    expect(joinAligned(['one', null, 'three'])).toBe('one\n\nthree');
  });

  it('末尾的空行裁掉，不丢信息', () => {
    expect(joinAligned(['one', null, null])).toBe('one');
  });

  it('译文的行号与例句一一对应', () => {
    const examples = joinAligned(['one', 'two', 'three']);
    const translations = joinAligned(['一', null, '三']);
    expect(examples.split('\n')).toHaveLength(3);
    expect(translations.split('\n')).toEqual(['一', '', '三']);
  });
});

describe('例句顺序', () => {
  it('按 capturedAt 升序，同一时刻按 id 兜底（导出必须可复现）', () => {
    const late = makeScene({ wordId: 'run', text: 'late', capturedAt: 300 });
    const early = makeScene({ wordId: 'run', text: 'early', capturedAt: 100 });
    const sameA = makeScene({ wordId: 'run', text: 'a', capturedAt: 200, id: 'a' });
    const sameB = makeScene({ wordId: 'run', text: 'b', capturedAt: 200, id: 'b' });

    // 入参刻意打乱：排序是这一层的职责，不是调用方的
    expect(sortScenes([late, sameB, early, sameA]).map((s) => s.text)).toEqual([
      'early',
      'a',
      'b',
      'late',
    ]);
  });
});

describe('各列取值（§3.1）', () => {
  it('列顺序、Anki 的 11 列、unlisted 默认不导出', () => {
    expect(EXPORT_COLUMNS.map((c) => c.csvHeader)).toEqual([
      'word',
      'phonetic',
      'definition',
      'examples',
      'example_translations',
      'source',
      'examTags',
      'frequency',
      'meetCount',
      'status',
      'unlisted',
      'createdAt',
    ]);
    expect(EXPORT_COLUMNS.filter((c) => c.inAnki).map((c) => c.ankiHeader)).toEqual([
      '单词',
      '美音音标',
      '释义',
      '例句',
      '例句翻译',
      '来源URL',
      '考试标签',
      '词频',
      '遇见次数',
      '状态',
      '创建时间',
    ]);
    expect(defaultCsvColumns()).not.toContain('unlisted');
    expect(defaultCsvColumns()).toHaveLength(11);
  });

  it('音标加斜杠；没有美音音标就留空（英音不在范围内）', () => {
    expect(buildRecord({ word: makeWord({ lemma: 'run', phoneticUs: 'rʌn' }), scenes: [] }).phonetic).toBe('/rʌn/');
    expect(buildRecord({ word: makeWord({ lemma: 'run' }), scenes: [] }).phonetic).toBe('');
  });

  it('释义按行排出；defZh 为空时退回迁移保留的 fallbackDef', () => {
    expect(definitionOf(makeWord({ lemma: 'run', defZh: ['v. 跑', 'n. 奔跑'] }))).toBe('v. 跑\nn. 奔跑');
    expect(definitionOf(makeWord({ lemma: 'run', fallbackDef: ['原平台释义'] }))).toBe('原平台释义');
    // defZh 存在时**不**混入 fallbackDef：两个来源的释义混排会让用户分不清哪个是当前的
    expect(definitionOf(makeWord({ lemma: 'run', defZh: ['新释义'], fallbackDef: ['旧释义'] }))).toBe('新释义');
  });

  it('来源取**首条**例句的 URL（不是最后一条）', () => {
    const record = buildRecord({
      word: makeWord({ lemma: 'run' }),
      scenes: [
        makeScene({ wordId: 'run', text: 'first', capturedAt: 100, sourceUrl: 'https://a.com/1' }),
        makeScene({ wordId: 'run', text: 'second', capturedAt: 200, sourceUrl: 'https://b.com/2' }),
      ],
    });
    expect(record.source).toBe('https://a.com/1');
    expect(record.examples).toBe('first\nsecond');
  });

  it('空例句 → 例句与来源都为空串（不是 "undefined"）', () => {
    const record = buildRecord({ word: makeWord({ lemma: 'run' }), scenes: [] });
    expect(record.examples).toBe('');
    expect(record.source).toBe('');
    expect(record.exampleTranslations).toBe('');
  });

  it('考试标签用逗号连接；未收录标记是字面量 true/false；时间是 ISO', () => {
    const record = buildRecord({
      word: makeWord({
        lemma: 'run',
        examTags: ['CET4', '考研'],
        isUnlisted: true,
        meetCount: 7,
        status: 'known',
        createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      }),
      scenes: [],
    });
    expect(record.examTags).toBe('CET4,考研');
    expect(record.unlisted).toBe('true');
    expect(record.meetCount).toBe('7');
    expect(record.status).toBe('known');
    expect(record.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('词频只写出有数据的那个；两个都没有就空（0 不等于"词频是 0"）', () => {
    expect(formatFrequency(makeWord({ lemma: 'a', freqBnc: 1234 }))).toBe('BNC 1234');
    expect(formatFrequency(makeWord({ lemma: 'a', freqBnc: 12, freqCoca: 34 }))).toBe('BNC 12 / COCA 34');
    expect(formatFrequency(makeWord({ lemma: 'a' }))).toBe('');
  });

  it('buildRecords 保持列表顺序（导出顺序 = 用户看到的顺序）', () => {
    const records = buildRecords([
      { word: makeWord({ lemma: 'beta' }), scenes: [] },
      { word: makeWord({ lemma: 'alpha' }), scenes: [] },
    ]);
    expect(records.map((r) => r.word)).toEqual(['beta', 'alpha']);
  });
});
