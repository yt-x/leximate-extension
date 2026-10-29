/**
 * 语料词频统计（PLAN.md FR-B8、M1-9）。
 *
 *   node scripts/count-corpus.ts                    统计默认语料目录
 *   node scripts/count-corpus.ts <dir> [--top N]    指定目录 / 打印前 N
 *   node scripts/count-corpus.ts <dir> --out <file> 指定中间产物路径
 *
 * ## 为什么这个脚本入库、而语料不入库
 *
 * FR-B8 的原话是"仓库只提交**我们算出的词表 + 统计脚本 + 语料引用**，语料本体与任何
 * 文本片段都不入库"。因此：
 * - **本脚本入库**（它是"我们怎么算的"这部分）；
 * - **语料与词频中间产物不入库**（默认写到 `.local/`，该目录已被 gitignore）；
 * - 最终入库的只有 `data/core-words.tsv` 里那份**词表**（词 + 自撰释义 + 音标），
 *   它不含任何语料文本片段。
 *
 * ## 统计口径（必须写清楚，否则"可复现"是空话）
 *
 * 1. **词形**：取"字母开头、内部允许撇号与连字符"的连续串（`don't` / `well-known`
 *    都算一个词），**全部转小写**。正则本身在下面的 `TOKEN` 常量里。
 * 2. 含数字的串不算（`1994` / `3rd` 不是我们要教的词）。
 * 3. **不做词形还原**：这一步只负责"数词形"。把 `running` 归到 `run` 是
 *    `scripts/build-wordlist.ts` 的事（它用 Wikidata 的 forms），分开是为了让
 *    "计数口径改了"与"还原规则改了"两件事可分辨。
 * 4. 语料的 `@` 开头的元数据行、以及尖括号标记整体跳过（OANC 的明文包带这类头）。
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 一个词形：字母开头，内部允许撇号与连字符 */
const TOKEN = /[\p{L}][\p{L}'’-]*/gu;

/**
 * XML 里常见的实体。
 *
 * BNC 是 XML 语料（`<w c5="AJ0">quick</w>`），剥标签之后会剩下 `&amp;` 这类实体。
 * 不处理的话 `amp` / `nbsp` 会被当成词——它们在词频表里排得不低，足以污染入选边界。
 */
const ENTITIES: Record<string, string> = {
  '&amp;': ' and ',
  '&lt;': ' ',
  '&gt;': ' ',
  '&quot;': ' ',
  '&apos;': "'",
  '&nbsp;': ' ',
};

export interface CountOptions {
  /** 语料根目录 */
  dir: string;
  /** 需要跳过的文件（语料包里的说明文件） */
  skipExtensions?: string[];
}

/** 递归列出目录下的文本文件 */
export function listCorpusFiles(dir: string, skip = ['.pdf', '.png', '.jpg', '.zip', '.gz']): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...listCorpusFiles(full, skip));
      continue;
    }
    if (skip.some((ext) => name.toLowerCase().endsWith(ext))) continue;
    out.push(full);
  }
  return out;
}

/**
 * 把一个词形归一成计数键。
 *
 * 只做小写与"两端撇号/连字符"的清理：`'cause'` 与 `cause` 是同一个词，
 * 但 `don't` 中间的撇号要保留（它是词的一部分）。
 */
