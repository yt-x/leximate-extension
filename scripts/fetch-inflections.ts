/**
 * 从 Wikidata Lexeme（CC0）拉取英文屈折，生成**钉版入仓**的原始产物。
 *
 *   node scripts/fetch-inflections.ts           拉取并写入
 *   node scripts/fetch-inflections.ts --dry-run 只报告，不写盘
 *
 * ⚠️ 查询形状是实测踩出来的（见 docs/reference/wikidata-lexemes.md §2）：
 *   `?l a ontolex:Lexeme` 在 WDQS 上**返回 0 行**，必须先用 `wikibase:lemma` 命中 lexeme，
 *   再顺 `ontolex:lexicalForm` 取 forms。用 rdf:type 过滤会得到"覆盖率 0%"的假结论。
 *
 * 产物 `data/pronunciation/../inflections/wikidata-forms.tsv` 是**原始拉取结果**，入仓钉版；
 * 它经过 `utils/dict/inflections.ts` 的过滤后才成为 `public/dict/inflections.json`。
 * 原始产物与派生产物分开，是为了让"过滤规则改了"与"上游数据变了"两件事可分辨。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCoreTsv } from '../utils/dict/build.ts';
import { lemmaVariants } from './lemma-variants.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSV_PATH = `${ROOT}data/core-words.tsv`;
const OUT_PATH = `${ROOT}data/inflections/wikidata-forms.tsv`;

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'Leximate/0.1 (offline vocabulary notebook; inflection build)';

/** 每批多少个词。实测 20 + 1.2s 间隔在公共端点上稳定 */
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1200;

const HEADER = 'lemma\tform\tfeatures';

interface FormRow {
  lemma: string;
  form: string;
  features: string[];
}

