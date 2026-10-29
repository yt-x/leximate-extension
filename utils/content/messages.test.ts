/**
 * 消息协议的单测。
 *
 * 重点在**输入清洗**：内容脚本的消息按官方安全提示是不可信输入
 * （`docs/reference/extension-storage-and-messaging.md` §4），
 * 所以每个洗函数都要有自己的用例。
 */
import { describe, expect, it } from 'vitest';
import {
  isContentRequest,
  MAX_FETCH_WORDS,
  MSG,
  sanitizeStatus,
  sanitizeWord,
  sanitizeWords,
} from './messages';

describe('MSG', () => {
  it('全部带命名空间前缀', () => {
    for (const value of Object.values(MSG)) {
      expect(value.startsWith('leximate:')).toBe(true);
    }
  });

  it('各类型互不相同', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('sanitizeWords', () => {
  it('非数组返回空', () => {
    expect(sanitizeWords(undefined)).toEqual([]);
    expect(sanitizeWords(null)).toEqual([]);
    expect(sanitizeWords('run')).toEqual([]);
    expect(sanitizeWords({ 0: 'run' })).toEqual([]);
  });

  it('丢掉非字符串项与空串', () => {
    expect(sanitizeWords(['run', 42, null, '', '  ', {}, 'go'])).toEqual(['run', 'go']);
  });

  it('去重并小写、去首尾空白', () => {
    expect(sanitizeWords(['Run', ' run ', 'RUN', 'go'])).toEqual(['run', 'go']);
  });

  it('限长，防止畸形请求让后台做上万次查询', () => {
    const many = Array.from({ length: MAX_FETCH_WORDS + 100 }, (_, i) => `w${i}`);
    expect(sanitizeWords(many)).toHaveLength(MAX_FETCH_WORDS);
  });

  it('空数组返回空', () => {
    expect(sanitizeWords([])).toEqual([]);
  });
});

describe('sanitizeWord', () => {
  it('正常单词小写去空白', () => {
    expect(sanitizeWord('  Run ')).toBe('run');
  });

  it('非字符串或空串返回 null', () => {
    expect(sanitizeWord(undefined)).toBeNull();
    expect(sanitizeWord(42)).toBeNull();
    expect(sanitizeWord('')).toBeNull();
    expect(sanitizeWord('   ')).toBeNull();
    expect(sanitizeWord(null)).toBeNull();
  });
});

describe('sanitizeStatus', () => {
  it('只接受三个合法值', () => {
    expect(sanitizeStatus('new')).toBe('new');
    expect(sanitizeStatus('known')).toBe('known');
    expect(sanitizeStatus('ignored')).toBe('ignored');
  });

  it('非法值返回 null，不猜也不给默认', () => {
    // 默认成 'new' 会让"改状态"失败时静默变成"标成生词"，
    // 那是错误的用户可见结果
    expect(sanitizeStatus('KNOWN')).toBeNull();
    expect(sanitizeStatus('deleted')).toBeNull();
    expect(sanitizeStatus(undefined)).toBeNull();
    expect(sanitizeStatus(3)).toBeNull();
  });
});

describe('isContentRequest', () => {
  it('认四种请求类型', () => {
    expect(isContentRequest({ type: MSG.fetchStates })).toBe(true);
    expect(isContentRequest({ type: MSG.recordMeet })).toBe(true);
    expect(isContentRequest({ type: MSG.setStatus })).toBe(true);
    expect(isContentRequest({ type: MSG.getSettings })).toBe(true);
  });

  it('不认反方向的通知（那是后台发给内容脚本的）', () => {
    expect(isContentRequest({ type: MSG.settingsChanged })).toBe(false);
  });

  it('不认畸形输入', () => {
    expect(isContentRequest(null)).toBe(false);
    expect(isContentRequest(undefined)).toBe(false);
    expect(isContentRequest('leximate:get-settings')).toBe(false);
    expect(isContentRequest({})).toBe(false);
    // 别的扩展的同形消息不该被我们接走
    expect(isContentRequest({ type: 'other-extension:do-something' })).toBe(false);
  });
});
