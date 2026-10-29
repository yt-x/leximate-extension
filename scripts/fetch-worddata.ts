/**
 * 从 Wikidata Lexeme（CC0）拉取"构词数据"：屈折形式 + 词性类别。
 *
 *   node scripts/fetch-worddata.ts --from-freq .local/corpus/freq.tsv --top 5000
 *   node scripts/fetch-worddata.ts --input .local/corpus/words.txt
 *
 * ## 这个脚本与 `fetch-inflections.ts` 的分工
 *
 * | 脚本 | 输入 | 产物 | 用途 |
 * |---|---|---|---|
 * | `fetch-inflections.ts` | `data/core-words.tsv`（**最终词表**） | `data/inflections/wikidata-forms.tsv`（**钉版入仓**） | 运行时的词形还原（FR-B3） |
 * | 本脚本 | 语料词频表（**工作数据**） | `.local/corpus/wikidata-*.tsv`（**不入库**） | 统计阶段把屈折归并到原形、并给候选词取词性 |
 *
 * 两者都用同一套查询形状（`wikibase:lemma` 命中，**不能**按 `rdf:type` 过滤，
 * 见 `docs/reference/wikidata-lexemes.md` §2）。分开是因为工作产物会随语料变，
 * 而钉版产物只在词表定稿时重算一次。
 *
 * 批大小**自适应**：WDQS 对复杂批次会超时或 429，失败就把这一批对半拆开重试，
 * 一路拆到单个词为止——比"固定批大小 + 整体重试"更能在公共端点上跑完。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'Leximate/0.1 (offline vocabulary notebook; worddata build)';

const DEFAULT_BATCH = 50;
const BATCH_DELAY_MS = 600;
const MAX_RETRIES_PER_BATCH = 3;

export interface LexemeRow {
  lemma: string;
  form: string;
  features: string[];
}

export interface FetchResult {
  forms: LexemeRow[];
  /** lemma → 词性类别的 QID（如 Q1084 = noun） */
  categories: Map<string, string>;
  /** 一个 lexeme 都没命中的词 */
  missing: string[];
  /** 拆到单个词仍失败的词 */
  failed: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sparql(query: string): Promise<unknown> {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

/**
 * 一批词的查询。
 *
 * 两个 OPTIONAL 挂在不同层级（`?form` 在 lexeme 下、`?cat` 也在 lexeme 下），
 * 组合起来可能产生少量重复行，交给调用方去重。
 */
async function fetchBatch(words: readonly string[]): Promise<{
  forms: LexemeRow[];
  categories: Map<string, string>;
}> {
  const values = words.map((word) => `"${word}"@en`).join(' ');
  const query = `
SELECT ?lemma ?rep ?feat ?cat WHERE {
  VALUES ?lemma { ${values} }
  ?lexeme wikibase:lemma ?lemma.
  OPTIONAL { ?lexeme wikibase:lexicalCategory ?cat. }
  OPTIONAL {
    ?lexeme ontolex:lexicalForm ?form.
    ?form ontolex:representation ?rep.
    FILTER(lang(?rep) = "en")
    OPTIONAL { ?form wikibase:grammaticalFeature ?feat. }
  }
}`;

  const json = (await sparql(query)) as {
    results: {
      bindings: Array<{
        lemma: { value: string };
        rep?: { value: string };
        feat?: { value: string };
        cat?: { value: string };
      }>;
    };
  };

  const byKey = new Map<string, LexemeRow>();
  const categories = new Map<string, string>();

  for (const binding of json.results.bindings) {
    const lemma = binding.lemma.value;
    if (binding.cat?.value) {
      const qid = binding.cat.value.split('/').pop() ?? '';
      if (qid) categories.set(lemma, qid);
    }
    if (!binding.rep?.value) continue;

    const form = binding.rep.value;
    const key = `${lemma}\t${form}`;
    const row = byKey.get(key) ?? { lemma, form, features: [] };
    if (binding.feat?.value) {
      const qid = binding.feat.value.split('/').pop() ?? '';
      if (qid && !row.features.includes(qid)) row.features.push(qid);
    }
    byKey.set(key, row);
  }

  return { forms: [...byKey.values()], categories };
}

/** 带自适应拆批的取数 */
async function fetchAdaptive(words: readonly string[], result: FetchResult): Promise<void> {
  if (words.length === 0) return;

  for (let attempt = 1; attempt <= MAX_RETRIES_PER_BATCH; attempt += 1) {
    try {
      const { forms, categories } = await fetchBatch(words);
      if (forms.length === 0 && categories.size === 0) {
        for (const word of words) result.missing.push(word);
        return;
      }
      result.forms.push(...forms);
      for (const [lemma, qid] of categories) result.categories.set(lemma, qid);
      const hit = new Set<string>([...forms.map((row) => row.lemma), ...categories.keys()]);
      for (const word of words) if (!hit.has(word)) result.missing.push(word);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_RETRIES_PER_BATCH) {
        if (words.length === 1) {
          result.failed.push(words[0] as string);
          console.error(`  [fail] ${words[0]}：${message}`);
          return;
        }
        // 拆半重试：公共端点上大批量容易超时，拆开通常就能过
        const mid = Math.ceil(words.length / 2);
        console.error(`  [split] ${words.length} 词拆成 ${mid}+${words.length - mid}（${message.slice(0, 80)}）`);
        await fetchAdaptive(words.slice(0, mid), result);
        await fetchAdaptive(words.slice(mid), result);
        return;
      }
      await sleep(1500 * attempt);
    }
  }
}

