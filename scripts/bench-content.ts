/**
 * M1-5 的性能实测（PLAN.md FR-A1、FR-B3d、FR-A12）。
 *
 * 用**真产物**（public/dict/ 下三个文件）跑，不是造的小词表——
 * 性能结论只有对真实数据量才算数。
 *
 * 口径按 PLAN.md §1.A 的「< 100ms 的测量方式」：
 * **同一个宏任务内**从事件入口到弹窗内容就绪的耗时，取 20 次的中位数；
 * 不含词库冷启动（那单独记为"首次可划词耗时"）。
 *
 * ⚠️ **必须经 vitest 跑，不能直接 `node` 跑**：
 * `utils/` 下的模块用的是无扩展名 import（Vite/WXT 负责解析），
 * 而 Node 的 ESM 解析器要求显式扩展名。vitest 用 Vite 的解析器，因此能跑通。
 *
 * 运行：node tools/sandbox-test.mjs run scripts/bench-content.test.ts
 * （测本体在 bench-content.test.ts 里，本文件只提供被它引用的实现）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDictLookup } from '../utils/dict/lookup';
import { createMemorySource } from '../utils/dict/source';
import { createLemmatizer } from '../utils/dict/lemmatize';
import { parseInflections, toReverseIndex } from '../utils/dict/inflections';
import { querySelection } from '../utils/content/query';
import { scanWords } from '../utils/content/scan';
import { normalizeForLookup } from '../utils/content/word';
import { groupForHighlight, DEFAULT_THEME } from '../utils/content/highlight-plan';

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** 读真产物，组装一个与生产同形的查询器 */
export async function makeRealDict() {
  const dictDir = join(process.cwd(), 'public', 'dict');
  const indexText = readFileSync(join(dictDir, 'index.json'), 'utf8');
  const parsed = JSON.parse(indexText) as { version: string; count: number; shards: Array<{ file: string }> };

  const files: Record<string, string> = { 'index.json': indexText };
  for (const shard of parsed.shards) {
    files[shard.file] = readFileSync(join(dictDir, shard.file), 'utf8');
  }

  const coldStart = performance.now();
  const artifact = parseInflections(readFileSync(join(dictDir, 'inflections.json'), 'utf8'));
  const reverse = toReverseIndex(artifact);
  const dict = createDictLookup(createMemorySource(files), {
    lemmatize: createLemmatizer(reverse, (lemma) => dict.lookup(lemma) !== undefined),
  });
  await dict.warm();
  const coldMs = performance.now() - coldStart;

  const shard = JSON.parse(files['shard-core.json']!) as { words: Record<string, unknown> };

  return {
    dict,
    artifact,
    reverse,
    index: parsed,
    words: Object.keys(shard.words),
    coldMs,
  };
}

/** 划词路径的中位数（FR-A1 / FR-B3d） */
export function benchQuery(
  dict: Awaited<ReturnType<typeof makeRealDict>>['dict'],
  samples: string[],
  rounds = 20,
): { median: number; max: number; count: number } {
  const timings: number[] = [];
  for (let i = 0; i < rounds; i++) {
    for (const word of samples) {
      const t0 = performance.now();
      querySelection(word, dict);
      timings.push(performance.now() - t0);
    }
  }
  return { median: median(timings), max: Math.max(...timings), count: samples.length };
}

/**
 * 挑出**确实会走还原**的样本。
 *
 * 必要性：直接拿 `reverse` 的 key 去筛会得到几乎空集——`inflections.json` 里的
 * surface 绝大多数**本身就在词表里**（FR-B3c 规定独立词条优先），
 * 那些词走的是 direct 路径。不筛出真正的还原样本，"经还原命中"那一行就是假的
 * （实测第一次跑只有 1 个样本，等于没测）。
 *
 * 判据：查 `querySelection` 的结果，只留 `kind === 'hit' && via === 'lemmatized'` 的。
 */
