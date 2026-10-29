/**
 * 内容脚本侧网关的单测。
 *
 * 重点是**不可信响应的解析**：消息对面可能是被回收的后台、
 * 版本不匹配的旧代码，回来的东西不保证是期望形状。
 * 坏数据必须被丢弃，不能塞进缓存——缓存里混进脏数据会让标注长期画错。
 */
import { describe, expect, it, vi } from 'vitest';
import { createMessagingGateway, fetchSettings, parseStatesResponse, type SendEnv } from './gateway';
import { MSG } from './messages';

describe('parseStatesResponse', () => {
  it('解析合法响应', () => {
    expect(
      parseStatesResponse([
        { word: 'Run', state: { status: 'known', meetCount: 3 } },
        { word: 'go', state: { status: 'new', meetCount: 0 } },
      ]),
    ).toEqual([
      { word: 'run', state: { status: 'known', meetCount: 3 } },
      { word: 'go', state: { status: 'new', meetCount: 0 } },
    ]);
  });

  it('非数组返回空', () => {
    for (const input of [undefined, null, 'x', 42, {}]) {
      expect(parseStatesResponse(input)).toEqual([]);
    }
  });

  it('丢弃缺字段或字段类型错的项', () => {
    expect(
      parseStatesResponse([
        null,
        'x',
        {},
        { word: 'a' },
        { word: 'a', state: null },
        { word: '', state: { status: 'new', meetCount: 1 } },
        { word: 42, state: { status: 'new', meetCount: 1 } },
        { word: 'b', state: { status: 'unknown', meetCount: 1 } },
        { word: 'ok', state: { status: 'new', meetCount: 1 } },
      ]),
    ).toEqual([{ word: 'ok', state: { status: 'new', meetCount: 1 } }]);
  });

  it('meetCount 非法时归 0 而不是丢掉整条', () => {
    // 状态是对的、计数坏了——标注意义上状态更重要，保留它并把计数归零
    expect(parseStatesResponse([{ word: 'a', state: { status: 'known', meetCount: 'x' } }])).toEqual(
      [{ word: 'a', state: { status: 'known', meetCount: 0 } }],
    );
    expect(
      parseStatesResponse([{ word: 'a', state: { status: 'known', meetCount: Number.NaN } }]),
    ).toEqual([{ word: 'a', state: { status: 'known', meetCount: 0 } }]);
  });
});

