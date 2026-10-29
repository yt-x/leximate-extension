/**
 * 五种格式的序列化测试（PLAN.md §3.2.1 ~ §3.2.5）。
 *
 * §3.2.1 的测试点在这里逐条落地：含 `"` / 含 `;` / 含 `,` / 含真实换行 /
 * 含字面量 `<br>` / 中文全角标点 / 空例句 / 含空格的短语 →
 * **回读后记录数必须等于词数**。
 *
 * 回读用的是测试自带的独立解析器（`tests/csv-parser.ts`），不共用写码路径。
 */
import { describe, expect, it } from 'vitest';
import { makeWord } from '../manager/testing';
import { parseDelimited } from '../../tests/csv-parser';
import {
  ankiColumnsHeader,
  BACKUP_SCHEMA_VERSION,
  buildBackupPayload,
  buildExportFile,
  columnsFromKeys,
  csvEscape,
  exportFilename,
  normalizeChapter,
  targetMeta,
  toAnkiTsv,
  toCsv,
  toWordList,
  uniqueWords,
  type ExportTarget,
} from './formats';
import { buildRecords, type ExportRecord } from './record';
import { makeScene } from './testing';

/**
 * 八种"会在分隔符文本里出事"的取值，一条一个。
 *
 * 这些不是想象出来的边界：Anki 手册逐条列了它们（见
 * `docs/reference/export-formats.md` §1），M0 的导出脚本也在这上面栽过。
 */
const NASTY: Array<{ lemma: string; text?: string; def: string[]; translation?: string }> = [
  { lemma: 'quote', text: 'He said "hi" loudly.', def: ['含双引号 " 的释义'] },
  { lemma: 'semicolon', text: 'a; b; c', def: ['分号 ; 在释义里'] },
  { lemma: 'comma', text: 'one, two, three', def: ['逗号, 在释义里'] },
  { lemma: 'newline', text: 'first line\nsecond line', def: ['换行\n在释义里'] },
  { lemma: 'br', text: 'literal <br> here', def: ['字面量 <br> 必须原样保留'] },
  { lemma: 'cjk', text: '中文全角标点：，。；！？', def: ['全角标点，；'] },
  { lemma: 'empty', def: [] },
  { lemma: 'take into account', text: 'Please take into account the cost.', def: ['词组，含空格'] },
];

function nastyRecords(): ExportRecord[] {
  return buildRecords(
    NASTY.map((item) => ({
      word: makeWord({ lemma: item.lemma, defZh: item.def }),
      scenes: item.text
        ? [makeScene({ wordId: item.lemma, text: item.text, translation: item.translation ?? null })]
        : [],
    })),
  );
}

describe('§3.2.1 Anki TSV', () => {
  const tsv = toAnkiTsv(nastyRecords());
  const lines = tsv.split('\n');

  it('文件头四行逐字，且 #columns 用制表符分隔', () => {
    expect(lines[0]).toBe('#separator:tab');
    expect(lines[1]).toBe('#html:false');
    expect(lines[2]).toBe(
      '#columns:单词\t美音音标\t释义\t例句\t例句翻译\t来源URL\t考试标签\t词频\t遇见次数\t状态\t创建时间',
    );
    expect(lines[3]).toBe('#deck:Leximate');
    expect(ankiColumnsHeader().split('\t')).toHaveLength(11);
  });

  it('回读后记录数 = 词数 + 4 行文件头（含真实换行与双引号的字段没有被拆成多条）', () => {
    const records = parseDelimited(tsv, '\t');
    expect(records).toHaveLength(NASTY.length + 4);
  });

  it('每行字段数一致（Anki 按首个非注释行定列数，多出的列会被丢弃）', () => {
    // 只查数据行：`#` 开头的行对 Anki 是注释，不参与列数判定
    for (const record of parseDelimited(tsv, '\t').slice(4)) {
      expect(record).toHaveLength(11);
    }
  });

  it('首列非空且是单词（Anki 用首字段判唯一性）', () => {
    const data = parseDelimited(tsv, '\t').slice(4);
    expect(data.map((record) => record[0])).toEqual(NASTY.map((item) => item.lemma));
  });

  it('换行留在字段内；字面量 <br> 不被改写（因为钉死了 #html:false）', () => {
    const data = parseDelimited(tsv, '\t').slice(4);
    const byWord = new Map(data.map((record) => [record[0] as string, record]));
    expect(byWord.get('newline')?.[3]).toBe('first line\nsecond line');
    expect(byWord.get('newline')?.[2]).toBe('换行\n在释义里');
    expect(byWord.get('br')?.[3]).toBe('literal <br> here');
    expect(byWord.get('quote')?.[3]).toBe('He said "hi" loudly.');
  });

  it('空例句的词写出空字段，而不是省略字段或写 undefined', () => {
    const data = parseDelimited(tsv, '\t').slice(4);
    const empty = data.find((record) => record[0] === 'empty');
    expect(empty?.[2]).toBe('');
    expect(empty?.[3]).toBe('');
    expect(empty?.[5]).toBe('');
  });

  it('没有空行、末尾没有换行（空行会被 Anki 当成一条记录）', () => {
    expect(lines.every((line) => line !== '')).toBe(true);
    expect(tsv.endsWith('\n')).toBe(false);
  });
});