export function pickLemmatizedSamples(
  dict: Awaited<ReturnType<typeof makeRealDict>>['dict'],
  reverse: Map<string, Map<string, Set<string>>>,
  limit = 8,
): string[] {
  const out: string[] = [];
  for (const surface of reverse.keys()) {
    if (out.length >= limit) break;
    const result = querySelection(surface, dict);
    if (result.kind === 'hit' && result.hit.via === 'lemmatized') out.push(surface);
  }
  return out;
}

/** 标注扫描的中位数（FR-A12） */
/**
 * 模拟"用户生词本里的词条集合"（§4.5 P3 下发给内容脚本的那份）。
 *
 * 取真词表里每隔 4 个的一条，既保证基准里**既有命中也有未命中**
 * （两者走的分支不同：命中只查集合，未命中还要过一次词形还原），
 * 又保证可复现（不依赖随机）。
 */
export function makeUnderlineSet(words: string[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < words.length; i += 4) set.add(words[i]!.toLowerCase());
  return set;
}

/**
 * 与**生产同形**的下划线判据（`entrypoints/content.ts` 的 `underlineCount`）。
 *
 * ⚠️ 这里刻意复刻生产实现而不是抽公共函数：生产那份要注入 `dict` 与集合，
 * 抽出来会让内容脚本多一层间接；而基准与生产的"同形"由这条注释与
 * `M1-5` 的性能证据共同守住。**它一变，基准就必须跟着变**——
 * 这个文件存在的全部意义就是"量的是真跑的那条路"。
 */
export function makeUnderlineCount(
  dict: Awaited<ReturnType<typeof makeRealDict>>['dict'],
  collected: Set<string>,
): (word: string) => number | undefined {
  return (word: string) => {
    const key = normalizeForLookup(word);
    if (collected.has(key)) return 1;

    const hit = dict.lookup(word);
    return hit && collected.has(hit.entry.lemma) ? 1 : undefined;
  };
}

/**
 * 标注扫描吞吐（FR-A12）：**生产路径**——
 * `scanWords` 扫全部词形，再用下划线集合过滤。
 *
 * ⚠️ 这里曾经量的是 `scanKnownWords(text, (w) => dict.lookup(w) !== undefined)`,
 * 那是"候选按词典圈"的旧路径（它本身就是 `proof` 标不出来的根因）。
 * 基准量的必须是**生产真跑的那条**，否则性能证据保护的是一个不存在的实现。
 */
export function benchScan(
  dict: Awaited<ReturnType<typeof makeRealDict>>['dict'],
  words: string[],
  wordCount = 5000,
  rounds = 20,
): { median: number; max: number; spans: number; chars: number } {
  const text = Array.from(
    { length: wordCount },
    () => words[Math.floor(Math.random() * words.length)]!,
  ).join(' ');

  const collected = makeUnderlineSet(words);
  const underlineCount = makeUnderlineCount(dict, collected);

  const timings: number[] = [];
  let spans = 0;
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    spans = scanWords(text).filter((span) => underlineCount(span.text) !== undefined).length;
    timings.push(performance.now() - t0);
  }
  return { median: median(timings), max: Math.max(...timings), spans, chars: text.length };
}

/** 分组开销（FR-A11）：输入同样来自生产路径 */
export function benchGroup(
  dict: Awaited<ReturnType<typeof makeRealDict>>['dict'],
  text: string,
  rounds = 20,
): { median: number; spans: number } {
  const collected = new Set<string>();
  // 分组只关心"有多少个 span"，集合给足即可（分组成本与集合大小无关）
  const words = text.split(' ').filter((w) => w !== '');
  for (const w of words) collected.add(normalizeForLookup(w));
  const underlineCount = makeUnderlineCount(dict, collected);
  const spans = scanWords(text).filter((span) => underlineCount(span.text) !== undefined);

  const candidates = spans.map((span) => ({ span, status: 'new' as const, meetCount: 1 }));

  const timings: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    groupForHighlight(candidates, DEFAULT_THEME);
    timings.push(performance.now() - t0);
  }
  return { median: median(timings), spans: spans.length };
}
