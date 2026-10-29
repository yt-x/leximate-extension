/**
 * 设置表单校验的单测（PLAN.md FR-F9）。
 *
 * 校验必须存在且严格：设置会写进 IndexedDB 并被内容脚本读去用，
 * 一个 `underlineThickness: 999` 写进去后表现是"页面卡"，很难回溯到设置页。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../db/kv';
import { MAX_RATE, MIN_RATE, safeRate } from '../content/speech';
import type { Settings } from '../db/types';
import {
  applyForm,
  formatBlacklist,
  hasErrors,
  isValidDomainEntry,
  parseBlacklist,
  validateSettingsForm,
} from './settings-form';

function form(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, blacklist: [], ...over };
}

describe('validateSettingsForm — 合法输入', () => {
  it('默认设置就是合法的', () => {
    expect(validateSettingsForm(DEFAULT_SETTINGS)).toEqual({});
  });

  it('边界值合法', () => {
    expect(validateSettingsForm(form({ underlineThickness: 0.5 }))).toEqual({});
    expect(validateSettingsForm(form({ underlineThickness: 4 }))).toEqual({});
    expect(validateSettingsForm(form({ minWordLength: 1 }))).toEqual({});
    expect(validateSettingsForm(form({ minWordLength: 20 }))).toEqual({});
  });
});

describe('validateSettingsForm — 数值范围', () => {
  it('线宽越界报错', () => {
    expect(hasErrors(validateSettingsForm(form({ underlineThickness: 0 })))).toBe(true);
    expect(hasErrors(validateSettingsForm(form({ underlineThickness: 99 })))).toBe(true);
    expect(hasErrors(validateSettingsForm(form({ underlineThickness: Number.NaN })))).toBe(true);
  });

  it('最短词长必须是范围内的整数', () => {
    expect(hasErrors(validateSettingsForm(form({ minWordLength: 0 })))).toBe(true);
    expect(hasErrors(validateSettingsForm(form({ minWordLength: 2.5 })))).toBe(true);
    expect(hasErrors(validateSettingsForm(form({ minWordLength: 999 })))).toBe(true);
  });

  it('每页条数必须是范围内的整数', () => {
    const base = DEFAULT_SETTINGS.ui;
    expect(hasErrors(validateSettingsForm(form({ ui: { ...base, pageSize: 5 } })))).toBe(true);
    expect(hasErrors(validateSettingsForm(form({ ui: { ...base, pageSize: 10_000 } })))).toBe(true);
  });

  it('FR-I2：发音语速必须在范围内', () => {
    expect(validateSettingsForm(form({ speechRate: MIN_RATE }))).toEqual({});
    expect(validateSettingsForm(form({ speechRate: MAX_RATE }))).toEqual({});
    expect(validateSettingsForm(form({ speechRate: 1.5 }))).toEqual({});

    expect(hasErrors(validateSettingsForm(form({ speechRate: MIN_RATE - 0.1 })))).toBe(true);
    expect(hasErrors(validateSettingsForm(form({ speechRate: MAX_RATE + 0.5 })))).toBe(true);
    expect(hasErrors(validateSettingsForm(form({ speechRate: Number.NaN })))).toBe(true);
    expect(validateSettingsForm(form({ speechRate: 0 })).speechRate).toMatch(/发音语速/);
  });

  /**
   * 表单的上限与运行时的钳制**必须同源**。
   *
   * 两边各写一套数字的话，会变成"设置页允许 3，实际朗读还是 2"——
   * 用户看不出原因，也不会报错。
   */
  it('表单边界与运行时钳制同源（同一组常量）', () => {
    expect(safeRate(MIN_RATE)).toBe(MIN_RATE);
    expect(safeRate(MAX_RATE)).toBe(MAX_RATE);
    expect(validateSettingsForm(form({ speechRate: MAX_RATE }))).toEqual({});
    // 超过上限的值：表单拒绝（不让保存），钳制函数则把它压到上限
    expect(hasErrors(validateSettingsForm(form({ speechRate: MAX_RATE * 2 })))).toBe(true);
    expect(safeRate(MAX_RATE * 2)).toBe(MAX_RATE);
  });
});

describe('validateSettingsForm — 颜色', () => {
  it('接受 #rgb 与 #rrggbb', () => {
    expect(validateSettingsForm(form({ underlineColor: '#fff' }))).toEqual({});
    expect(validateSettingsForm(form({ underlineColor: '#FF00aa' }))).toEqual({});
  });

  it('拒绝非法颜色（写进 CSS 变量会让整条声明失效，表现是下划线突然全没了）', () => {
    for (const bad of ['red', '#12', '#12345', 'rgb(1,2,3)', '']) {
      expect(hasErrors(validateSettingsForm(form({ underlineColor: bad })))).toBe(true);
    }
  });
});

