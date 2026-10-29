/**
 * FR-B7 验收判定：`ecdict.csv` 解析、分档与映射（`changes/M1M2-closeout.md` 切片 1）。
 *
 * 判定来源逐条对应：
 * - A1 表头不符 → 拒绝（不是尽力而为地导入一半）
 * - A2 含半角逗号 / 双引号 / 字面 `\n` 的字段解析正确
 * - A3 字段数异常行计入 skipped，不中断整份文件
 * - A4 标准档只收 8 个考试标签任一非空的词；完整档收全量
 * - A5 内置词表已收录的词不进导入计划（库里已有 → 库里赢，FR-B9/B10）
 * - A6 取消信号能让分批导入停下，且不留半截数据（`ecdict-apply.test.ts` 覆盖）
 */
import { describe, expect, it } from 'vitest';

import {
  ECDICT_COLUMNS,
  ECDICT_STANDARD_TAGS,
  isStandardTier,
  mapRowToWord,
  parseEcdictHeader,
  parseEcdictLine,
  parseEcdictRows,
} from './ecdict-parse';

const HEADER = ECDICT_COLUMNS.join(',');

/**
 * 按列序造一行，避免手数 13 个字段出错。
 * 未给的列留空；需要引号包裹的字段由调用方自己带引号。
 */
function csvRow(fields: Partial<Record<(typeof ECDICT_COLUMNS)[number], string>>): string {
  return ECDICT_COLUMNS.map((name) => fields[name] ?? '').join(',');
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\r\n');
}

describe('parseEcdictHeader（A1 表头校验）', () => {
  it('13 列逐字匹配时通过', () => {
    expect(parseEcdictHeader(HEADER)).toEqual({ ok: true });
  });

  it('列顺序不对时拒绝', () => {
    const swapped: string[] = [...ECDICT_COLUMNS];
    swapped[0] = 'phonetic';
    swapped[1] = 'word';
    const result = parseEcdictHeader(swapped.join(','));
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
  });

  it('缺列时拒绝', () => {
    const result = parseEcdictHeader(ECDICT_COLUMNS.slice(0, 12).join(','));
    expect(result.ok).toBe(false);
  });

  it('BOM 与首尾空白不算错', () => {
    expect(parseEcdictHeader(`\uFEFF${HEADER}\r`)).toEqual({ ok: true });
  });
});

describe('parseEcdictLine（A2 RFC4180 字段）', () => {
  it('字段内含半角逗号时不被切开', () => {
    const line = csvRow({
      word: 'constraint',
      phonetic: "kәn'streint",
      translation: '"n. 强制, 约束\\n[计] 约束"',
      collins: '2',
      tag: 'cet6 toefl gre',
      bnc: '2988',
      frq: '4643',
      exchange: 's:constraints',
    });
    const parsed = parseEcdictLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.word).toBe('constraint');
    expect(parsed?.translation).toBe('n. 强制, 约束\\n[计] 约束');
  });

  it('双引号包裹且内含逗号的字段解析正确', () => {
    const line = csvRow({ word: 'run', phonetic: 'rʌn', definition: '"a, b, c"', translation: '"n. 跑, 赛跑\\nvi. 跑"', collins: '5', oxford: '1', tag: 'zk gk', bnc: '208', frq: '202', exchange: 'p:ran/i:running' });
    const parsed = parseEcdictLine(line);
    expect(parsed?.word).toBe('run');
    expect(parsed?.definition).toBe('a, b, c');
  });

  it('字段内的双引号转义（""）还原成一个引号', () => {
    const line = csvRow({ word: 'say', definition: '"say ""hi"""' });
    const parsed = parseEcdictLine(line);
    expect(parsed?.definition).toBe('say "hi"');
  });

  it('字面 \\n（两字符）保留原样，不当成换行切行', () => {
    const line = csvRow({ word: 'water', definition: '\\n', translation: '\\n' });
    const parsed = parseEcdictLine(line);
    expect(parsed?.definition).toBe('\\n');
    expect(parsed?.translation).toBe('\\n');
  });

  it('字段数不是 13 时返回 null（交给上层计入 skipped）', () => {
    expect(parseEcdictLine('only,two')).toBeNull();
  });
});