describe('createMessagingGateway', () => {
  it('fetchStates 发对消息并回解析结果', async () => {
    const requests: unknown[] = [];
    const env: SendEnv = {
      sendToBackground: async (request) => {
        requests.push(request);
        return [{ word: 'run', state: { status: 'known', meetCount: 2 } }];
      },
    };

    const states = await createMessagingGateway(env).fetchStates(['run']);
    expect(requests).toEqual([{ type: MSG.fetchStates, words: ['run'] }]);
    expect(states).toEqual([{ word: 'run', state: { status: 'known', meetCount: 2 } }]);
  });

  it('fetchStates 空输入不发消息', async () => {
    const send = vi.fn();
    await createMessagingGateway({ sendToBackground: send }).fetchStates([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('发消息失败时返回安全值，不把异常抛给标注路径', async () => {
    // 后台被回收、页面正在卸载都会走到这里；最差退化成"按生词处理"
    const env: SendEnv = {
      sendToBackground: async () => {
        throw new Error('Receiving end does not exist');
      },
    };
    const gateway = createMessagingGateway(env);

    await expect(gateway.fetchStates(['run'])).resolves.toEqual([]);
    await expect(
      gateway.recordMeet({ lemma: 'run', surface: 'run', unlisted: false }),
    ).resolves.toBeUndefined();
    await expect(gateway.setStatus('run', 'known')).resolves.toBeUndefined();
    await expect(gateway.openManager()).resolves.toBe(false);
  });

  it('recordMeet / setStatus 发对消息', async () => {
    const requests: unknown[] = [];
    const env: SendEnv = {
      sendToBackground: async (request) => {
        requests.push(request);
        return { status: 'known', meetCount: 1 };
      },
    };
    const gateway = createMessagingGateway(env);

    await gateway.recordMeet({
      lemma: 'run',
      surface: 'running',
      unlisted: false,
      dict: { phoneticUs: '/rʌn/', pos: ['v.'], defZh: ['跑'] },
    });
    await gateway.setStatus('run', 'known');

    expect(requests).toEqual([
      {
        type: MSG.recordMeet,
        lemma: 'run',
        surface: 'running',
        unlisted: false,
        inflectionOf: null,
        dict: { phoneticUs: '/rʌn/', pos: ['v.'], defZh: ['跑'] },
      },
      { type: MSG.setStatus, word: 'run', status: 'known' },
    ]);
  });

  it('未收录的遇见不携带词库字段（后台据此标 isUnlisted）', async () => {
    const requests: unknown[] = [];
    const env: SendEnv = {
      sendToBackground: async (request) => {
        requests.push(request);
        return { status: 'new', meetCount: 1 };
      },
    };

    await createMessagingGateway(env).recordMeet({
      lemma: 'learni',
      surface: 'Learnin',
      unlisted: true,
    });

    expect(requests).toEqual([
      {
        type: MSG.recordMeet,
        lemma: 'learni',
        surface: 'Learnin',
        unlisted: true,
        inflectionOf: null,
      },
    ]);
  });

  it('recordMeet 带例句时必须把 scene 发出去（FR-C1：划词收藏要存例句）', async () => {
    const requests: unknown[] = [];
    const env: SendEnv = {
      sendToBackground: async (request) => {
        requests.push(request);
        return { status: 'new', meetCount: 1 };
      },
    };

    const scene = {
      text: 'He ran across the field.',
      highlightFrom: 3,
      highlightTo: 6,
      sourceUrl: 'https://example.com/a',
      sourceTitle: 'Example',
    };
    await createMessagingGateway(env).recordMeet({
      lemma: 'run',
      surface: 'ran',
      unlisted: false,
      scene,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: MSG.recordMeet, lemma: 'run', scene });
  });

  it('recordMeet 没带例句时请求里不含 scene 字段', async () => {
    const requests: unknown[] = [];
    const env: SendEnv = {
      sendToBackground: async (request) => {
        requests.push(request);
        return { status: 'new', meetCount: 1 };
      },
    };

    await createMessagingGateway(env).recordMeet({ lemma: 'run', surface: 'run', unlisted: false });

    expect(requests[0]).not.toHaveProperty('scene');
  });

  it('fetchNewWords 解析下发集合，坏条目丢掉', async () => {    const env: SendEnv = {
      sendToBackground: async () => [
        { word: 'Run', meetCount: 3 },
        { word: 'proof', meetCount: 1 },
        { word: '', meetCount: 1 },
        { word: 42, meetCount: 1 },
        { word: 'nocount' },
        null,
      ],
    };

    const list = await createMessagingGateway(env).fetchNewWords();

    expect(list).toEqual([
      { word: 'run', meetCount: 3 },
      { word: 'proof', meetCount: 1 },
      // 缺次数的按 1 处理（FR-A11 分档的最小档）
      { word: 'nocount', meetCount: 1 },
    ]);
  });

  it('fetchNewWords 拿不到时返回 undefined（不是空数组）', async () => {
    const failing: SendEnv = {
      sendToBackground: async () => {
        throw new Error('Receiving end does not exist');
      },
    };
    await expect(createMessagingGateway(failing).fetchNewWords()).resolves.toBeUndefined();

    // 形状不对也算"拿不到"：空数组会把整页下划线抹掉，未定义则保持原状
    const wrongShape: SendEnv = { sendToBackground: async () => ({ nope: true }) };
    await expect(createMessagingGateway(wrongShape).fetchNewWords()).resolves.toBeUndefined();
  });

  it('fetchNewWords 发对消息', async () => {
    const requests: unknown[] = [];
    const env: SendEnv = {
      sendToBackground: async (request) => {
        requests.push(request);
        return [];
      },
    };

    await createMessagingGateway(env).fetchNewWords();

    expect(requests).toEqual([{ type: MSG.fetchNewWords }]);
  });

  it('openManager 发消息并在成功时回 true', async () => {
    const requests: unknown[] = [];
    const env: SendEnv = {
      sendToBackground: async (request) => {
        requests.push(request);
        return true;
      },
    };

    await expect(createMessagingGateway(env).openManager()).resolves.toBe(true);
    expect(requests).toEqual([{ type: MSG.openManager }]);
  });

  /**
   * FR-B7 的真实断点回归。
   *
   * 用户导完完整词库后划 `constraint` / `Adventures` 仍显示「未收录」——
   * 根因是这条消息从头到尾没被发出：controller 不传 `lookupImported`、
   * env 里没有这个字段、gateway 里没有这个方法。
   * 这三层现在都有用例锁着（本条锁 gateway 这一层）。
   */
  it('fetchImported 发出 fetch-imported 并解析命中', async () => {
    const requests: unknown[] = [];
    const env: SendEnv = {
      sendToBackground: async (request) => {
        requests.push(request);
        return {
          lemma: 'adventure',
          hint: '复数形式',
          word: {
            phoneticUs: "əd'ventʃə",
            pos: ['n.'],
            defZh: ['n. 冒险, 冒险经历'],
            fallbackDef: [],
            examTags: ['cet4'],
          },
        };
      },
    };

    const hit = await createMessagingGateway(env).fetchImported!('Adventures');

    expect(requests).toEqual([{ type: MSG.fetchImported, word: 'Adventures' }]);
    expect(hit?.lemma).toBe('adventure');
    expect(hit?.word.defZh).toEqual(['n. 冒险, 冒险经历']);
  });

  it('fetchImported：后台回 null 时返回 null（词典里没有）', async () => {
    const env: SendEnv = { sendToBackground: async () => null };
    expect(await createMessagingGateway(env).fetchImported!('zzzz')).toBeNull();
  });

  it('fetchImported：后台不可达时返回 null，不抛错', async () => {
    const env: SendEnv = {
      sendToBackground: async () => {
        throw new Error('Extension context invalidated');
      },
    };
    expect(await createMessagingGateway(env).fetchImported!('run')).toBeNull();
  });

  it('fetchImported：后台出错时打诊断日志（不能静默吞成"词典里没有"）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env: SendEnv = {
      sendToBackground: async () => {
        throw new Error('数据库被占用');
      },
    };
    await createMessagingGateway(env).fetchImported!('dispatching');
    expect(errSpy).toHaveBeenCalled();
    const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toMatch(/dispatching/);
    expect(joined).toMatch(/数据库被占用/);
    errSpy.mockRestore();
  });

  it('fetchImported：释义为空的响应不算命中', async () => {
    const env: SendEnv = {
      sendToBackground: async () => ({ lemma: 'x', hint: null, word: { defZh: [] } }),
    };
    expect(await createMessagingGateway(env).fetchImported!('x')).toBeNull();
  });
});

describe('fetchSettings', () => {
  it('回设置对象', async () => {
    const env: SendEnv = { sendToBackground: async () => ({ enabled: false }) };
    expect(await fetchSettings(env)).toEqual({ enabled: false });
  });

  it('失败返回 undefined，由调用方回退默认设置', async () => {
    const env: SendEnv = {
      sendToBackground: async () => {
        throw new Error('nope');
      },
    };
    expect(await fetchSettings(env)).toBeUndefined();
  });
});
