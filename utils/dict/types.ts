/**
 * 词表的数据形态（PLAN.md FR-B1 / §4.5）。
 *
 * 核心词表随包发布，构建期切成"常驻分片 + 首字母分片"，运行期由内容脚本按需取用。
 */

/** 一个词条。字段与 `Word` 的词典侧字段同名，便于直接灌进存储层 */
export interface DictEntry {
  /** 规范原形，小写 */
  lemma: string;
  phoneticUs: string;
  /** 恒为空：英式音标不在本期范围，空串表示"暂无英音数据"（PLAN.md §2） */
  phoneticUk: string;
  /** 词性，如 `['n.', 'v.']` */
  pos: string[];
  /** 中文释义，按词性切分 */
  defZh: string[];
}

/** 词表版本清单，内容脚本第一件事就是拿它 */
export interface DictIndex {
  version: string;
  generatedAt: string;
  /** 全部词条数 */
  count: number;
  shards: DictShardInfo[];
}

export interface DictShardInfo {
  name: string;
  /** 相对 `dict/` 的文件名 */
  file: string;
  count: number;
  bytes: number;
}

/** 一个分片。用 map 而不是数组：查询是 O(1)，且不必在运行时建索引 */
export interface DictShard {
  name: string;
  words: Record<string, DictEntry>;
}
