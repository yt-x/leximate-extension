/**
 * 后台消息处理的单测。
 *
 * 这个模块是**信任边界**：外面是不可信的内容脚本消息，里面是扩展源的数据。
 * 因此用例重点是"畸形输入不造成伤害"与"合法输入正常工作"。
 */
import { describe, expect, it, vi } from 'vitest';
import { handleContentMessage, type HandlerEnv } from './message-handler';
import { MSG } from './messages';
import type { WordStateStore } from './word-state';
import { UNSEEN } from './word-state-shared';
import { DEFAULT_SETTINGS } from '../db/defaults';

function makeStore(overrides: Partial<WordStateStore> = {}): WordStateStore {
  return {
    get: async () => UNSEEN,
    peek: () => undefined,
    getMany: async () => [],
    listNewWords: async () => [],
    getCard: async () => undefined,
    recordMeet: async (word) => ({ status: 'new', meetCount: 1 }),
    setStatus: async (word, status) => ({ status, meetCount: 1 }),
    clear: () => {},
    ...overrides,
  };
}

function makeEnv(store: WordStateStore = makeStore()): HandlerEnv {
  return {
    store,
    getSettings: async () => ({ enabled: true }),
    openManager: () => {},
    refreshBadge: () => {},
    onWordsChanged: () => {},
    writeLog: async () => {},
  };
}

/**
 * FR-A14：角标数 = 遇见词数，因此**任何会改变词数的消息之后都要重算**。
 *
 * 旧实现只在"设置写入 / SW 启动 / 安装"时刷新角标，于是划词收藏之后角标不涨、
 * 管理台删词之后角标不掉，直到 Service Worker 被回收重启才对上。
 */