export function normalizeToken(raw: string): string | null {
  const token = raw
    .toLowerCase()
    .replace(/^['’-]+/, '')
    .replace(/['’-]+$/, '');
  if (token.length < 1) return null;
  // 纯字母（含词内撇号/连字符）才算：`don't` 可以，`a1` 不行
  if (!/^[\p{L}][\p{L}'’-]*$/u.test(token)) return null;
  if (/[0-9]/.test(token)) return null;
  return token;
}

/**
 * 把一行语料文本洗成"可数词形"的序列。
 *
 * 顺序有讲究：
 * 1. 剥 XML 标签（BNC 是 `<w c5="AJ0">quick</w>` 形态；标签里的属性值也会被一起剥掉）；
 * 2. 换实体（`&amp;` → `and`，其余多数变空格）；
 * 3. 剩下的裸 `&...;` 清掉（未知实体不该变成词）；
 * 4. 按正则取词形。
 */
export function tokensOf(line: string): string[] {
  let text = line.replace(/<[^>]*>/g, ' ');
  for (const [entity, replacement] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(replacement);
  }
  text = text.replace(/&[a-zA-Z#0-9]+;/g, ' ');

  const out: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const token = normalizeToken(match[0]);
    if (token !== null) out.push(token);
  }
  return out;
}

/**
 * BNC 的 `c5` 词性标签里**默认排除**的几类。
 *
 * 依据（实测的标签分布，见变更记录）：
 * - `NP0` 专有名词：`Guy` / `Brett` / `America`——人名地名不是要教的词；
 * - `PUN` 标点（BNC 多数标点走 `<c>` 元素，但 `<w>` 里也有）；
 * - `UNC` 无法判定、`ZZ0` 字母符号：`x` / `k` 这类。
 *
 * ⚠️ **不排除** `XX0`（`not` / `n't` 所在类）：`not` 是正经的常用词，
 * 现有的 920 词表里就有它。切分残留靠下面的 `CLITIC_RESIDUE` 单独处理。
 */
export const DEFAULT_EXCLUDED_POS = ['NP0', 'PUN', 'UNC', 'ZZ0'] as const;

/**
 * 切分残留：BNC 把缩写拆成独立 token（`it` + `'s`、`do` + `n't`），
 * 去掉撇号之后它们长得像单词，但**不是单词**。
 *
 * 实测它们在词频表里排得很前（`s` 排第 11、`n't` 排第 17），
 * 不剔掉就会挤进候选词表，还会骗过"覆盖率"这类健康度指标。
 */
export const CLITIC_RESIDUE = new Set(["n't", 'nt', 're', 've', 'll', 'em']);

/** 单个字母里只有这两个是真词（不定冠词与第一人称） */
const REAL_SINGLE_LETTERS = new Set(['a', 'i']);

/** 这个词形算不算"要教的词" */
export function isCountable(form: string): boolean {
  if (CLITIC_RESIDUE.has(form)) return false;
  if ([...form].length === 1 && !REAL_SINGLE_LETTERS.has(form)) return false;
  return true;
}

/**
 * 这些标签**不按 `hw` 归并**：代词 / 限定词 / 冠词 / 数词。
 *
 * 实测（2026-10-16）BNC 的 `hw` 把**格与所有格**也并到主格上：
 * `me/him/them/us → I/he/they/we`、`my/your/its → I/you/it`。
 * 对屈折（`said → say`、`days → day`）这是对的，对代词是**过度归并**——
 * 学习者的词表里 `I / me / my` 必须是三条。因此按词性把这类挡掉。
 */
export const NO_MERGE_TAGS = new Set([
  'PNP', 'PNX', 'PNQ', 'PNI',
  'DPS', 'DT0', 'DTQ',
  'AT0',
  'CRD', 'ORD',
]);

/**
 * 这条标签该不该整条排除。
 *
 * BNC 对"疑似"的词会给**复合标签**（`NP0-NN1` = 专有名词还是普通名词说不准、
 * `NN1-VVB` = 名词还是动词说不准）。实测按整串比对会漏掉它们：
 * `NP0-NN1` 不等于 `NP0`，于是 `elinor` 这种人名会带着 `n.` 混进候选词表。
 *
 * 规则：**复合标签里只要有一个成分属于被排除的类，就整条排除**。
 * 于是 `NN1-VVB`（都是实词类）保留，`NP0-NN1` / `NN1-NP0` 排除。
 */
export function isExcludedTag(tag: string, excluded: ReadonlySet<string>): boolean {
  return tag
    .split('-')
    .some((part) => excluded.has(part));
}

export interface WordElement {
  /** 语料里的表层词形（`running`） */
  form: string;
  /** BNC 的 `c5` 词性标签；没有标签时为 null */
  pos: string | null;
  /**
   * BNC 的 `hw`（head word，词元）。**实测它只做屈折归并、不做派生归并**：
   * `running/runs/ran → run`、`children → child`、`said → say`、`ca → can`、`n't → not`；
   * 而 `runner / quickly / happiness / writer` 保持自身。所以可以直接当词元用，
   * 不必自己写词形还原规则（也就不会把派生词错误地并进词根）。
   *
   * ⚠️ 代词/限定词的 `hw` 会把格与所有格并到主格（`me → I`），由 `NO_MERGE_TAGS` 挡掉。
   */
  lemma: string;
}

/** 从一行里取出所有 `<w>` 元素（表层词形 + 词性标签 + 词元） */
export function wordElementsOf(line: string): WordElement[] {
  const out: WordElement[] = [];
  for (const match of line.matchAll(/<w\s([^>]*)>([^<]*)<\/w>/g)) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const tag = /c5="([^"]+)"/.exec(attrs)?.[1] ?? null;
    const headWord = /hw="([^"]*)"/.exec(attrs)?.[1] ?? '';
    for (const token of tokensOf(inner)) {
      out.push({ form: token, pos: tag, lemma: tokensOf(headWord)[0] ?? token });
    }
  }
  return out;
}

/** 一个词元的累计统计：总次数 + 各词性标签次数 + 见过哪些表层词形 */
export interface FormStats {
  count: number;
  tags: Map<string, number>;
  surfaces: Set<string>;
}

export interface FileCountOptions {
  /** 需要排除的 BNC 词性标签 */
  excludePos?: readonly string[];
  /** 是否按 `hw`（词元）聚合；false 则按表层词形聚合 */
  useLemma?: boolean;
}

/**
 * 统计一个文件的词频，累加到 `counts`。
 *
 * **优先按 BNC 的 `<w>` 元素计数**（能拿到词性标签、按标签过滤、并按 `hw` 词元聚合）；
 * 文件里没有 `<w>`（例如 OANC 那种纯文本包）时退回逐行取词，
 * 这样同一个脚本对两类语料都能用，不必维护两套。
 */
export async function countFile(
  file: string,
  counts: Map<string, FormStats>,
  options: FileCountOptions = {},
): Promise<number> {
  const excluded = new Set(options.excludePos ?? DEFAULT_EXCLUDED_POS);
  const useLemma = options.useLemma ?? true;
  const content = readFileSync(file, 'utf8');

  if (content.includes('<w ')) {
    let tokens = 0;
    for (const element of wordElementsOf(content)) {
      if (element.pos !== null && isExcludedTag(element.pos, excluded)) continue;

      /**
       * 什么时候按 `hw` 归并：
       * - 词元与表层不同（相同就无所谓）；
       * - 词元自己是个可数的词（`ca → can` 里的 `can` 是词）；
       * - 不是代词/限定词/冠词/数词（见 `NO_MERGE_TAGS`）。
       *
       * 这样 `ca/wo/n't/'s` 这类**切分残留会被 BNC 自己的标注收回到词元上**
       * （`ca → can`、`n't → not`），只有 BNC 也解决不了的残留
       * （`na`、`gon`、`cos` 这类口语拼写）才留给挑选环节处理。
       */
      const mergesToLemma =
        useLemma &&
        element.lemma !== element.form &&
        isCountable(element.lemma) &&
        !(element.pos !== null && NO_MERGE_TAGS.has(element.pos));

      const key = mergesToLemma ? element.lemma : element.form;
      if (!isCountable(key)) continue;

      const stat =
        counts.get(key) ?? { count: 0, tags: new Map<string, number>(), surfaces: new Set<string>() };
      stat.count += 1;
      if (element.pos !== null) stat.tags.set(element.pos, (stat.tags.get(element.pos) ?? 0) + 1);
      stat.surfaces.add(element.form);
      counts.set(key, stat);
      tokens += 1;
    }
    return tokens;
  }

  // 纯文本路径（OANC 明文包这种）
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let tokens = 0;
  for await (const line of lines) {
    if (line.startsWith('@')) continue;
    for (const token of tokensOf(line)) {
      if (!isCountable(token)) continue;
      const stat =
        counts.get(token) ?? { count: 0, tags: new Map<string, number>(), surfaces: new Set<string>() };
      stat.count += 1;
      stat.surfaces.add(token);
      counts.set(token, stat);
      tokens += 1;
    }
  }
  return tokens;
}

/** 一个词形的主导词性标签（次数最多的那个） */
export function dominantTag(stat: FormStats): string {
  let best = '';
  let bestCount = -1;
  for (const [tag, count] of stat.tags) {
    if (count > bestCount || (count === bestCount && tag < best)) {
      best = tag;
      bestCount = count;
    }
  }
  return best;
}

function parseArgs(argv: string[]): { dir: string; out: string; top: number; excludePos: string[] } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const outIndex = argv.indexOf('--out');
  const topIndex = argv.indexOf('--top');
  const excludeIndex = argv.indexOf('--exclude-pos');
  const dir = positional[2] ?? `${ROOT}.local/corpus/bnc/download/Texts`;
  return {
    dir,
    out: outIndex >= 0 ? (argv[outIndex + 1] ?? '') : `${ROOT}.local/corpus/freq.tsv`,
    top: topIndex >= 0 ? Number(argv[topIndex + 1] ?? 50) : 50,
    excludePos:
      excludeIndex >= 0
        ? (argv[excludeIndex + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        : [...DEFAULT_EXCLUDED_POS],
  };
}

async function main(): Promise<void> {
  const { dir, out, top, excludePos } = parseArgs(process.argv);

  if (!existsSync(dir)) {
    console.error(`语料目录不存在：${dir}`);
    console.error('先从 docs/reference/bnc-acquisition.md §10 说明的位置放好语料（zip 或解压目录）。');
    process.exit(2);
  }

  const files = listCorpusFiles(dir);
  console.log(`语料目录：${relative(ROOT, dir)}（${files.length} 个文件）`);
  console.log(`排除的词性标签：${excludePos.join(', ') || '（不过滤）'}`);

  const counts = new Map<string, FormStats>();
  let tokens = 0;
  let bytes = 0;

  for (const [index, file] of files.entries()) {
    tokens += await countFile(file, counts, { excludePos });
    bytes += statSync(file).size;
    if ((index + 1) % 500 === 0 || index === files.length - 1) {
      console.log(
        `  ${index + 1}/${files.length} 文件 · ${(bytes / 1024 / 1024).toFixed(1)} MB · ` +
          `${tokens.toLocaleString('en-US')} tokens · ${counts.size.toLocaleString('en-US')} 个不同词形`,
      );
    }
  }

  const sorted = [...counts.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  );
  mkdirSync(`${ROOT}.local/corpus`, { recursive: true });
  // 词元 / 次数 / 主导词性标签 / 合并进来的表层词形数（可追溯：`said` 是被并进 `say` 的）
  writeFileSync(
    out,
    `lemma\tcount\tpos\tsurfaces\n` +
      sorted
        .map(([lemma, stat]) => `${lemma}\t${stat.count}\t${dominantTag(stat)}\t${stat.surfaces.size}`)
        .join('\n') +
      '\n',
    'utf8',
  );

  /** 前 3000 个词元覆盖了多少 token —— 判断"这份语料够不够算前 3000 高频" */
  const top3000 = sorted.slice(0, 3000).reduce((sum, [, stat]) => sum + stat.count, 0);
  const multiSurface = sorted.filter(([, stat]) => stat.surfaces.size > 1).length;

  console.log(
    JSON.stringify(
      {
        corpusDir: relative(ROOT, dir),
        files: files.length,
        megabytes: Number((bytes / 1024 / 1024).toFixed(1)),
        tokens,
        distinctLemmas: sorted.length,
        lemmasWithMultipleSurfaces: multiSurface,
        excludedPos: excludePos,
        top3000Coverage: Number((top3000 / tokens).toFixed(4)),
        out: relative(ROOT, out),
        wrote: true,
        sample: sorted.slice(0, top).map(([lemma, stat]) => `${lemma} ${stat.count} ${dominantTag(stat)}`),
      },
      null,
      2,
    ),
  );
}

// 直接运行时才执行（被 import 时不跑）
if (process.argv[1]?.includes('count-corpus')) {
  main().catch((err) => {
    console.error('统计失败：', err);
    process.exit(1);
  });
}
