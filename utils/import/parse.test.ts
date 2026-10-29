/**
 * 导入文件解析的测试（PLAN.md FR-J4）。
 *
 * 重点是**两种真实文件的形状**：M0 脚本的导出（日期是文本、`-1` 表示没找到高亮）
 * 与本项目的备份（时间是 epoch、例句在顶层按 `wordId` 挂）。
 * 形状错了不会报错，只会安静地少导入一批东西——那是最难查的一类问题。
 */
import { describe, expect, it } from 'vitest';
import { makeWord } from '../manager/testing';
import { makeScene } from '../export/testing';
import { detectFormat, parseImport, parseTime, safeSpan } from './parse';
import { leximateBackup, metwordExport } from './testing';

describe('detectFormat：认不出来就报错，不猜', () => {
  it('认出 M0 导出（meta + words[].word）', () => {
    expect(detectFormat(metwordExport([{ word: 'run' }]))).toBe('metword');
  });

  it('认出本项目备份（app + schemaVersion）', () => {
    expect(detectFormat(leximateBackup({ words: [makeWord({ lemma: 'run' })], scenes: [] }))).toBe(
      'leximate',
    );
  });

  it('其它 JSON 一律 unrecognized（返回 null）', () => {
    expect(detectFormat({ hello: 'world' })).toBeNull();
    expect(detectFormat({ words: [] })).toBeNull();
    expect(detectFormat([])).toBeNull();
    expect(detectFormat(null)).toBeNull();
  });
});

describe('parseImport：报错要说人话', () => {
  it('空文件', () => {
    expect(() => parseImport('   ')).toThrow(/文件是空的/);
  });

  it('不是 JSON', () => {
    expect(() => parseImport('word,phonetic\nrun,rʌn')).toThrow(/不是.*合法的 JSON/);
  });

  it('认不出格式时给出两种支持的形状', () => {
    expect(() => parseImport(JSON.stringify({ hello: 1 }))).toThrow(/认不出这个文件的格式/);
  });

  it('没有词条的文件', () => {
    expect(() => parseImport(JSON.stringify(metwordExport([])))).toThrow(/没有可导入的词条/);
  });
});

describe('parseImport：M0 导出的形状（FR-J2 的字段）', () => {
  const bundle = parseImport(
    JSON.stringify(
      metwordExport([
        {
          word: 'running',
          status: 'known',
          meetCount: 7,
          phoneticUs: 'ˈrʌnɪŋ',
          defZh: ['v. 跑'],
          firstSeenAt: '2026-09-01',
          scenes: [
            { text: 'I am running.', sourceUrl: 'https://a.com/1', capturedAt: '2026-09-02' },
            { text: 'Running is fun.', sourceUrl: 'https://b.com/2', capturedAt: '2026-09-03' },
          ],
        },
        { word: 'proof' },
      ]),
    ),
  );

  it('格式、时间与计数', () => {
    expect(bundle.format).toBe('metword');
    expect(bundle.exportedAt).toBe('2026-10-13T10:00:00.000Z');
    expect(bundle.schemaVersion).toBeNull();
    expect(bundle.words).toHaveLength(2);
    expect(bundle.skippedWords).toBe(0);
    expect(bundle.unparsedTimes).toBe(0);
  });

  it('词形、状态、次数、音标、释义、来源标记', () => {
    const running = bundle.words[0]!;
    expect(running.raw).toBe('running');
    expect(running.surface).toBe('running');
    expect(running.status).toBe('known');
    expect(running.meetCount).toBe(7);
    expect(running.phoneticUs).toBe('ˈrʌnɪŋ');
    expect(running.defZh).toEqual(['v. 跑']);
    // M0 来的词一律标 migrated：它们不是在本机网页上遇见的
    expect(running.origin).toBe('migrated');
    expect(running.createdAt).toBe(Date.parse('2026-09-01'));
  });

  it('例句：文本、来源、时间文本被解析成 epoch', () => {
    const running = bundle.words[0]!;
    expect(running.scenes.map((scene) => scene.text)).toEqual([
      'I am running.',
      'Running is fun.',
    ]);
    expect(running.scenes[0]!.capturedAt).toBe(Date.parse('2026-09-02'));
    expect(running.scenes[0]!.sourceUrl).toBe('https://a.com/1');
  });

  it('没有 defZh 的条目照样能导入（脚本是按需抓释义的）', () => {
    expect(bundle.words[1]!.defZh).toEqual([]);
  });
});

