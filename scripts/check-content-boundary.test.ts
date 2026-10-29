/**
 * 内容脚本边界门禁的**自身**测试。
 *
 * ## 为什么要测一个门禁
 *
 * `scripts/check-content-boundary.ts` 是防回归用的：它一旦失灵，
 * **表现是"永远通过"**——比没有门禁更危险，因为团队会以为有保护。
 * 这跟 `CONSTRAINTS.md` 第 13 条记的那类失败是同一个形态：不报错、只是不工作。
 *
 * 所以这里测两件最容易写错的事：
 * 1. `stripNonCode` 剥注释/字符串是否到位（漏剥 → 把文档判成违规，
 *    门禁会逼人删掉有价值的注释；多剥 → 漏掉真违规）
 * 2. 特征正则是否真的能命中各类写法
 */
import { describe, expect, it } from 'vitest';
import { stripNonCode } from './check-content-boundary';

describe('stripNonCode', () => {
  it('剥掉行注释', () => {
    const out = stripNonCode('const a = 1; // 这里有 indexedDB\nconst b = 2;');
    expect(out).not.toContain('indexedDB');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
  });

  it('剥掉块注释（含中文与星号装饰）', () => {
    const out = stripNonCode('/**\n * 不要用 localStorage 存东西\n */\nconst a = 1;');
    expect(out).not.toContain('localStorage');
    expect(out).toContain('const a = 1;');
  });

  it('剥掉单引号、双引号、模板串里的内容', () => {
    expect(stripNonCode("const s = 'indexedDB';")).not.toContain('indexedDB');
    expect(stripNonCode('const s = "chrome.storage";')).not.toContain('chrome.storage');
    expect(stripNonCode('const s = `localStorage`;')).not.toContain('localStorage');
  });

  it('保留真正的可执行引用', () => {
    expect(stripNonCode('const db = indexedDB.open("x");')).toContain('indexedDB');
    expect(stripNonCode('window.localStorage.getItem("k");')).toContain('localStorage');
  });

  it('行号不漂移（注释占位等长替换）', () => {
    const src = '// 第一行\n// 第二行\nconst target = indexedDB;';
    const out = stripNonCode(src);
    const line = out.slice(0, out.indexOf('indexedDB')).split('\n').length;
    // 原文里 indexedDB 在第 3 行；剥注释后必须仍是第 3 行，
    // 否则报错信息会指到错误的行
    expect(line).toBe(3);
  });

  it('剥掉注释里的引号不会吃掉后面的代码', () => {
    // 这是最容易写错的情形：注释里有个不成对的引号
    const out = stripNonCode("// 别写 it's 这种\nconst a = indexedDB;");
    expect(out).toContain('const a = indexedDB;');
  });

  it('字符串里的转义引号不会提前结束字符串', () => {
    const out = stripNonCode("const s = 'it\\'s localStorage';\nconst a = 1;");
    expect(out).not.toContain('localStorage');
    expect(out).toContain('const a = 1;');
  });
});

describe('特征正则的覆盖面', () => {
  // 门禁里用的模式，这里逐条验证"能命中"与"不误伤"
  const patterns: [RegExp, string][] = [
    [/\bindexedDB\b/, 'indexedDB'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\bsessionStorage\b/, 'sessionStorage'],
    [/\bchrome\.storage\b/, 'chrome.storage'],
    [/\bbrowser\.storage\b/, 'browser.storage'],
  ];

  it('命中裸调用与带前缀的调用', () => {
    for (const [pattern, label] of patterns) {
      expect(pattern.test(`const x = ${label};`), `${label} 裸调用应命中`).toBe(true);
      expect(pattern.test(`const x = window.${label};`), `${label} 带前缀应命中`).toBe(true);
    }
  });

  it('不误伤同名子串', () => {
    expect(/\bindexedDB\b/.test('myIndexedDBThing')).toBe(false);
    expect(/\blocalStorage\b/.test('localStorageCache')).toBe(false);
  });

  it('chrome.storage 的点号不必转义成通配', () => {
    // 若写成 /chrome.storage/，`.` 会匹配任意字符，
    // "chromeXstorage" 也会命中——这是典型的正则写松
    expect(/\bchrome\.storage\b/.test('chromeXstorage')).toBe(false);
    expect(/\bchrome\.storage\b/.test('chrome.storage')).toBe(true);
  });
});