describe('FR-A14：词数变化后刷新角标', () => {
  it('记一次遇见之后刷新（划词收藏要让角标立刻涨）', async () => {
    const refreshBadge = vi.fn();
    const env = { ...makeEnv(), refreshBadge };

    await handleContentMessage({ type: MSG.recordMeet, lemma: 'run' }, env);

    expect(refreshBadge).toHaveBeenCalledTimes(1);
  });

  it('改状态之后刷新（已掌握不改变词数，但实现上同一条路径）', async () => {
    const refreshBadge = vi.fn();
    const env = { ...makeEnv(), refreshBadge };

    await handleContentMessage({ type: MSG.setStatus, word: 'run', status: 'known' }, env);

    expect(refreshBadge).toHaveBeenCalledTimes(1);
  });

  it('收到"数据变了"通知后刷新（管理台删词/改状态走这条）', async () => {
    const refreshBadge = vi.fn();
    const env = { ...makeEnv(), refreshBadge };

    const result = await handleContentMessage({ type: MSG.dataChanged }, env);

    expect(refreshBadge).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ handled: true, response: true });
  });

  it('管理台改库后清后台词状态缓存，防止旧状态复活已删除词', async () => {
    const clear = vi.fn();
    const env = makeEnv(makeStore({ clear }));

    await handleContentMessage({ type: MSG.dataChanged }, env);

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('管理台保存后广播新的内容脚本设置，而不只刷新词库', async () => {
    const onSettingsChanged = vi.fn();
    const env = { ...makeEnv(), onSettingsChanged };

    await handleContentMessage({ type: MSG.dataChanged }, env);

    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('收藏、改状态、管理台改库都请求一次延迟同步', async () => {
    const onSyncRequested = vi.fn();
    const env = { ...makeEnv(), onSyncRequested };

    await handleContentMessage({ type: MSG.recordMeet, lemma: 'run' }, env);
    await handleContentMessage({ type: MSG.setStatus, word: 'run', status: 'known' }, env);
    await handleContentMessage({ type: MSG.dataChanged }, env);

    expect(onSyncRequested).toHaveBeenCalledTimes(3);
  });

  it('读类消息不刷新角标（没必要惊动它）', async () => {
    const refreshBadge = vi.fn();
    const env = { ...makeEnv(), refreshBadge };

    await handleContentMessage({ type: MSG.getSettings }, env);
    await handleContentMessage({ type: MSG.fetchStates, words: ['run'] }, env);

    expect(refreshBadge).not.toHaveBeenCalled();
  });

  it('写失败（畸形输入）不刷新：什么都没变', async () => {
    const refreshBadge = vi.fn();
    const env = { ...makeEnv(), refreshBadge };

    await handleContentMessage({ type: MSG.recordMeet, lemma: '' }, env);

    expect(refreshBadge).not.toHaveBeenCalled();
  });
});

/**
 * 管理台/其它扩展页面要知道"词库变了"才会重新读库。
 *
 * 内容脚本写入的是**扩展源**的库，管理台是另一个页面——没有通知，
 * 已经打开的管理台永远显示旧列表（用户的观感是"划了词但生词本里没有"）。
 */
describe('FR-F2：词库写入后广播给扩展页面', () => {
  it('记一次遇见之后广播', async () => {
    const onWordsChanged = vi.fn();
    const env = { ...makeEnv(), onWordsChanged };

    await handleContentMessage({ type: MSG.recordMeet, lemma: 'run' }, env);

    expect(onWordsChanged).toHaveBeenCalledTimes(1);
  });

  it('改状态之后广播', async () => {
    const onWordsChanged = vi.fn();
    const env = { ...makeEnv(), onWordsChanged };

    await handleContentMessage({ type: MSG.setStatus, word: 'run', status: 'known' }, env);

    expect(onWordsChanged).toHaveBeenCalledTimes(1);
  });

  it('收到管理台的"数据变了"通知后也要广播（其它管理台标签页要跟上）', async () => {
    const onWordsChanged = vi.fn();
    const env = { ...makeEnv(), onWordsChanged };

    await handleContentMessage({ type: MSG.dataChanged }, env);

    expect(onWordsChanged).toHaveBeenCalledTimes(1);
  });

  it('读类消息不广播', async () => {
    const onWordsChanged = vi.fn();
    const env = { ...makeEnv(), onWordsChanged };

    await handleContentMessage({ type: MSG.getSettings }, env);
    await handleContentMessage({ type: MSG.fetchStates, words: ['run'] }, env);

    expect(onWordsChanged).not.toHaveBeenCalled();
  });
});

describe('FR-L4：内容脚本的日志上报', () => {
  it('log 消息派发到 writeLog，负载原样传下去（清洗在 writeLog 里）', async () => {
    const writeLog = vi.fn(async () => {});
    const env = { ...makeEnv(), writeLog };

    const result = await handleContentMessage(
      { type: MSG.log, level: 'warn', scope: 'content', message: 'popup-shown', detail: { a: 1 } },
      env,
    );

    expect(result).toEqual({ handled: true, response: true });
    expect(writeLog).toHaveBeenCalledWith({
      level: 'warn',
      scope: 'content',
      message: 'popup-shown',
      detail: { a: 1 },
    });
  });

  it('畸形负载不抛错（诊断不该成为故障源）', async () => {
    const writeLog = vi.fn(async () => {});
    const env = { ...makeEnv(), writeLog };

    for (const payload of [undefined, null, 42, { evil: true }]) {
      await expect(
        handleContentMessage({ type: MSG.log, level: payload, scope: payload, message: payload }, env),
      ).resolves.toEqual({ handled: true, response: true });
    }
    expect(writeLog).toHaveBeenCalledTimes(4);
  });

  it('写日志失败也不上抛（本模块的契约：任何分支都不抛）', async () => {
    const writeLog = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const env = { ...makeEnv(), writeLog };

    await expect(
      handleContentMessage({ type: MSG.log, level: 'info', scope: 'content', message: 'x' }, env),
    ).resolves.toEqual({ handled: true, response: true });
  });

  it('读类消息不受影响（不写日志）', async () => {
    const writeLog = vi.fn(async () => {});
    const env = { ...makeEnv(), writeLog };

    await handleContentMessage({ type: MSG.getSettings }, env);

    expect(writeLog).not.toHaveBeenCalled();
  });
});

describe('FR-A6：打开管理台', () => {
  it('open-manager 消息派发到环境能力并回复成功', async () => {
    const openManager = vi.fn();
    const env = { ...makeEnv(), openManager };

    const result = await handleContentMessage({ type: MSG.openManager }, env);

    expect(openManager).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('打开失败也不抛（内容脚本在等 Promise，抛错会变成难懂的异常）', async () => {
    const env = {
      ...makeEnv(),
      openManager: () => {
        throw new Error('tabs API 不可用');
      },
    };

    await expect(handleContentMessage({ type: MSG.openManager }, env)).resolves.toEqual({
      handled: true,
      response: false,
    });
  });

  it('open-manager 属于本扩展的消息（不算未知类型）', async () => {
    const env = makeEnv();
    const result = await handleContentMessage({ type: MSG.openManager }, env);
    expect(result.handled).toBe(true);
  });
});

describe('handleContentMessage', () => {
  it('read-dict-file：白名单文件交给后台读，返回文本', async () => {
    const readDictFile = vi.fn(async (file: string) => `{"file":"${file}"}`);
    const env = { ...makeEnv(), readDictFile };

    const result = await handleContentMessage(
      { type: MSG.readDictFile, file: 'shard-core.json' },
      env,
    );

    expect(readDictFile).toHaveBeenCalledWith('shard-core.json');
    expect(result).toEqual({ handled: true, response: '{"file":"shard-core.json"}' });
  });

  it('read-dict-file：路径穿越与非白名单文件名一律拒绝', async () => {
    const readDictFile = vi.fn(async () => 'leaked');
    const env = { ...makeEnv(), readDictFile };

    for (const file of ['../manifest.json', 'dict/index.json', 'other.json', '', 'shard-core.json.bak']) {
      const result = await handleContentMessage({ type: MSG.readDictFile, file }, env);
      expect(result, `应拒绝 ${JSON.stringify(file)}`).toEqual({ handled: true, response: null });
    }
    expect(readDictFile).not.toHaveBeenCalled();
  });

  it('read-dict-file：后台没接这个能力时回 null', async () => {
    const result = await handleContentMessage(
      { type: MSG.readDictFile, file: 'index.json' },
      makeEnv(),
    );
    expect(result).toEqual({ handled: true, response: null });
  });

  it('fetch-imported：把 word 交给 lookupImported，命中就原样回', async () => {
    const lookupImported = vi.fn(async (word: string) => ({
      lemma: 'adventure',
      hint: '复数形式',
      word: {
        phoneticUs: '',
        pos: ['n.'],
        defZh: [`n. 冒险（${word}）`],
        fallbackDef: [],
        examTags: [],
      },
    }));
    const env = { ...makeEnv(), lookupImported };

    const result = await handleContentMessage({ type: MSG.fetchImported, word: 'Adventures' }, env);

    expect(lookupImported).toHaveBeenCalledWith('adventures');
    expect(result.handled).toBe(true);
    expect((result.response as { lemma: string }).lemma).toBe('adventure');
  });

  it('fetch-imported：没接 lookupImported 时回 null（不报错）', async () => {
    const result = await handleContentMessage({ type: MSG.fetchImported, word: 'run' }, makeEnv());
    expect(result).toEqual({ handled: true, response: null });
  });

  it('fetch-imported：word 非法时回 null 且不调 lookupImported', async () => {
    const lookupImported = vi.fn(async () => null);
    const env = { ...makeEnv(), lookupImported };
    const result = await handleContentMessage({ type: MSG.fetchImported, word: '' }, env);
    expect(result).toEqual({ handled: true, response: null });
    expect(lookupImported).not.toHaveBeenCalled();
  });
});

describe('handleContentMessage（既有）', () => {
  it('非对象消息返回 handled:false，不吞别人的消息', async () => {
    const env = makeEnv();
    expect(await handleContentMessage(null, env)).toEqual({ handled: false });
    expect(await handleContentMessage('hi', env)).toEqual({ handled: false });
  });

  it('未知 type 返回 handled:false', async () => {
    const env = makeEnv();
    const result = await handleContentMessage({ type: 'something-else' }, env);
    expect(result.handled).toBe(false);
  });

  describe('getSettings', () => {
    it('回设置对象', async () => {
      const env = makeEnv();
      const result = await handleContentMessage({ type: MSG.getSettings }, env);
      expect(result).toEqual({ handled: true, response: { enabled: true } });
    });

    it('只下发内容脚本所需字段，LLM 与 WebDAV 秘密不得离开扩展源', async () => {
      const env = {
        ...makeEnv(),
        getSettings: async () => ({
          ...DEFAULT_SETTINGS,
          translation: {
            ...DEFAULT_SETTINGS.translation,
            llm: { baseUrl: 'https://llm.test', apiKey: 'sk-test-secret', model: 'm' },
            api: { url: 'https://api.test', headers: { authorization: 'Bearer test-secret' } },
          },
          webdav: {
            url: 'https://dav.test', username: 'user', password: 'dav-secret', path: '/x', passphrase: 'pass-secret',
          },
        }),
      };

      const result = await handleContentMessage({ type: MSG.getSettings }, env);
      const response = (result as { response: Record<string, unknown> }).response;
      const serialized = JSON.stringify(response);

      expect(serialized).not.toContain('sk-test-secret');
      expect(serialized).not.toContain('Bearer test-secret');
      expect(serialized).not.toContain('dav-secret');
      expect(serialized).not.toContain('pass-secret');
      expect(response).not.toHaveProperty('translation');
      expect(response).not.toHaveProperty('webdav');
      expect(response).toMatchObject({ enabled: true, speechRate: 1, blacklist: [] });
    });
  });

  describe('defineWord', () => {
    it('把合法单词交给 LLM 释义能力并回传结果', async () => {
      const defineWord = vi.fn(async () => ({ defZh: ['n. 测试；示例'] }));
      const env = { ...makeEnv(), defineWord };

      const result = await handleContentMessage({ type: MSG.defineWord, word: ' learni ' }, env);

      expect(defineWord).toHaveBeenCalledWith('learni');
      expect(result).toEqual({ handled: true, response: { defZh: ['n. 测试；示例'] } });
    });

    it('非法单词或能力未配置时不抛错', async () => {
      const env = makeEnv();
      expect(await handleContentMessage({ type: MSG.defineWord, word: '' }, env))
        .toEqual({ handled: true, response: { error: '单词为空或不可用' } });
    });
  });

  describe('fetchStates', () => {
    it('洗过输入后查库', async () => {
      const getMany = vi.fn(async () => [{ word: 'run', state: { status: 'known' as const, meetCount: 3 } }]);
      const env = makeEnv(makeStore({ getMany }));

      const result = await handleContentMessage(
        { type: MSG.fetchStates, words: ['Run', ' run ', 'go'] },
        env,
      );

      expect(result.handled).toBe(true);
      // 重复项已去重、已小写
      expect(getMany).toHaveBeenCalledWith(['run', 'go']);
    });

    it('words 畸形时返回空数组而不是抛错', async () => {
      const env = makeEnv();
      for (const words of [undefined, null, 'run', 42, {}]) {
        const result = await handleContentMessage({ type: MSG.fetchStates, words }, env);
        expect(result).toEqual({ handled: true, response: [] });
      }
    });

    it('全是空串时不去查库', async () => {
      const getMany = vi.fn(async () => []);
      const env = makeEnv(makeStore({ getMany }));

      await handleContentMessage({ type: MSG.fetchStates, words: ['', '  '] }, env);
      expect(getMany).not.toHaveBeenCalled();
    });
  });

  describe('recordMeet', () => {
    it('合法词落库并回状态（记账键归一、surface 保留原样）', async () => {
      const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 2 }));
      const env = makeEnv(makeStore({ recordMeet }));

      const result = await handleContentMessage(
        { type: MSG.recordMeet, lemma: ' Run ', surface: 'Running', unlisted: false },
        env,
      );

      expect(recordMeet).toHaveBeenCalledWith({
        lemma: 'run',
        surface: 'Running',
        unlisted: false,
        inflectionOf: null,
      });
      expect(result).toEqual({ handled: true, response: { status: 'new', meetCount: 2 } });
    });

    it('未收录的词把 isUnlisted 透传到库（FR-B4）', async () => {
      const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1 }));
      const env = makeEnv(makeStore({ recordMeet }));

      await handleContentMessage(
        { type: MSG.recordMeet, lemma: 'learni', surface: 'Learnin', unlisted: true },
        env,
      );

      expect(recordMeet).toHaveBeenCalledWith({
        lemma: 'learni',
        surface: 'Learnin',
        unlisted: true,
        inflectionOf: null,
      });
    });

    it('命中时透传词库字段（洗过：空释义组整组丢掉）', async () => {
      const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1 }));
      const env = makeEnv(makeStore({ recordMeet }));

      await handleContentMessage(
        {
          type: MSG.recordMeet,
          lemma: 'run',
          surface: 'run',
          unlisted: false,
          dict: { phoneticUs: '/rʌn/', pos: ['v.'], defZh: ['跑'] },
        },
        env,
      );
      expect(recordMeet).toHaveBeenCalledWith({
        lemma: 'run',
        surface: 'run',
        unlisted: false,
        inflectionOf: null,
        dict: { phoneticUs: '/rʌn/', pos: ['v.'], defZh: ['跑'] },
      });

      // 释义为空时整组丢掉：只收音标会让词条进入"半截数据"状态
      recordMeet.mockClear();
      await handleContentMessage(
        { type: MSG.recordMeet, lemma: 'go', surface: 'go', dict: { phoneticUs: '/ɡoʊ/' } },
        env,
      );
      expect(recordMeet).toHaveBeenCalledWith({
        lemma: 'go',
        surface: 'go',
        unlisted: false,
        inflectionOf: null,
      });
    });

    it('畸形 lemma 不回状态也不落库', async () => {
      const recordMeet = vi.fn(async () => UNSEEN);
      const env = makeEnv(makeStore({ recordMeet }));

      for (const lemma of [undefined, 42, '', '   ', null]) {
        const result = await handleContentMessage({ type: MSG.recordMeet, lemma }, env);
        expect(result).toEqual({ handled: true, response: null });
      }
      expect(recordMeet).not.toHaveBeenCalled();
    });

    it('surface 缺省或非法时退回 lemma（不让词条没有页面词形）', async () => {
      const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1 }));
      const env = makeEnv(makeStore({ recordMeet }));

      await handleContentMessage({ type: MSG.recordMeet, lemma: 'run' }, env);

      expect(recordMeet).toHaveBeenCalledWith({
        lemma: 'run',
        surface: 'run',
        unlisted: false,
        inflectionOf: null,
      });
    });
  });

  describe('fetchNewWords（§4.5 P3 生词集合下发）', () => {
    it('回下发的生词集合，且不碰角标/广播（它是读操作）', async () => {
      const refreshBadge = vi.fn();
      const onWordsChanged = vi.fn();
      const env = {
        ...makeEnv(
          makeStore({
            listNewWords: async () => [
              { word: 'run', meetCount: 3 },
              { word: 'proof', meetCount: 1 },
            ],
          }),
        ),
        refreshBadge,
        onWordsChanged,
      };

      const result = await handleContentMessage({ type: MSG.fetchNewWords }, env);

      expect(result).toEqual({
        handled: true,
        response: [
          { word: 'run', meetCount: 3 },
          { word: 'proof', meetCount: 1 },
        ],
      });
      expect(refreshBadge).not.toHaveBeenCalled();
      expect(onWordsChanged).not.toHaveBeenCalled();
    });

    it('空库回空数组（内容脚本据此"一条都不标"，而不是当成失败）', async () => {
      const env = makeEnv(makeStore({ listNewWords: async () => [] }));
      expect(await handleContentMessage({ type: MSG.fetchNewWords }, env)).toEqual({
        handled: true,
        response: [],
      });
    });
  });

  describe('setStatus', () => {
    it('合法词与状态落库', async () => {
      const setStatus = vi.fn(async () => ({ status: 'known' as const, meetCount: 1 }));
      const env = makeEnv(makeStore({ setStatus }));

      const result = await handleContentMessage(
        { type: MSG.setStatus, word: 'run', status: 'known' },
        env,
      );

      expect(setStatus).toHaveBeenCalledWith('run', 'known');
      expect(result).toEqual({ handled: true, response: { status: 'known', meetCount: 1 } });
    });

    it('非法状态不落库', async () => {
      const setStatus = vi.fn(async () => UNSEEN);
      const env = makeEnv(makeStore({ setStatus }));

      for (const status of ['KNOWN', 'deleted', undefined, 3, null]) {
        const result = await handleContentMessage({ type: MSG.setStatus, word: 'run', status }, env);
        expect(result).toEqual({ handled: true, response: null });
      }
      expect(setStatus).not.toHaveBeenCalled();
    });

    it('非法词不落库', async () => {
      const setStatus = vi.fn(async () => UNSEEN);
      const env = makeEnv(makeStore({ setStatus }));

      const result = await handleContentMessage(
        { type: MSG.setStatus, word: '', status: 'known' },
        env,
      );
      expect(result).toEqual({ handled: true, response: null });
      expect(setStatus).not.toHaveBeenCalled();
    });
  });

  it('store 抛错会向上传播（由入口统一兜底，不在这里假装成功）', async () => {
    const env = makeEnv(
      makeStore({
        recordMeet: async () => {
          throw new Error('IndexedDB 不可用');
        },
      }),
    );

    await expect(
      handleContentMessage(
        { type: MSG.recordMeet, lemma: 'run', surface: 'run', unlisted: false },
        env,
      ),
    ).rejects.toThrow('IndexedDB 不可用');
  });
});