describe('parseImport：本项目备份的形状', () => {
  const word = makeWord({ lemma: 'run', surface: 'running', defZh: ['v. 跑'], defSrc: 'authored' });
  const bundle = parseImport(
    JSON.stringify(
      leximateBackup({
        words: [word],
        scenes: [makeScene({ wordId: word.id, text: 'I run daily.', capturedAt: 123456 })],
      }),
    ),
  );

  it('词来自 words[]，例句按 wordId 挂回词上', () => {
    expect(bundle.format).toBe('leximate');
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.words[0]!.raw).toBe('run');
    expect(bundle.words[0]!.surface).toBe('running');
    expect(bundle.words[0]!.scenes).toHaveLength(1);
    expect(bundle.words[0]!.scenes[0]!.capturedAt).toBe(123456);
  });

  it('origin 不是 migrated 就保持 native（备份回灌不是迁移）', () => {
    expect(bundle.words[0]!.origin).toBe('native');
  });
});

describe('坏条目：跳过并计数，不静默', () => {
  it('词不是对象 / 词形是空的都计入 skippedWords', () => {
    const payload = metwordExport([{ word: 'run' }]) as { words: unknown[] };
    payload.words.push(null, { word: '   ' }, 42);

    const bundle = parseImport(JSON.stringify(payload));
    expect(bundle.words).toHaveLength(1);
    expect(bundle.skippedWords).toBe(3);
  });

  it('没有文本的例句计入 skippedScenes（其余照常导入）', () => {
    const payload = metwordExport([
      { word: 'run', scenes: [{ text: '' }, { text: 'ok' }] },
    ]) as { words: Array<{ scenes: unknown[] }> };
    payload.words[0]!.scenes.push({ text: '' }, null);

    const bundle = parseImport(JSON.stringify(payload));
    expect(bundle.words[0]!.scenes).toHaveLength(1);
    expect(bundle.skippedScenes).toBe(3);
  });

  it('时间解析不出来时计 unparsedTimes，且值保持 null（不假装是 0）', () => {
    const bundle = parseImport(
      JSON.stringify(
        metwordExport([
          { word: 'run', firstSeenAt: '不是日期', scenes: [{ text: 'x', capturedAt: '' }] },
        ]),
      ),
    );
    expect(bundle.words[0]!.createdAt).toBeNull();
    expect(bundle.words[0]!.scenes[0]!.capturedAt).toBeNull();
    expect(bundle.unparsedTimes).toBe(2);
  });
});

describe('safeSpan：M0 的 -1 要归一', () => {
  const text = 'I am running.';

  it('-1 表示"没找到"，归一为 0/0（而不是让切片落空）', () => {
    expect(safeSpan(text, -1, -1)).toEqual({ highlightFrom: 0, highlightTo: 0 });
  });

  it('越界被夹到文本长度内', () => {
    expect(safeSpan(text, 3, 999)).toEqual({ highlightFrom: 3, highlightTo: text.length });
    expect(safeSpan(text, -5, 4)).toEqual({ highlightFrom: 0, highlightTo: 4 });
  });

  it('from > to 时收敛成空区间（不产生倒置切片）', () => {
    expect(safeSpan(text, 8, 2)).toEqual({ highlightFrom: 8, highlightTo: 8 });
  });

  it('非数字退成 0/0', () => {
    expect(safeSpan(text, 'x', undefined)).toEqual({ highlightFrom: 0, highlightTo: 0 });
  });
});

describe('parseTime：文本与 epoch 都要认', () => {
  it('epoch 数字', () => {
    expect(parseTime(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('ISO 与日期文本', () => {
    expect(parseTime('2026-09-02')).toBe(Date.parse('2026-09-02'));
    expect(parseTime('2026-10-13T10:00:00.000Z')).toBe(Date.parse('2026-10-13T10:00:00.000Z'));
  });

  it('空格分隔的日期时间（Safari 不认，这里要能兜住）', () => {
    expect(parseTime('2026-10-13 21:03')).toBe(Date.parse('2026-10-13T21:03'));
  });

  it('数字字符串当 epoch', () => {
    expect(parseTime('1700000000000')).toBe(1_700_000_000_000);
  });

  it('垃圾值与非正值回 null', () => {
    expect(parseTime('昨天')).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(parseTime(0)).toBeNull();
    expect(parseTime(-1)).toBeNull();
    expect(parseTime(null)).toBeNull();
  });
});