describe('§3.2.2 通用 CSV', () => {
  const csv = toCsv(nastyRecords());

  it('写表头（与 Anki 相反），列名与 §3.1 字面一致', () => {
    expect(csv.split('\r\n')[0]).toBe(
      'word,phonetic,definition,examples,example_translations,source,' +
        'examTags,frequency,meetCount,status,createdAt',
    );
  });

  it('记录间用 CRLF：按 CRLF 切正好是表头 + 每个词一行', () => {
    // 字段内的换行是 LF（已归一），因此不会与记录分隔符混淆
    expect(csv.split('\r\n')).toHaveLength(NASTY.length + 1);
    expect(csv.endsWith('\r\n')).toBe(false);
  });

  it('回读后记录数 = 词数 + 表头，且内容逐字还原', () => {
    const records = parseDelimited(csv, ',');
    expect(records).toHaveLength(NASTY.length + 1);

    const byWord = new Map(records.slice(1).map((record) => [record[0] as string, record]));
    expect(byWord.get('quote')?.[3]).toBe('He said "hi" loudly.');
    expect(byWord.get('comma')?.[3]).toBe('one, two, three');
    expect(byWord.get('semicolon')?.[3]).toBe('a; b; c');
    expect(byWord.get('newline')?.[3]).toBe('first line\nsecond line');
    expect(byWord.get('br')?.[3]).toBe('literal <br> here');
    expect(byWord.get('cjk')?.[3]).toBe('中文全角标点：，。；！？');
    expect(byWord.get('empty')?.[3]).toBe('');
  });

  it('字段转义照 RFC 4180：含分隔符/引号/换行的才包裹，内部引号双写', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
    expect(csvEscape('a\r\nb')).toBe('"a\r\nb"');
  });

  it('FR-G3：勾了哪些列就只导出哪些列（顺序仍按 §3.1）', () => {
    const picked = toCsv(nastyRecords(), ['meetCount', 'word']);
    const records = parseDelimited(picked, ',');
    expect(records[0]).toEqual(['word', 'meetCount']);
    expect(records[1]).toHaveLength(2);
    expect(columnsFromKeys(['meetCount', 'word']).map((c) => c.key)).toEqual(['word', 'meetCount']);
  });
});

describe('§3.2.3 / §3.2.4 纯单词表', () => {
  it('只有单词：一行一个，去重、去空行、首尾 trim，不含释义与音标', () => {
    const text = toWordList(
      buildRecords([
        { word: makeWord({ lemma: 'run', defZh: ['v. 跑'] }), scenes: [] },
        { word: makeWord({ lemma: 'run' }), scenes: [] },
        { word: makeWord({ lemma: 'jump' }), scenes: [] },
      ]),
    );
    expect(text).toBe('run\njump');
  });

  it('uniqueWords 保持首次出现的顺序', () => {
    const records = buildRecords([
      { word: makeWord({ lemma: 'beta' }), scenes: [] },
      { word: makeWord({ lemma: 'alpha' }), scenes: [] },
      { word: makeWord({ lemma: 'beta' }), scenes: [] },
    ]);
    expect(uniqueWords(records)).toEqual(['beta', 'alpha']);
  });

  it('§3.2.4 章节名归一：自带的 # 会被去掉，半角井号只出现一次', () => {
    expect(normalizeChapter('##基础')).toBe('基础');
    expect(normalizeChapter('  考研核心  ')).toBe('考研核心');
    expect(normalizeChapter('   ')).toBe('');
    expect(toWordList(buildRecords([{ word: makeWord({ lemma: 'run' }), scenes: [] }]), { chapter: '##基础' })).toBe(
      '#基础\nrun',
    );
    // 不传章节时不写任何 # 行
    expect(toWordList(buildRecords([{ word: makeWord({ lemma: 'run' }), scenes: [] }]))).toBe('run');
  });
});

