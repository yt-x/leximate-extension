import { describe, expect, it } from 'vitest';
import {
  CORE_TSV_HEADER,
  parseCoreTsv,
  serializeIndex,
  serializeShard,
  shardEntries,
} from './build';
import type { DictEntry } from './types';

const HEADER = CORE_TSV_HEADER.join('\t');

function tsv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n') + '\n';
}

function entry(lemma: string): DictEntry {
  return { lemma, phoneticUs: '/test/', phoneticUk: '', pos: ['n.'], defZh: ['测试'] };
}

describe('核心词表解析与校验', () => {
  it('正常行解析出各列，词性与释义按分隔符切开', () => {
    const result = parseCoreTsv(
      tsv('run\t/rʌn/\t/rʌn/\tv.,n.\t跑；经营', 'pretty\t/ˈprɪti/\t\tadj.\t漂亮的'),
    );

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      lemma: 'run',
      phoneticUs: '/rʌn/',
      phoneticUk: '/rʌn/',
      pos: ['v.', 'n.'],
      defZh: ['跑', '经营'],
    });
    // 空串语义是「暂无英音数据」（见 PLAN.md §2），解析层原样保留，交给展示层决定回退
    expect(result.entries[1]?.phoneticUk).toBe('');
  });

  it('原形归一为小写', () => {
    const result = parseCoreTsv(tsv('London\t/ˈlʌndən/\t\t n.\t伦敦'));
    expect(result.entries[0]?.lemma).toBe('london');
  });

  it('表头不对就整体拒绝，不做猜测', () => {
    const result = parseCoreTsv('word\tphonetic\nrun\t/rʌn/\n');
    expect(result.entries).toEqual([]);
    expect(result.errors[0]).toContain('表头必须是');
  });

  it('列数不对时报出行号', () => {
    const result = parseCoreTsv(tsv('run\t/rʌn/\tn.\t跑'));
    expect(result.errors).toEqual(['第 2 行：应为 5 列，实际 4 列']);
  });

  it('重复原形被拦下，并指出撞在第几行', () => {
    const result = parseCoreTsv(tsv('run\t/rʌn/\t\tn.\t跑', 'run\t/ruːn/\t\tn.\t再跑'));
    expect(result.errors).toEqual(['第 3 行：原形「run」与第 2 行重复']);
    expect(result.entries).toHaveLength(1);
  });

  it('音标必须写成 /.../ 形式', () => {
    const result = parseCoreTsv(tsv('run\trʌn\t\tn.\t跑'));
    expect(result.errors[0]).toContain('美音');
    expect(result.errors[0]).toContain('/.../');
  });

  it('词性不在允许集合内被拦下', () => {
    const result = parseCoreTsv(tsv('run\t/rʌn/\t\tverb\t跑'));
    expect(result.errors).toEqual(['第 2 行：词性「verb」不在允许集合内']);
  });

  it('原形不像英文词、或没写释义，都拒绝', () => {
    const bad = parseCoreTsv(tsv('123\t/a/\t\tn.\t数字'));
    expect(bad.errors[0]).toContain('不合法');

    const empty = parseCoreTsv(tsv('run\t/rʌn/\t\tn.\t'));
    expect(empty.errors).toEqual(['第 2 行：缺中文释义']);
  });

  it('空行与 # 注释跳过，不算错', () => {
    const result = parseCoreTsv(tsv('', '# 这是注释', 'run\t/rʌn/\t\tn.\t跑', ''));
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it('开头的 BOM 不会污染第一个列名', () => {
    const result = parseCoreTsv('\uFEFF' + tsv('run\t/rʌn/\t\tn.\t跑'));
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it('没标词性或没标音标只是警告，不挡构建', () => {
    const result = parseCoreTsv(tsv('run\t\t\t\t跑'));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('一个词都没解析出来算错误', () => {
    const result = parseCoreTsv(HEADER + '\n');
    expect(result.errors).toEqual(['没有解析出任何词条']);
  });
});

describe('切片', () => {
  const options = { version: '1.2.3', generatedAt: '2026-10-13T00:00:00.000Z', hotMax: 30_000 };

  it('总数不超过常驻容量时只出一个 core 分片', () => {
    const entries = [entry('a'), entry('b'), entry('c')];
    const built = shardEntries(entries, options);

    expect(built.shards.map((s) => s.name)).toEqual(['core']);
    expect(built.index.count).toBe(3);
    expect(built.index.shards[0]).toMatchObject({ file: 'shard-core.json', count: 3 });
    expect(built.index.version).toBe('1.2.3');
  });

  it('超出常驻容量后按首字母切分，且不丢词不重词', () => {
    const entries = ['apple', 'ant', 'bat', 'cat', 'zebra', '1st'].map(entry);
    const built = shardEntries(entries, { ...options, hotMax: 1 });

    expect(built.shards.map((s) => s.name)).toEqual(['core', 'a', 'b', 'c', 'other', 'z']);

    const roundTripped: string[] = [];
    for (const shard of built.shards) roundTripped.push(...Object.keys(shard.words));
    expect(roundTripped.sort()).toEqual(entries.map((e) => e.lemma).sort());
    expect(new Set(roundTripped).size).toBe(entries.length);

    // 前 hotMax 个进常驻，其余按字母
    expect(Object.keys(built.shards[0]?.words ?? {})).toEqual(['apple']);
  });

  it('清单里的词数、字节数与实际分片对得上', () => {
    const entries = ['apple', 'ant', 'bat'].map(entry);
    const built = shardEntries(entries, { ...options, hotMax: 1 });

    for (const info of built.index.shards) {
      const shard = built.shards.find((s) => s.name === info.name);
      expect(shard).toBeDefined();
      expect(info.count).toBe(Object.keys(shard?.words ?? {}).length);
      expect(info.bytes).toBe(new TextEncoder().encode(serializeShard(shard!)).length);
    }
  });

  it('清单序列化后仍能读回原结构', () => {
    const built = shardEntries([entry('run')], options);
    expect(JSON.parse(serializeIndex(built.index))).toEqual(built.index);
  });
});