describe('parseEcdictRows（A3 坏行不中断）', () => {
  it('好行照收，坏行计入 skipped，不抛错', () => {
    const text = csv(
      csvRow({ word: 'alpha', translation: 'n. 阿尔法' }),
      'broken,line',
      csvRow({ word: 'beta', translation: 'n. 贝塔' }),
    );
    const result = parseEcdictRows(text);
    expect(result.rows.map((r) => r.word)).toEqual(['alpha', 'beta']);
    expect(result.skipped).toBe(1);
  });

  it('表头不符时整体拒绝，一行都不收', () => {
    const text = ['wrong,header', csvRow({ word: 'a', translation: 'x' })].join('\r\n');
    const result = parseEcdictRows(text);
    expect(result.rows).toHaveLength(0);
    expect(result.headerOk).toBe(false);
  });

  it('空行被忽略而不是计为坏行', () => {
    const text = csv(csvRow({ word: 'alpha', translation: 'n. 阿尔法' }), '', csvRow({ word: 'beta', translation: 'n. 贝塔' }));
    const result = parseEcdictRows(text);
    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });
});

describe('isStandardTier（A4 标准档判据）', () => {
  it('8 个考试标签任一非空即属标准档', () => {
    expect(ECDICT_STANDARD_TAGS).toEqual(['zk', 'gk', 'ky', 'cet4', 'cet6', 'toefl', 'ielts', 'gre']);
    for (const tag of ECDICT_STANDARD_TAGS) {
      expect(isStandardTier(tag)).toBe(true);
    }
  });

  it('空标签或未知标签不属标准档', () => {
    expect(isStandardTier('')).toBe(false);
    expect(isStandardTier('unknown-tag')).toBe(false);
  });

  it('多标签时任一命中即可', () => {
    expect(isStandardTier('cet6 toefl gre')).toBe(true);
    expect(isStandardTier('custom')).toBe(false);
  });
});

describe('mapRowToWord（A2/A5 映射口径）', () => {
  const constraintRow = parseEcdictLine(
    csvRow({
      word: 'constraint',
      phonetic: "kәn'streint",
      translation: '"n. 强制, 约束\\n[计] 约束"',
      collins: '2',
      tag: 'cet6 toefl gre',
      bnc: '2988',
      frq: '4643',
      exchange: 's:constraints',
    }),
  )!;

  it('translation 拆成 defZh 多行，来源标 imported（FR-B7a / FR-B10）', () => {
    const word = mapRowToWord(constraintRow);
    expect(word.defZh).toEqual(['n. 强制, 约束', '[计] 约束']);
    expect(word.defSrc).toBe('imported');
    expect(word.fallbackDef).toEqual([]);
  });

  it('音标原样保留并标 imported（FR-B7a：ECDICT 不是 IPA，不得伪装）', () => {
    const word = mapRowToWord(constraintRow);
    expect(word.phoneticUs).toBe("kәn'streint");
    expect(word.phoneticSrc).toBe('imported');
  });

  it('tag 拆成 examTags；bnc / frq 0 视为无排名但仍是数字', () => {
    const word = mapRowToWord(constraintRow);
    expect(word.examTags).toEqual(['cet6', 'toefl', 'gre']);
    expect(word.freqBnc).toBe(2988);
    expect(word.freqCoca).toBe(4643);
  });

  it('exchange 原样带出（FR-B7b 用它建变形索引）', () => {
    expect(mapRowToWord(constraintRow).exchange).toBe('s:constraints');
  });

  it('pos 列全空时从 translation 前缀识别词性', () => {
    expect(mapRowToWord(constraintRow).pos).toEqual(['n.']);
  });

  it('没有音标的行 phoneticSrc 为 null（FR-B9：有音标才必须有来源）', () => {
    const bare = parseEcdictLine(csvRow({ word: 'ghost', translation: '幽灵' }))!;
    const word = mapRowToWord(bare);
    expect(word.phoneticUs).toBe('');
    expect(word.phoneticSrc).toBeNull();
  });

  it('大写词条保留原样，但 lemma 归一为小写便于查询', () => {
    const upper = parseEcdictLine(csvRow({ word: 'PC', translation: '个人电脑' }))!;
    const word = mapRowToWord(upper);
    expect(word.lemma).toBe('pc');
    expect(word.surface).toBe('PC');
  });
});