describe('validateSettingsForm — 枚举取值', () => {
  it('非法枚举被抓出', () => {
    // 运行时可能收到旧版本残留或手改的值（类型系统管不到运行时输入）
    expect(hasErrors(validateSettingsForm(form({ underlineStyle: 'zigzag' as never })))).toBe(true);
    expect(hasErrors(validateSettingsForm(form({ trigger: 'hover' as never })))).toBe(true);
    // 早期版本的引擎取值，必须被拒
    expect(
      hasErrors(
        validateSettingsForm(form({ translation: { ...DEFAULT_SETTINGS.translation, engine: 'browser' as never } })),
      ),
    ).toBe(true);
  });

  it('白名单与 types.ts 的类型定义一致（逐字核对）', () => {
    // 这几条锁住"校验白名单 == 类型定义"，防止有人只改一边
    expect(validateSettingsForm(form({ underlineStyle: 'none' }))).toEqual({});
    expect(validateSettingsForm(form({ trigger: 'click' }))).toEqual({});
    expect(validateSettingsForm(form({ ui: { ...DEFAULT_SETTINGS.ui, language: 'en' } }))).toEqual({});
    expect(validateSettingsForm(form({ ui: { ...DEFAULT_SETTINGS.ui, theme: 'dark' } }))).toEqual({});
    expect(validateSettingsForm(form({ ui: { ...DEFAULT_SETTINGS.ui, theme: 'auto' } }))).toEqual({});
  });
});

describe('validateSettingsForm — 翻译配置', () => {
  it('默认设置合法：默认引擎不需要任何配置', () => {
    // 这条防的是一个真实缺陷：默认曾指向 'llm' 却把 llm 配成 null，
    // 于是"默认设置不合法"，翻译静默不工作
    expect(DEFAULT_SETTINGS.translation.engine).toBe('chrome-builtin');
    expect(validateSettingsForm(DEFAULT_SETTINGS)).toEqual({});
  });

  it('不启用 LLM 时就不要求填 key', () => {
    expect(
      validateSettingsForm(
        form({ translation: { ...DEFAULT_SETTINGS.translation, engine: 'chrome-builtin' } }),
      ),
    ).toEqual({});
  });

  it('启用 LLM 但没填地址/key → 报错（这是最常见的静默失败）', () => {
    const errors = validateSettingsForm(
      form({ translation: { ...DEFAULT_SETTINGS.translation, engine: 'llm', llm: null } }),
    );
    expect(errors.llmBaseUrl).toBeDefined();
    expect(errors.llmApiKey).toBeDefined();
  });

  it('启用 LLM 且配置齐全 → 通过', () => {
    const errors = validateSettingsForm(
      form({
        translation: {
          ...DEFAULT_SETTINGS.translation,
          engine: 'llm',
          llm: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', model: 'm' },
        },
      }),
    );
    expect(errors).toEqual({});
  });

  it('LLM 地址不是 http(s) → 报错', () => {
    const errors = validateSettingsForm(
      form({
        translation: {
          ...DEFAULT_SETTINGS.translation,
          engine: 'llm',
          llm: { baseUrl: 'ftp://x', apiKey: 'k', model: 'm' },
        },
      }),
    );
    expect(errors.llmBaseUrl).toBeDefined();
  });

  it('启用自建接口但地址非法 → 报错', () => {
    const errors = validateSettingsForm(
      form({ translation: { ...DEFAULT_SETTINGS.translation, engine: 'api', api: null } }),
    );
    expect(errors.apiUrl).toBeDefined();
  });

  it('空的目标语言报错', () => {
    const errors = validateSettingsForm(
      form({ translation: { ...DEFAULT_SETTINGS.translation, targetLang: '   ' } }),
    );
    expect(errors.targetLang).toBeDefined();
  });
});

describe('isValidDomainEntry（黑名单条目）', () => {
  it('接受裸域名后缀', () => {
    expect(isValidDomainEntry('example.com')).toBe(true);
    expect(isValidDomainEntry('sub.example.co.uk')).toBe(true);
  });

  it('两端空白被忽略', () => {
    expect(isValidDomainEntry('  example.com  ')).toBe(true);
  });

  it('拒绝带协议/路径/通配符的写法', () => {
    // 项目用的是后缀匹配；允许这些写法会让匹配永远失败且用户看不出原因
    for (const bad of ['https://example.com', 'example.com/*', '*example.com', 'example.com/path', '']) {
      expect(isValidDomainEntry(bad)).toBe(false);
    }
  });

  it('拒绝没有点的单词', () => {
    expect(isValidDomainEntry('localhost')).toBe(false);
  });
});

describe('validateSettingsForm — 黑名单', () => {
  it('有非法条目时报错并列出它们', () => {
    const errors = validateSettingsForm(form({ blacklist: ['ok.com', 'https://bad.com'] }));
    expect(errors.blacklist).toContain('https://bad.com');
  });

  it('全部合法时通过', () => {
    expect(validateSettingsForm(form({ blacklist: ['a.com', 'b.org'] }))).toEqual({});
  });

  it('空黑名单合法', () => {
    expect(validateSettingsForm(form({ blacklist: [] }))).toEqual({});
  });
});

