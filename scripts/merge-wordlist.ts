/**
 * 把新词的批次合并进 `data/core-words.tsv`（PLAN.md FR-B1，M1-9）。
 *
 *   node scripts/merge-wordlist.ts .local/corpus/batch-01.tsv .local/corpus/batch-02.tsv
 *   node scripts/merge-wordlist.ts .local/corpus/batch-01.tsv --dry
 *
 * ## 为什么不手工编辑那份 TSV
 *
 * `data/core-words.tsv` 是**人工逐条 review 的源文件**（`decisions/0002`），
 * 因此格式必须稳定：全 LF、5 列、按字节序升序、无重复、无大写。
 * 人工插入 1000 行必然会破坏其中某一条（顺序、列数、重音符号），而
 * 破坏之后 `build-dict.ts --check` 的漂移门禁只会报"产物对不上"，
 * 不会告诉你哪一行写坏了。所以插入也交给脚本，规则写在代码里、有用例。
 *
 * ## 输入批次的格式
 *
 * 每行 `lemma<TAB>pos<TAB>defZh`：
 * - `phoneticUs` / `phoneticUk` 两列**留空**——它们由 `scripts/build-phonetics.ts`
 *   从 CMUdict 派生后写回（音标是**生成列**，不进人工 review 环节）；
 * - `defZh` 用全角 `；` 分隔多个义项（与现有 920 条一致）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 现有词表用到的词性取值（新增值必须先改这里，避免拼出 `noun` 这类不一致的写法） */
export const POS_VALUES = ['n.', 'v.', 'adj.', 'adv.', 'pron.', 'prep.', 'conj.', 'num.', 'art.', 'int.'] as const;

export interface WordRow {
  lemma: string;
  phoneticUs: string;
  phoneticUk: string;
  pos: string;
  defZh: string;
}

export interface MergeResult {
  /** 合并后的完整 TSV 文本 */
  tsv: string;
  added: WordRow[];
  /** 跳过的行（已存在 / 重复 / 校验不过），带原因 */
  skipped: Array<{ line: string; reason: string }>;
  total: number;
}

/** 解析现有词表；列数不对就报错（宁可停，也不要悄悄写坏） */
export function parseCoreTsv(text: string): WordRow[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const header = lines.shift();
  if (header !== 'lemma\tphoneticUs\tphoneticUk\tpos\tdefZh') {
    throw new Error(`表头不符，拒绝继续：${JSON.stringify(header)}`);
  }

  return lines.map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error(`第 ${index + 2} 行列数不是 5`);
    const [lemma = '', phoneticUs = '', phoneticUk = '', pos = '', defZh = ''] = fields;
    return { lemma, phoneticUs, phoneticUk, pos, defZh };
  });
}

/** 解析一个新增批次（`lemma\tpos\tdefZh`） */
export function parseBatch(text: string): Array<Omit<WordRow, 'phoneticUs' | 'phoneticUk'>> {
  const out: Array<Omit<WordRow, 'phoneticUs' | 'phoneticUk'>> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line === '' || line.startsWith('#')) continue;
    const [lemma = '', pos = '', defZh = ''] = line.split('\t');
    out.push({ lemma: lemma.trim(), pos: pos.trim(), defZh: defZh.trim() });
  }
  return out;
}

const LEMMA_PATTERN = /^[a-z][a-z'’-]*$/;

/** 一行新词是否合法；合法返回 null，否则返回原因 */
export function validateRow(row: Omit<WordRow, 'phoneticUs' | 'phoneticUk'>): string | null {
  if (!LEMMA_PATTERN.test(row.lemma)) return 'lemma 必须是纯小写英文（允许词内撇号/连字符）';
  if (!(POS_VALUES as readonly string[]).includes(row.pos)) return `词性取值非法：${row.pos || '(空)'}`;
  if (row.defZh === '') return '释义不能为空';
  if (row.defZh.includes('\t')) return '释义里不能有制表符';
  if (!/[\u4e00-\u9fff]/.test(row.defZh)) return '释义里没有中文（是不是把英文填进来了？）';
  return null;
}

export function mergeWordlist(
  existing: readonly WordRow[],
  incoming: ReadonlyArray<Omit<WordRow, 'phoneticUs' | 'phoneticUk'>>,
): MergeResult {
  const known = new Set(existing.map((row) => row.lemma));
  const added: WordRow[] = [];
  const skipped: Array<{ line: string; reason: string }> = [];

  for (const row of incoming) {
    const problem = validateRow(row);
    if (problem !== null) {
      skipped.push({ line: `${row.lemma}\t${row.pos}\t${row.defZh}`, reason: problem });
      continue;
    }
    if (known.has(row.lemma)) {
      skipped.push({ line: `${row.lemma}\t${row.pos}\t${row.defZh}`, reason: '词表里已有' });
      continue;
    }
    known.add(row.lemma);
    added.push({ lemma: row.lemma, phoneticUs: '', phoneticUk: '', pos: row.pos, defZh: row.defZh });
  }

  const all = [...existing, ...added].sort((a, b) => (a.lemma < b.lemma ? -1 : a.lemma > b.lemma ? 1 : 0));
  const tsv =
    'lemma\tphoneticUs\tphoneticUk\tpos\tdefZh\n' +
    all.map((row) => [row.lemma, row.phoneticUs, row.phoneticUk, row.pos, row.defZh].join('\t')).join('\n') +
    '\n';

  return { tsv, added, skipped, total: all.length };
}

function main(): void {
  const argv = process.argv;
  const dryRun = argv.includes('--dry');
  const coreIndex = argv.indexOf('--core');
  const corePath = coreIndex >= 0 ? (argv[coreIndex + 1] ?? '') : `${ROOT}data/core-words.tsv`;
  const batches = argv.slice(2).filter((arg) => !arg.startsWith('--') && arg !== corePath);

  if (batches.length === 0) {
    console.error('用法：node scripts/merge-wordlist.ts <批次.tsv> [...] [--core <path>] [--dry]');
    process.exit(2);
  }

  const coreText = readFileSync(corePath, 'utf8');
  const existing = parseCoreTsv(coreText);

  const incoming = batches.flatMap((path) => {
    if (!existsSync(path)) {
      console.error(`批次文件不存在：${path}`);
      process.exit(2);
    }
    console.log(`读入 ${path}`);
    return parseBatch(readFileSync(path, 'utf8'));
  });

  const result = mergeWordlist(existing, incoming);

  if (!dryRun && result.added.length > 0) {
    writeFileSync(corePath, result.tsv, 'utf8');
  }

  console.log(
    JSON.stringify(
      {
        core: corePath,
        before: existing.length,
        after: result.total,
        added: result.added.length,
        skipped: result.skipped.length,
        wrote: !dryRun && result.added.length > 0,
        sampleAdded: result.added.slice(0, 10).map((row) => `${row.lemma} ${row.pos} ${row.defZh}`),
        skippedDetail: result.skipped.slice(0, 20),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1]?.includes('merge-wordlist')) {
  try {
    main();
  } catch (error) {
    console.error('合并失败：', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