/**
 * FR-C1：例句的校验与透传。
 *
 * 这一层是**信任边界**：内容脚本可能送一条畸形的例句上来。
 * 口径是"坏例句只丢例句，不丢这次记账"——记账是主链路，
 * 不能因为切句出错就让用户划的那个词没被记下来。
 */
describe('FR-C1：例句的校验与透传', () => {
  const goodScene = {
    text: 'He ran fast.',
    highlightFrom: 3,
    highlightTo: 6,
    sourceUrl: 'https://example.com/a',
    sourceTitle: 'Example',
  };

  it('合法例句原样交给 store', async () => {
    const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1 }));
    const env = makeEnv(makeStore({ recordMeet }));

    await handleContentMessage({ type: MSG.recordMeet, lemma: 'run', scene: goodScene }, env);

    expect(recordMeet).toHaveBeenCalledWith(expect.objectContaining({ lemma: 'run', scene: goodScene }));
  });

  it('把真实 sceneId 交给翻译入队钩子，不能用 lemma 代替', async () => {
    const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1, sceneId: 'scene-uuid-1' }));
    const onMeetRecorded = vi.fn();
    const env = { ...makeEnv(makeStore({ recordMeet })), onMeetRecorded };

    await handleContentMessage({ type: MSG.recordMeet, lemma: 'run', scene: goodScene }, env);

    expect(onMeetRecorded).toHaveBeenCalledWith({
      lemma: 'run', sceneText: goodScene.text, sceneId: 'scene-uuid-1',
    });
  });

  it('不带例句时**不传** scene 字段（与没有例句采集时一致）', async () => {
    const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1 }));
    const env = makeEnv(makeStore({ recordMeet }));

    await handleContentMessage({ type: MSG.recordMeet, lemma: 'run' }, env);

    expect(recordMeet).toHaveBeenCalledWith(expect.not.objectContaining({ scene: expect.anything() }));
  });

  it('偏移越界的例句被丢弃，但记账照旧', async () => {
    const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1 }));
    const env = makeEnv(makeStore({ recordMeet }));

    await handleContentMessage(
      {
        type: MSG.recordMeet,
        lemma: 'run',
        scene: { ...goodScene, highlightFrom: 99, highlightTo: 120 },
      } as never,
      env,
    );

    expect(recordMeet).toHaveBeenCalledTimes(1);
    expect(recordMeet).toHaveBeenCalledWith(expect.not.objectContaining({ scene: expect.anything() }));
  });

  it('非整数偏移被丢弃', async () => {
    const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1 }));
    const env = makeEnv(makeStore({ recordMeet }));

    await handleContentMessage(
      { type: MSG.recordMeet, lemma: 'run', scene: { ...goodScene, highlightTo: 3.5 } } as never,
      env,
    );

    expect(recordMeet).toHaveBeenCalledWith(expect.not.objectContaining({ scene: expect.anything() }));
  });

  it('空文本、非对象、超长文本都只丢例句', async () => {
    const recordMeet = vi.fn(async () => ({ status: 'new' as const, meetCount: 1 }));
    const env = makeEnv(makeStore({ recordMeet }));

    for (const scene of [
      { ...goodScene, text: '   ' },
      'not-an-object',
      null,
      { ...goodScene, text: 'x'.repeat(5000), highlightFrom: 0, highlightTo: 4 },
      { ...goodScene, highlightFrom: undefined },
    ]) {
      recordMeet.mockClear();
      await handleContentMessage({ type: MSG.recordMeet, lemma: 'run', scene } as never, env);
      expect(recordMeet).toHaveBeenCalledTimes(1);
    expect(recordMeet).toHaveBeenCalledWith(expect.not.objectContaining({ scene: expect.anything() }));
    }
  });
});
