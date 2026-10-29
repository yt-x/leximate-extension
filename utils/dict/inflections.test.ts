/**
 * 变形索引加载的单测（PLAN.md FR-B3a、FR-B3d）。
 *
 * 重点：产物结构对不上时必须**抛错而不是静默返回空索引**——
 * 后者会让词形还原悄悄失效，而用户只会觉得"这插件查不到 running"。
 */
import { describe, expect, it } from 'vitest';
import {
  loadInflections,
  parseInflections,
  SUPPORTED_ARTIFACT_VERSION,
  toReverseIndex,
  type InflectionArtifact,
} from './inflections';

function artifact(patch: Partial<InflectionArtifact> = {}): InflectionArtifact {
  return {
    version: SUPPORTED_ARTIFACT_VERSION,
    dictVersion: '0.1.0',
    source: 'Wikidata Lexeme (CC0)',
    count: 2,
    entries: {
      running: [{ lemma: 'run', hint: '现在分词' }],
      studies: [{ lemma: 'study', hint: '第三人称单数' }],
    },
    ...patch,
  };
}

describe('解析产物', () => {
  it('正常产物解析成功', () => {
    const parsed = parseInflections(JSON.stringify(artifact()));
    expect(parsed.version).toBe(SUPPORTED_ARTIFACT_VERSION);
    expect(Object.keys(parsed.entries)).toEqual(['running', 'studies']);
  });

  it('版本不兼容时抛错（而不是当成空索引）', () => {
    expect(() => parseInflections(JSON.stringify(artifact({ version: 99 })))).toThrow(/版本不兼容/);
  });

  it('缺 entries 时抛错', () => {
    const broken = { version: SUPPORTED_ARTIFACT_VERSION } as unknown as string;
    expect(() => parseInflections(JSON.stringify(broken))).toThrow(/缺 entries/);
  });

  it('非法 JSON 抛错', () => {
    expect(() => parseInflections('{not json')).toThrow();
  });

  it('缺可选字段时补默认值而不是崩', () => {
    const parsed = parseInflections(
      JSON.stringify({ version: SUPPORTED_ARTIFACT_VERSION, entries: { a: [] } }),
    );
    expect(parsed.dictVersion).toBe('');
    expect(parsed.source).toBe('');
    // count 缺失时按实际条目数
    expect(parsed.count).toBe(1);
  });
});

describe('转成运行时索引', () => {
  it('surface → { lemma → hint } 结构正确', () => {
    const index = toReverseIndex(artifact());
    expect([...index.keys()]).toEqual(['running', 'studies']);
    expect([...index.get('running')!.keys()]).toEqual(['run']);
    // hint 放进 Set
    expect([...index.get('running')!.get('run')!]).toEqual(['现在分词']);
  });

  it('一个 surface 挂多个原形时全部保留（同形冲突不能丢）', () => {
    const index = toReverseIndex(
      artifact({
        entries: {
          left: [
            { lemma: 'leave', hint: '过去式' },
            { lemma: 'left', hint: '' },
          ],
        },
      }),
    );
    const bucket = index.get('left')!;
    expect([...bucket.keys()].sort()).toEqual(['leave', 'left']);
  });

  it('hint 为空串时也保留，不会丢候选', () => {
    const index = toReverseIndex(artifact({ entries: { x: [{ lemma: 'y', hint: '' }] } }));
    expect([...index.get('x')!.keys()]).toEqual(['y']);
  });

  it('空产物给出空索引', () => {
    expect(toReverseIndex(artifact({ entries: {} })).size).toBe(0);
  });
});

describe('从扩展包内读取', () => {
  it('拼出正确路径并解析', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, text: async () => JSON.stringify(artifact()) } as Response;
    }) as unknown as typeof fetch;

    const parsed = await loadInflections('chrome-extension://abc/dict/', fetchImpl);
    expect(calls).toEqual(['chrome-extension://abc/dict/inflections.json']);
    expect(parsed.count).toBe(2);
  });

  it('baseUrl 末尾没有斜杠时自动补', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, text: async () => JSON.stringify(artifact()) } as Response;
    }) as unknown as typeof fetch;

    await loadInflections('chrome-extension://abc/dict', fetchImpl);
    expect(calls[0]).toBe('chrome-extension://abc/dict/inflections.json');
  });

  it('HTTP 失败时抛错（不静默降级）', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch;
    await expect(loadInflections('x/', fetchImpl)).rejects.toThrow(/HTTP 404/);
  });
});