function readWordsFromFreq(path: string, top: number): string[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(1);
  const words: string[] = [];
  for (const line of lines) {
    if (words.length >= top) break;
    const form = line.split('\t')[0];
    const word = form?.trim();
    if (word) words.push(word);
  }
  return words;
}

function readWordsFromFile(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

async function main(): Promise<void> {
  const argv = process.argv;
  const dryRun = argv.includes('--dry');
  const fromFreqIndex = argv.indexOf('--from-freq');
  const inputIndex = argv.indexOf('--input');
  const topIndex = argv.indexOf('--top');
  const batchIndex = argv.indexOf('--batch');
  const outFormsIndex = argv.indexOf('--out-forms');
  const outCatIndex = argv.indexOf('--out-categories');

  const top = topIndex >= 0 ? Number(argv[topIndex + 1] ?? 5000) : 5000;
  const batchSize = batchIndex >= 0 ? Number(argv[batchIndex + 1] ?? DEFAULT_BATCH) : DEFAULT_BATCH;

  const words =
    fromFreqIndex >= 0
      ? readWordsFromFreq(argv[fromFreqIndex + 1] ?? `${ROOT}.local/corpus/freq.tsv`, top)
      : inputIndex >= 0
        ? readWordsFromFile(argv[inputIndex + 1] ?? '')
        : [];

  if (words.length === 0) {
    console.error('没有输入词。用 --from-freq <freq.tsv> --top N 或 --input <每行一个词的文件>。');
    process.exit(2);
  }

  const outForms = outFormsIndex >= 0 ? (argv[outFormsIndex + 1] ?? '') : `${ROOT}.local/corpus/wikidata-forms.tsv`;
  const outCategories =
    outCatIndex >= 0 ? (argv[outCatIndex + 1] ?? '') : `${ROOT}.local/corpus/wikidata-categories.tsv`;

  const batches = Math.ceil(words.length / batchSize);
  console.log(`输入 ${words.length} 个词形，批大小 ${batchSize}，共 ${batches} 批`);
  if (dryRun) {
    console.log(`[dry] 产物：${outForms} / ${outCategories}`);
    return;
  }

  const result: FetchResult = { forms: [], categories: new Map(), missing: [], failed: [] };
  const started = Date.now();

  for (let index = 0; index < words.length; index += batchSize) {
    const batch = words.slice(index, index + batchSize);
    const batchNo = Math.floor(index / batchSize) + 1;
    await fetchAdaptive(batch, result);
    if (batchNo % 10 === 0 || batchNo === batches) {
      console.log(
        `  [${batchNo}/${batches}] 累计 form 行 ${result.forms.length}，命中 lexeme ${result.categories.size}，` +
          `无命中 ${result.missing.length}，失败 ${result.failed.length}（${((Date.now() - started) / 1000).toFixed(0)}s）`,
      );
    }
    await sleep(BATCH_DELAY_MS);
  }

  // 去重 + 稳定排序：重算要逐字节可复现
  const formRows = new Map<string, LexemeRow>();
  for (const row of result.forms) {
    const key = `${row.lemma}\t${row.form}`;
    const existing = formRows.get(key) ?? row;
    existing.features = [...new Set([...existing.features, ...row.features])].sort();
    formRows.set(key, existing);
  }
  const forms = [...formRows.values()].sort(
    (a, b) => a.lemma.localeCompare(b.lemma) || a.form.localeCompare(b.form),
  );

  mkdirSync(`${ROOT}.local/corpus`, { recursive: true });
  writeFileSync(
    outForms,
    `lemma\tform\tfeatures\n${forms.map((row) => [row.lemma, row.form, row.features.join(',')].join('\t')).join('\n')}\n`,
    'utf8',
  );
  const categoryRows = [...result.categories.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  writeFileSync(
    outCategories,
    `lemma\tcategory\n${categoryRows.map(([lemma, qid]) => `${lemma}\t${qid}`).join('\n')}\n`,
    'utf8',
  );

  console.log(
    JSON.stringify(
      {
        source: 'Wikidata Lexeme (CC0)',
        inputWords: words.length,
        formRows: forms.length,
        lemmasWithCategory: categoryRows.length,
        wordsWithNoLexeme: result.missing.length,
        failedWords: result.failed.length,
        sampleMissing: result.missing.slice(0, 15),
        sampleFailed: result.failed.slice(0, 5),
        outForms,
        outCategories,
        elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1]?.includes('fetch-worddata')) {
  main().catch((error) => {
    console.error('取数失败：', error);
    process.exit(1);
  });
}
