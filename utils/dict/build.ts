/**
 * 核心词表的构建逻辑（纯函数，可单测）。
 *
 * 源文件是制表符分隔的 TSV，用文本而不是 JSON：词条要人写、人要 review，
 * 一行一个词、列对齐，diff 才看得懂。
 *
 * 列：lemma / phoneticUs / phoneticUk / pos / defZh
 * - `phoneticUk` **恒为空**：英式音标不在本期范围（PLAN.md §1 范围排除），空串语义是"暂无英音数据"，
 *   不是"与美音相同"
 * - `pos` 用 `,` 分隔，每个词性带点号，如 `n.,v.`
 * - `defZh` 用 `；` 分隔
 */
import type { DictEntry, DictIndex, DictShard, DictShardInfo } from './types';

export const CORE_TSV_HEADER = ['lemma', 'phoneticUs', 'phoneticUk', 'pos', 'defZh'] as const;

/** 允许的词性标签。核心词表只收这些，拼错会被构建拦下 */
export const ALLOWED_POS = [
  'n.',
  'v.',
  'adj.',
  'adv.',
  'prep.',
  'pron.',
  'conj.',
  'art.',
  'num.',
  'modal',
  'int.',
  'aux.',
] as const;

const LEMMA_RE = /^[a-z][a-z'’\- ]*$/;
const PHONETIC_RE = /^\/.+\/$/;

export interface ParseResult {
  entries: DictEntry[];
  /** 会让构建失败的硬错误 */
  errors: string[];
  /** 不阻断构建，但要在输出里露出来 */
  warnings: string[];
}

function splitList(raw: string, sep: string): string[] {
  return raw
    .split(sep)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 解析并校验核心词表 TSV。
 *
 * 行号从 2 开始报（第 1 行是表头），方便直接跳到源文件对应行。
 */
export function parseCoreTsv(text: string): ParseResult {
  const entries: DictEntry[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, number>();

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerLine = lines[0]?.trim() ?? '';
  if (headerLine !== CORE_TSV_HEADER.join('\t')) {
    errors.push(`表头必须是 ${CORE_TSV_HEADER.join(' / ')}，实际是「${headerLine}」`);
    return { entries, errors, warnings };
  }

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const lineNo = i + 1;

    const cells = raw.split('\t');
    if (cells.length !== CORE_TSV_HEADER.length) {
      errors.push(`第 ${lineNo} 行：应为 ${CORE_TSV_HEADER.length} 列，实际 ${cells.length} 列`);
      continue;
    }

    const [lemmaRaw = '', phoneticUs = '', phoneticUk = '', posRaw = '', defRaw = ''] = cells;
    const lemma = lemmaRaw.trim().toLowerCase();

    if (!LEMMA_RE.test(lemma)) {
      errors.push(`第 ${lineNo} 行：原形「${lemmaRaw}」不合法（应为首字母开头的英文词）`);
      continue;
    }
    const dup = seen.get(lemma);
    if (dup !== undefined) {
      errors.push(`第 ${lineNo} 行：原形「${lemma}」与第 ${dup} 行重复`);
      continue;
    }

    for (const [label, value] of [
      ['美音', phoneticUs],
      ['英音', phoneticUk],
    ] as const) {
      if (value.trim() !== '' && !PHONETIC_RE.test(value.trim())) {
        errors.push(`第 ${lineNo} 行：${label}「${value}」应写成 /.../ 形式`);
      }
    }

    const pos = splitList(posRaw, ',');
    for (const tag of pos) {
      if (!(ALLOWED_POS as readonly string[]).includes(tag)) {
        errors.push(`第 ${lineNo} 行：词性「${tag}」不在允许集合内`);
      }
    }

    const defZh = splitList(defRaw, '；');
    if (defZh.length === 0) {
      errors.push(`第 ${lineNo} 行：缺中文释义`);
      continue;
    }

    if (pos.length === 0) warnings.push(`第 ${lineNo} 行：「${lemma}」没标词性`);
    if (phoneticUs.trim() === '') warnings.push(`第 ${lineNo} 行：「${lemma}」没标音标`);

    seen.set(lemma, lineNo);
    entries.push({
      lemma,
      phoneticUs: phoneticUs.trim(),
      phoneticUk: phoneticUk.trim(),
      pos,
      defZh,
    });
  }

  if (entries.length === 0 && errors.length === 0) {
    errors.push('没有解析出任何词条');
  }
  return { entries, errors, warnings };
}

export interface BuildOptions {
  version: string;
  generatedAt: string;
  /**
   * 常驻分片（注入时即加载）能装多少词。PLAN.md §4.5 P3 取高频前 ~3 万。
   * 超出部分按首字母切分，miss 时才 fetch。
   */
  hotMax: number;
}

export interface BuiltDict {
  index: DictIndex;
  shards: DictShard[];
}

function bucketOf(lemma: string): string {
  const first = lemma[0] ?? '';
  return first >= 'a' && first <= 'z' ? first : 'other';
}

function toShard(name: string, entries: DictEntry[]): DictShard {
  const words: Record<string, DictEntry> = {};
  for (const entry of entries) words[entry.lemma] = entry;
  return { name, words };
}

/**
 * 切片。
 *
 * 输入顺序即优先级顺序（源文件按词频从高到低写），前 `hotMax` 个进常驻分片。
 * 不丢词、不重词由单测锁住。
 */
export function shardEntries(entries: DictEntry[], options: BuildOptions): BuiltDict {
  const hot = entries.slice(0, options.hotMax);
  const rest = entries.slice(options.hotMax);

  const shards: DictShard[] = [toShard('core', hot)];

  if (rest.length > 0) {
    const buckets = new Map<string, DictEntry[]>();
    for (const entry of rest) {
      const key = bucketOf(entry.lemma);
      const list = buckets.get(key);
      if (list) list.push(entry);
      else buckets.set(key, [entry]);
    }
    for (const key of [...buckets.keys()].sort()) {
      shards.push(toShard(key, buckets.get(key) ?? []));
    }
  }

  const infos: DictShardInfo[] = shards.map((shard) => {
    const serialized = JSON.stringify(shard);
    return {
      name: shard.name,
      file: `shard-${shard.name}.json`,
      count: Object.keys(shard.words).length,
      // 按 UTF-8 计，中文释义不能按字符数算
      bytes: new TextEncoder().encode(serialized).length,
    };
  });

  return {
    index: {
      version: options.version,
      generatedAt: options.generatedAt,
      count: entries.length,
      shards: infos,
    },
    shards,
  };
}

/** 序列化：分片不换行（体积优先，人是看源 TSV 的），清单换行（便于 diff） */
export function serializeShard(shard: DictShard): string {
  return JSON.stringify(shard);
}

export function serializeIndex(index: DictIndex): string {
  return JSON.stringify(index, null, 2) + '\n';
}
