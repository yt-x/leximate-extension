/**
 * 诊断日志的纯逻辑（PLAN.md FR-L4）：级别映射与输入清洗。
 *
 * 这一层与 `log.ts` 分开，是因为**内容脚本也要用它**
 * （`controller.ts` 给每个事件定级别），而内容脚本不能碰 IndexedDB。
 * 分开之后内容脚本只 import 本文件——`scripts/check-content-boundary.ts`
 * 的 `treeShakenReliance` 因此为空，不再依赖打包器"顺手"把存储层摇掉。
 */
import { describe, expect, it } from 'vitest';
import {
  cleanText,
  contentLogLevel,
  isLogLevel,
  MAX_DETAIL_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_SCOPE_LENGTH,
  sanitizeDetail,
} from './levels';

describe('级别映射', () => {
  it('内容脚本的事件名映射成级别：页面动作是信息，其它是调试', () => {
    expect(contentLogLevel('content-started')).toBe('info');
    expect(contentLogLevel('content-skipped')).toBe('info');
    expect(contentLogLevel('word-collected')).toBe('info');
    expect(contentLogLevel('status-changed')).toBe('info');
    expect(contentLogLevel('popup-shown')).toBe('debug');
    // 将来加的事件名默认是 debug，不会意外变成噪音
    expect(contentLogLevel('something-new')).toBe('debug');
  });

  it('isLogLevel 只认四个级别', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) expect(isLogLevel(level)).toBe(true);
    expect(isLogLevel('fatal')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel(3)).toBe(false);
  });
});

describe('sanitizeDetail：可克隆、可导出', () => {
  it('函数与 undefined 被丢掉，正常值原样保留', () => {
    expect(sanitizeDetail({ a: 1, fn: () => {} })).toEqual({ a: 1 });
    expect(sanitizeDetail(undefined)).toBeNull();
    expect(sanitizeDetail(null)).toBeNull();
    expect(sanitizeDetail('text')).toBe('text');
    expect(sanitizeDetail(5)).toBe(5);
  });

  it('返回的是 JSON 往返后的值，不含不可克隆的东西', () => {
    // IndexedDB 用结构化克隆存值，函数不可克隆：把原对象存进去会抛 DataCloneError
    const cleaned = sanitizeDetail({ nested: { cb: () => {}, ok: true } });
    expect(cleaned).toEqual({ nested: { ok: true } });
    expect(JSON.parse(JSON.stringify(cleaned))).toEqual(cleaned);
  });

  it('循环引用不会抛错（诊断不该成为故障源）', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(sanitizeDetail(cyclic)).toBe('(detail 无法序列化)');
  });

  it('bigint 转成字符串（JSON 不认识它）', () => {
    expect(sanitizeDetail({ n: 10n })).toEqual({ n: '10' });
  });

  it('过大时截断成字符串（保留开头够定位问题）', () => {
    const cleaned = sanitizeDetail({ blob: 'z'.repeat(MAX_DETAIL_LENGTH * 2) });

    expect(typeof cleaned).toBe('string');
    expect((cleaned as string).length).toBe(MAX_DETAIL_LENGTH + 1); // 含结尾的省略号
  });
});

describe('cleanText：字段的统一处理', () => {
  it('非字符串 / 空白给兜底值', () => {
    expect(cleanText(undefined, 10, 'unknown')).toBe('unknown');
    expect(cleanText('   ', 10, 'unknown')).toBe('unknown');
    expect(cleanText(42, 10, 'unknown')).toBe('unknown');
  });

  it('过长截断并加省略号', () => {
    expect(cleanText('a'.repeat(MAX_SCOPE_LENGTH + 5), MAX_SCOPE_LENGTH, 'x')).toHaveLength(
      MAX_SCOPE_LENGTH + 1,
    );
    expect(cleanText('ok', MAX_MESSAGE_LENGTH, 'x')).toBe('ok');
  });

  it('两端空白被去掉', () => {
    expect(cleanText('  hello  ', 20, 'x')).toBe('hello');
  });
});