describe('§3.2.5 文件名与编码', () => {
  it('文件名匹配规格里的正则，扩展名随格式变化', () => {
    const at = new Date(2026, 9, 16, 15, 3);
    const expected: Record<ExportTarget, string> = {
      anki: 'leximate-anki-20261016-1503.tsv',
      csv: 'leximate-csv-20261016-1503.csv',
      bbdc: 'leximate-bbdc-20261016-1503.txt',
      maimemo: 'leximate-maimemo-20261016-1503.txt',
      json: 'leximate-json-20261016-1503.json',
    };
    for (const target of Object.keys(expected) as ExportTarget[]) {
      const name = exportFilename(target, at);
      expect(name).toBe(expected[target]);
      expect(name).toMatch(/^leximate-[a-z]+-\d{8}-\d{4}\.(tsv|csv|txt|json)$/);
    }
  });

  it('只有 CSV 带 BOM 标记（§3.2.5：文本导出统一 UTF-8，仅 CSV 带 BOM）', () => {
    expect(targetMeta('csv').bom).toBe(true);
    for (const target of ['anki', 'bbdc', 'maimemo', 'json'] as ExportTarget[]) {
      expect(targetMeta(target).bom).toBe(false);
    }
  });

  it('buildExportFile 按目标选对文本与元信息', () => {
    const records = nastyRecords();
    const tsv = buildExportFile({ target: 'anki', records, at: new Date(2026, 9, 16, 15, 3) });
    expect(tsv.filename).toBe('leximate-anki-20261016-1503.tsv');
    expect(tsv.mime).toBe('text/tab-separated-values');
    expect(tsv.text.startsWith('#separator:tab')).toBe(true);

    const csv = buildExportFile({ target: 'csv', records });
    expect(csv.bom).toBe(true);
    expect(csv.text.startsWith('word,')).toBe(true);

    const bbdc = buildExportFile({ target: 'bbdc', records });
    expect(bbdc.text).toBe(NASTY.map((item) => item.lemma).join('\n'));
  });

  it('JSON 目标缺备份载荷时直接报错，不产出空文件', () => {
    expect(() => buildExportFile({ target: 'json', records: [] })).toThrow(/备份载荷/);
  });
});

describe('JSON 备份载荷（§3.2 / decisions/0019）', () => {
  const words = [
    makeWord({ lemma: 'run', defZh: ['v. 跑'], fallbackDef: ['原平台'] }),
    makeWord({ lemma: 'jump' }),
  ];
  const scenes = [
    makeScene({ wordId: 'run', text: 'I run daily.', translation: '我每天跑步。', capturedAt: 100 }),
    makeScene({ wordId: 'jump', text: 'Jump high.', translation: null, capturedAt: 200 }),
  ];

  it('带 schemaVersion / 计数 / 版本号', () => {
    const payload = buildBackupPayload({
      words,
      scenes,
      appVersion: '0.1.0',
      dictVersion: '1.2.3',
      at: new Date(Date.UTC(2026, 9, 16, 7, 30)),
    });
    expect(payload.app).toBe('leximate');
    expect(payload.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(payload.exportedAt).toBe('2026-10-16T07:30:00.000Z');
    expect(payload.appVersion).toBe('0.1.0');
    expect(payload.dictVersion).toBe('1.2.3');
    expect(payload.counts).toEqual({ words: 2, scenes: 2 });
  });

  it('只含词与例句：设置、翻译缓存、队列、墓碑都不进文件（FR-H7 的可断言形式）', () => {
    const payload = buildBackupPayload({ words, scenes, appVersion: '0.1.0', dictVersion: '' });
    expect(Object.keys(payload).sort()).toEqual(
      ['app', 'appVersion', 'counts', 'dictVersion', 'exportedAt', 'schemaVersion', 'scenes', 'words'].sort(),
    );
    const text = JSON.stringify(payload);
    // 凭据字段名一个都不许出现（settings 里的 webdav / apiKey 是硬约束）
    expect(text).not.toContain('webdav');
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('password');
  });

  it('OQ8：勾掉翻译后 translation 为 null，且不改动传入的例句', () => {
    const payload = buildBackupPayload({
      words,
      scenes,
      appVersion: '0.1.0',
      dictVersion: '',
      includeTranslations: false,
    });
    expect(payload.scenes.map((scene) => scene.translation)).toEqual([null, null]);
    // 入参不被改写：导出是无损的，连内存里的对象都不该动
    expect(scenes[0]?.translation).toBe('我每天跑步。');
  });

  it('词是拷贝：改返回值不会影响传进来的词', () => {
    const payload = buildBackupPayload({ words, scenes, appVersion: '0.1.0', dictVersion: '' });
    payload.words[0]!.lemma = 'mutated';
    expect(words[0]?.lemma).toBe('run');
  });

  it('JSON 文本可被解析回同一份载荷（可回灌的前提）', () => {
    const payload = buildBackupPayload({ words, scenes, appVersion: '0.1.0', dictVersion: '' });
    const file = buildExportFile({
      target: 'json',
      records: [],
      backup: payload,
      at: new Date(2026, 9, 16, 15, 3),
    });
    expect(file.filename).toBe('leximate-json-20261016-1503.json');
    expect(JSON.parse(file.text)).toEqual(payload);
  });
});
