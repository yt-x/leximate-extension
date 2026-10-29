/**
 * 管理台文案的判定与查找（PLAN.md FR-L1，口径见 `decisions/0026`）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MESSAGES, keysOf, getLocale, resolveLocale, setLocale, t } from './index';

afterEach(() => {
  // 模块级状态：用例之间必须复位，否则顺序会互相影响
  setLocale('zh-CN');
});

describe('FR-L1：语言解析', () => {
  it('显式值优先于浏览器语言', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });

  it("默认 auto：浏览器语言以 en 开头才英文", () => {
    expect(resolveLocale('auto', 'en-US')).toBe('en');
    expect(resolveLocale('auto', 'en')).toBe('en');
    expect(resolveLocale('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('auto', 'ja-JP')).toBe('zh-CN');
  });

  it('拿不到浏览器语言（测试环境就是这样）时兜底中文', () => {
    expect(resolveLocale('auto', undefined)).toBe('zh-CN');
    expect(resolveLocale('auto', null)).toBe('zh-CN');
    expect(resolveLocale(undefined, undefined)).toBe('zh-CN');
  });
});

describe('FR-L1：取文案', () => {
  it('默认中文', () => {
    expect(getLocale()).toBe('zh-CN');
    expect(t('tab.words')).toBe('生词');
  });

  it('切到英文后取英文', () => {
    setLocale('en');
    expect(t('tab.words')).toBe('Words');
    expect(t('tab.diag')).toBe('Diagnostics');
  });

  it('占位符按参数填充', () => {
    expect(t('app.tagline', { version: '0.1.0' })).toContain('0.1.0');
    setLocale('en');
    expect(t('app.tagline', { version: '9.9.9' })).toContain('9.9.9');
  });

  it('缺 key 时退到中文，再退到 key 本身（缺文案可见但不致命）', () => {
    setLocale('en');
    expect(t('only.in.zh')).toBe('only.in.zh');
  });
});

describe('FR-L1：两种语言的 key 必须一一对应（"无缺失文案"的可断言形式）', () => {
  it('键集合完全一致', () => {
    expect(keysOf('en')).toEqual(keysOf('zh-CN'));
  });

  it('每条文案都非空', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const key of keysOf(locale)) {
        expect(MESSAGES[locale][key]?.trim(), `${locale} 的 ${key}`).not.toBe('');
      }
    }
  });
});