async function sparql(query: string): Promise<unknown> {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** 公共端点的 502 / 连接抖动是常态：重试三次，退避加倍 */
const RETRY_DELAYS_MS = [2000, 5000, 12000];

async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // 429 = 限流，等待更久；其余按同一退避表
      const wait = RETRY_DELAYS_MS[attempt] ?? 0;
      if (attempt < RETRY_DELAYS_MS.length) {
        process.stdout.write(`\n    ${label} 第 ${attempt + 1} 次失败（${message.slice(0, 60)}），${wait}ms 后重试… `);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 一次取一批词的全部 form。
 *
 * `grammaticalFeature` 用 OPTIONAL：没有语法特征的 form 也要收，
 * 让下游过滤决定去留——在这里丢掉会掩盖上游数据质量问题。
 */
async function fetchForms(words: string[]): Promise<FormRow[]> {
  // 用 JSON.stringify 转义：lemma 里可能有单引号（`o'clock`）或弯引号，裸拼会破坏 SPARQL
  const values = words.map((w) => `${JSON.stringify(w)}@en`).join(' ');
  const query = `
SELECT ?lemma ?rep ?feat WHERE {
  VALUES ?lemma { ${values} }
  ?lexeme wikibase:lemma ?lemma.
  ?lexeme ontolex:lexicalForm ?form.
  ?form ontolex:representation ?rep.
  FILTER(lang(?rep) = "en")
  OPTIONAL { ?form wikibase:grammaticalFeature ?feat. }
}`;

  const json = (await sparql(query)) as {
    results: { bindings: Array<{ lemma: { value: string }; rep: { value: string }; feat?: { value: string } }> };
  };

  const byKey = new Map<string, FormRow>();
  for (const b of json.results.bindings) {
    const lemma = b.lemma.value;
    const form = b.rep.value;
    const key = `${lemma}\t${form}`;
    let row = byKey.get(key);
    if (!row) {
      row = { lemma, form, features: [] };
      byKey.set(key, row);
    }
    if (b.feat?.value) {
      // 存 QID 而非标签：标签随界面语言变，QID 是稳定的
      const qid = b.feat.value.split('/').pop() ?? '';
      if (qid && !row.features.includes(qid)) row.features.push(qid);
    }
  }
  return [...byKey.values()];
}

function serialize(rows: FormRow[]): string {
  const body = rows
    .map((r) => [r.lemma, r.form, r.features.sort().join(',')].join('\t'))
    .join('\n');
  return `${HEADER}\n${body}\n`;
}

function parseSerialized(text: string): FormRow[] {
  const out: FormRow[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [lemma = '', form = '', features = ''] = line.split('\t');
    out.push({ lemma, form, features: features ? features.split(',').filter(Boolean) : [] });
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const { entries, errors } = parseCoreTsv(readFileSync(TSV_PATH, 'utf8'));
  if (errors.length > 0) {
    console.error('核心词表有错，先修词表：', errors.slice(0, 5));
    process.exit(1);
  }

  const lemmas = entries.map((e) => e.lemma).sort();
  console.log(`核心词表 ${lemmas.length} 词，开始拉取 Wikidata Lexeme…`);

  const collected = new Map<string, FormRow>();
  const noLemma: string[] = [];
  const failures: Array<{ batch: string[]; error: string }> = [];

  for (let i = 0; i < lemmas.length; i += BATCH_SIZE) {
    const batch = lemmas.slice(i, i + BATCH_SIZE);
    const batchNo = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(lemmas.length / BATCH_SIZE);
    process.stdout.write(`  [${batchNo}/${total}] ${batch.length} 词 … `);
    try {
      const rows = await withRetry('第一批', () => fetchForms(batch));
      for (const r of rows) collected.set(`${r.lemma}\t${r.form}`, r);
      const hit = new Set(rows.map((r) => r.lemma));
      for (const w of batch) if (!hit.has(w)) noLemma.push(w);
      console.log(`${hit.size}/${batch.length} 命中`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`失败：${message}`);
      failures.push({ batch, error: message });
    }
    if (i + BATCH_SIZE < lemmas.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // ── 第二轮：对未命中的词用归一化变体重取（FR-B3a 的取数口径）──────
  // 实测：61 个缺口里 33 个是"取数键不匹配"（`american` vs `American`、
  // `favor` vs `favour`、`o'clock` vs `o’clock`），不是 Wikidata 没收录。
  if (noLemma.length > 0) {
    console.log(`\n第二轮：${noLemma.length} 个未命中的词按变体重取…`);
    const stillMissing: string[] = [];
    for (let i = 0; i < noLemma.length; i += BATCH_SIZE) {
      const batch = noLemma.slice(i, i + BATCH_SIZE);
      const batchNo = Math.floor(i / BATCH_SIZE) + 1;
      const total = Math.ceil(noLemma.length / BATCH_SIZE);
      // 每个词展开成变体，一并查；回来后按 lemma 归到原词
      const variantToWord = new Map<string, string>();
      for (const word of batch) {
        for (const variant of lemmaVariants(word)) {
          variantToWord.set(variant, word);
        }
      }
      const variants = [...variantToWord.keys()];
      process.stdout.write(`  [${batchNo}/${total}] ${batch.length} 词（${variants.length} 个变体）… `);
      try {
        const rows = await withRetry('第二轮', () => fetchForms(variants));
        // 命中的行：lemma 是变体写法，把它改回我们词表里的词形，form 保留原样
        let recovered = 0;
        for (const row of rows) {
          const original = variantToWord.get(row.lemma);
          if (!original) continue;
          recovered += 1;
          collected.set(`${original}\t${row.form}`, { ...row, lemma: original });
        }
        const recoveredWords = new Set(
          rows.map((r) => variantToWord.get(r.lemma)).filter((v): v is string => Boolean(v)),
        );
        for (const word of batch) if (!recoveredWords.has(word)) stillMissing.push(word);
        console.log(`${recoveredWords.size}/${batch.length} 命中（${recovered} 行）`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`失败：${message}`);
        failures.push({ batch: variants, error: message });
        stillMissing.push(...batch);
      }
      if (i + BATCH_SIZE < noLemma.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    console.log(`第二轮补齐 ${noLemma.length - stillMissing.length} 个词，仍无词位 ${stillMissing.length} 个`);
    noLemma.length = 0;
    noLemma.push(...stillMissing);
  }

  // 排序：lemma 升序，同 lemma 内 form 升序——保证重算逐字节可复现
  const rows = [...collected.values()].sort(
    (a, b) => a.lemma.localeCompare(b.lemma) || a.form.localeCompare(b.form),
  );
  const next = serialize(rows);

  const summary = {
    source: 'Wikidata Lexeme (CC0)',
    target: 'data/inflections/wikidata-forms.tsv',
    coreWords: lemmas.length,
    rows: rows.length,
    wordsWithForms: new Set(rows.map((r) => r.lemma)).size,
    wordsWithoutLexeme: noLemma.length,
    failedBatches: failures.length,
    sample: {
      noLemma: noLemma.slice(0, 15),
      failures: failures.slice(0, 3).map((f) => f.error),
    },
  };

  if (failures.length > 0) {
    // 有批次失败就不写盘：半个产物比没有产物更危险
    console.log(JSON.stringify({ ...summary, wrote: false, reason: '有批次失败，拒绝写盘' }, null, 2));
    process.exit(1);
  }

  mkdirSync(`${ROOT}data/inflections`, { recursive: true });
  const current = (() => {
    try {
      return readFileSync(OUT_PATH, 'utf8');
    } catch {
      return null;
    }
  })();

  const identical = current === next;
  // 先按规范化解析再比：换行符差异不该算漂移
  const semanticSame =
    current !== null && JSON.stringify(parseSerialized(current)) === JSON.stringify(rows);

  if (!dryRun && !semanticSame) writeFileSync(OUT_PATH, next, 'utf8');

  console.log(
    JSON.stringify(
      {
        ...summary,
        wrote: !dryRun && !semanticSame,
        drift: semanticSame ? 0 : 1,
        byteIdentical: identical,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('拉取失败：', err);
  process.exit(1);
});
