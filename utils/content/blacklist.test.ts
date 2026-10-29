/**
 * 站点黑名单单测（PLAN.md FR-A13）。
 *
 * 验收判定是「黑名单站点零注入、零标注」。这里锁住匹配语义——
 * 语义错了，"零注入"就会作用在错误的站点上（该挡的没挡，或把正常站点挡了）。
 */
import { describe, expect, it } from 'vitest';
import { isBlacklisted, matchedRule, normalizeRule } from './blacklist';

describe('FR-A13：精确域名匹配自己与子域', () => {
  it('命中根域与任意层级子域', () => {
    expect(isBlacklisted('example.com', ['example.com'])).toBe(true);
    expect(isBlacklisted('www.example.com', ['example.com'])).toBe(true);
    expect(isBlacklisted('a.b.example.com', ['example.com'])).toBe(true);
  });

  it('不误伤同后缀的其它域名', () => {
    // notexample.com 不以 ".example.com" 结尾，不该命中
    expect(isBlacklisted('notexample.com', ['example.com'])).toBe(false);
    expect(isBlacklisted('example.com.evil.net', ['example.com'])).toBe(false);
  });

  it('不命中父域', () => {
    expect(isBlacklisted('com', ['example.com'])).toBe(false);
    expect(isBlacklisted('sub.example.com', ['deep.sub.example.com'])).toBe(false);
  });
});

describe('FR-A13：通配只匹配子域，不含根域', () => {
  it('*.example.com 命中子域', () => {
    expect(isBlacklisted('www.example.com', ['*.example.com'])).toBe(true);
    expect(isBlacklisted('a.b.example.com', ['*.example.com'])).toBe(true);
  });

  it('*.example.com 不命中根域（与精确写法语义不同）', () => {
    expect(isBlacklisted('example.com', ['*.example.com'])).toBe(false);
  });
});

describe('FR-A13：大小写不敏感与输入容错', () => {
  it('大小写不敏感（两侧都是）', () => {
    expect(isBlacklisted('WWW.Example.COM', ['example.com'])).toBe(true);
    expect(isBlacklisted('www.example.com', ['Example.Com'])).toBe(true);
  });

  it('规则里粘了协议或路径也能用', () => {
    expect(normalizeRule('https://example.com/some/path')).toBe('example.com');
    expect(normalizeRule('http://Example.COM:8080/x?y=1')).toBe('example.com:8080');
    expect(isBlacklisted('www.example.com', ['https://example.com/a/b'])).toBe(true);
  });

  it('列表为空的边界', () => {
    expect(isBlacklisted('example.com', [])).toBe(false);
    expect(isBlacklisted('', ['example.com'])).toBe(false);
    expect(isBlacklisted('example.com', ['', '   '])).toBe(false);
  });

  it('多条规则里命中任意一条即拦', () => {
    const rules = ['a.com', '*.b.com', 'c.org'];
    expect(isBlacklisted('sub.b.com', rules)).toBe(true);
    expect(isBlacklisted('c.org', rules)).toBe(true);
    expect(isBlacklisted('d.net', rules)).toBe(false);
  });
});

describe('FR-A13：诊断用 matchedRule', () => {
  it('给出命中的那一条，便于日志写明被哪条挡了', () => {
    expect(matchedRule('www.example.com', ['a.com', 'example.com'])).toBe('example.com');
    expect(matchedRule('www.example.com', ['a.com'])).toBeNull();
  });
});