describe('parseBlacklist', () => {
  it('按行拆、去空白、去空行', () => {
    expect(parseBlacklist('  a.com \n\n  b.com  \n')).toEqual(['a.com', 'b.com']);
  });

  it('去重', () => {
    // 重复项会让"删除某一项"的界面逻辑删不干净
    expect(parseBlacklist('a.com\na.com\nb.com')).toEqual(['a.com', 'b.com']);
  });

  it('排序，保证同一输入两次解析结果一致', () => {
    expect(parseBlacklist('z.com\na.com\nm.com')).toEqual(['a.com', 'm.com', 'z.com']);
  });

  it('兼容 CRLF', () => {
    expect(parseBlacklist('a.com\r\nb.com')).toEqual(['a.com', 'b.com']);
  });

  it('空输入返回空数组', () => {
    expect(parseBlacklist('')).toEqual([]);
    expect(parseBlacklist('\n\n  \n')).toEqual([]);
  });
});

describe('formatBlacklist', () => {
  it('按行输出，可被 parseBlacklist 还原', () => {
    const domains = ['a.com', 'b.com'];
    expect(parseBlacklist(formatBlacklist(domains))).toEqual(domains);
  });
});

describe('applyForm', () => {
  it('覆盖界面暴露的字段', () => {
    const current = DEFAULT_SETTINGS;
    const next = applyForm(current, form({ enabled: false, minWordLength: 3 }));

    expect(next.enabled).toBe(false);
    expect(next.minWordLength).toBe(3);
  });

  it('FR-I2：语速是界面暴露的字段，保存时必须带上（漏了就是"改了没用"）', () => {
    const next = applyForm(DEFAULT_SETTINGS, form({ speechRate: 0.8 }));
    expect(next.speechRate).toBe(0.8);
  });

  it('持久化界面暴露的 WebDAV 全字段', () => {
    const webdav = {
      url: 'http://localhost:8080/dav/',
      username: 'new-user',
      password: 'new-password',
      path: '/new/sync.json',
      passphrase: 'new-passphrase',
      syncIntervalMinutes: 30,
    };
    const next = applyForm(DEFAULT_SETTINGS, form({ webdav }));
    expect(next.webdav).toEqual(webdav);
  });

  it('持久化界面暴露的 translation.limits 三项上限', () => {
    const limits = { dailyLimit: 17, batchSize: 4, concurrency: 3 };
    const formWithLimits = form({
      translation: { ...DEFAULT_SETTINGS.translation, limits },
    });

    const next = applyForm(DEFAULT_SETTINGS, formWithLimits);
    expect(next.translation.limits).toEqual(limits);
  });

  it('保留 ui 里未暴露的字段', () => {
    const current: Settings = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, pageSize: 50 } };
    expect(applyForm(current, form()).ui.pageSize).toBe(50);
  });

  it('不修改入参', () => {
    const current = DEFAULT_SETTINGS;
    const snapshot = JSON.stringify(current);
    applyForm(current, form({ enabled: false }));
    expect(JSON.stringify(current)).toBe(snapshot);
  });
});

describe('FR-D5：翻译成本控制三项可配', () => {
  const base = (patch: Partial<Settings['translation']['limits']>) => ({
    ...DEFAULT_SETTINGS,
    translation: {
      ...DEFAULT_SETTINGS.translation,
      limits: { ...DEFAULT_SETTINGS.translation.limits, ...patch },
    },
  });

  it('默认值合法', () => {
    expect(validateSettingsForm(base({}))).toEqual({});
  });

  it('越界或非整数都要报错（不悄悄钳制）', () => {
    expect(validateSettingsForm(base({ batchSize: 0 })).limits).toBeTruthy();
    expect(validateSettingsForm(base({ batchSize: 999 })).limits).toBeTruthy();
    expect(validateSettingsForm(base({ concurrency: 99 })).limits).toBeTruthy();
    expect(validateSettingsForm(base({ dailyLimit: -1 })).limits).toBeTruthy();
    expect(validateSettingsForm(base({ batchSize: 1.5 })).limits).toBeTruthy();
  });

  it('每日上限填 0 是合法的（表示暂停翻译）', () => {
    expect(validateSettingsForm(base({ dailyLimit: 0 }))).toEqual({});
  });

  it('边界值本身合法', () => {
    expect(validateSettingsForm(base({ batchSize: 1, concurrency: 8, dailyLimit: 100000 }))).toEqual({});
  });

  it('报错文案说得清是哪一项（用户能照着改）', () => {
    const message = validateSettingsForm(base({ batchSize: 999 })).limits;
    expect(message).toContain('单批条数');
  });
});
