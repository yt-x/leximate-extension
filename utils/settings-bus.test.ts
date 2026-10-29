/**
 * 设置写入通知钩子的单测。
 *
 * 这个模块的**两版前身都是错的**（`storage.onChanged` 收不到 IndexedDB 写入；
 * `runtime.sendMessage` 到不了内容脚本），所以用例重点在
 * "只做进程内通知"这条边界，以及监听器抛错不影响写库。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notifySettingsWritten,
  onSettingsWritten,
  resetSettingsListeners,
} from './settings-bus';

afterEach(() => {
  // 模块级 Set 会跨用例存活，必须清，否则后面的用例会收到前面注册的监听器
  resetSettingsListeners();
});

describe('onSettingsWritten / notifySettingsWritten', () => {
  it('写入通知会调用订阅者', () => {
    const handler = vi.fn();
    onSettingsWritten(handler);

    notifySettingsWritten();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('多个订阅者都收到', () => {
    const a = vi.fn();
    const b = vi.fn();
    onSettingsWritten(a);
    onSettingsWritten(b);

    notifySettingsWritten();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('退订后不再收到', () => {
    const handler = vi.fn();
    const off = onSettingsWritten(handler);

    notifySettingsWritten();
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    notifySettingsWritten();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('一个监听器抛错不影响其它监听器，也不上抛', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    onSettingsWritten(bad);
    onSettingsWritten(good);

    // 不能让 setSettings 因为某个监听器出错而失败——写库已经成功了
    expect(() => notifySettingsWritten()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('没有订阅者时通知是空操作', () => {
    expect(() => notifySettingsWritten()).not.toThrow();
  });

  it('同一函数注册两次只算一个（Set 语义），退订一次即全退', () => {
    const handler = vi.fn();
    onSettingsWritten(handler);
    const off = onSettingsWritten(handler);

    notifySettingsWritten();
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    notifySettingsWritten();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('resetSettingsListeners', () => {
  it('清空全部订阅者', () => {
    const handler = vi.fn();
    onSettingsWritten(handler);
    resetSettingsListeners();

    notifySettingsWritten();
    expect(handler).not.toHaveBeenCalled();
  });
});
