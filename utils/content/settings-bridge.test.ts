/**
 * 设置桥接的单测（PLAN.md FR-A11、FR-A13、FR-A14）。
 *
 * 重点在**校验**：设置存在 storage 里，可能被旧版本写坏或被手改，
 * 渲染前必须挡掉非法值，否则页面会拿到非法 CSS（甚至 `100px` 把页面糊掉）。
 */
import { describe, expect, it } from 'vitest';
import { isBlacklisted } from './blacklist';
import {
  FALLBACK_COLOR,
  MAX_THICKNESS,
  MIN_THICKNESS,
  planSettingsChange,
  shouldRunOn,
  themeFromSettings,
} from './settings-bridge';

const base = {
  underlineStyle: 'dotted' as const,
  underlineColor: '#d98b2b',
  underlineThickness: 1,
  reflectMeetCount: false,
};

describe('FR-A11：设置 → 主题', () => {
  it('正常值直接透传', () => {
    expect(themeFromSettings(base)).toEqual({
      style: 'dotted',
      color: '#d98b2b',
      thickness: 1,
      reflectMeetCount: false,
    });
  });

  it('四种线型都被接受', () => {
    for (const style of ['dotted', 'solid', 'wavy', 'none'] as const) {
      expect(themeFromSettings({ ...base, underlineStyle: style }).style).toBe(style);
    }
  });

  it('非法线型退回 dotted', () => {
    expect(themeFromSettings({ ...base, underlineStyle: 'double' as never }).style).toBe('dotted');
    expect(themeFromSettings({ ...base, underlineStyle: undefined as never }).style).toBe('dotted');
  });

  it('线宽被夹在合法区间', () => {
    expect(themeFromSettings({ ...base, underlineThickness: 0 }).thickness).toBe(MIN_THICKNESS);
    expect(themeFromSettings({ ...base, underlineThickness: -5 }).thickness).toBe(MIN_THICKNESS);
    // 上限不是技术限制，是防止 100px 糊掉页面
    expect(themeFromSettings({ ...base, underlineThickness: 100 }).thickness).toBe(MAX_THICKNESS);
    expect(themeFromSettings({ ...base, underlineThickness: 2.5 }).thickness).toBe(2.5);
  });

  it('线宽是非法数字时退回最小值', () => {
    expect(themeFromSettings({ ...base, underlineThickness: Number.NaN }).thickness).toBe(MIN_THICKNESS);
    expect(themeFromSettings({ ...base, underlineThickness: 'abc' as never }).thickness).toBe(MIN_THICKNESS);
    // Infinity 不是"很大的数"而是垃圾值，因此退回最小值而非上限
    expect(themeFromSettings({ ...base, underlineThickness: Infinity }).thickness).toBe(MIN_THICKNESS);
    expect(themeFromSettings({ ...base, underlineThickness: -Infinity }).thickness).toBe(MIN_THICKNESS);
    // 真正的"太大"才会被夹到上限
    expect(themeFromSettings({ ...base, underlineThickness: 1e6 }).thickness).toBe(MAX_THICKNESS);
  });

  it('颜色只接受十六进制，其它退回默认', () => {
    expect(themeFromSettings({ ...base, underlineColor: '#f00' }).color).toBe('#f00');
    expect(themeFromSettings({ ...base, underlineColor: '#FF0000' }).color).toBe('#FF0000');
    // 这些能用于 CSS 注入，必须挡掉
    expect(themeFromSettings({ ...base, underlineColor: 'red' }).color).toBe(FALLBACK_COLOR);
    expect(themeFromSettings({ ...base, underlineColor: 'url(evil)' }).color).toBe(FALLBACK_COLOR);
    expect(themeFromSettings({ ...base, underlineColor: '#12345' }).color).toBe(FALLBACK_COLOR);
  });

  it('reflectMeetCount 只认 true', () => {
    expect(themeFromSettings({ ...base, reflectMeetCount: true }).reflectMeetCount).toBe(true);
    expect(themeFromSettings({ ...base, reflectMeetCount: 'yes' as never }).reflectMeetCount).toBe(false);
  });
});

describe('FR-A13 + FR-A14：要不要在这个站点干活', () => {
  const settings = { enabled: true, blacklist: [] as string[] };

  it('开关打开且不在黑名单 → 干活', () => {
    expect(shouldRunOn(settings, 'example.com', isBlacklisted)).toBe(true);
  });

  it('FR-A14：开关关闭 → 一律不干（黑名单无关）', () => {
    expect(shouldRunOn({ ...settings, enabled: false }, 'example.com', isBlacklisted)).toBe(false);
  });

  it('FR-A13：命中黑名单 → 不干', () => {
    expect(
      shouldRunOn({ ...settings, blacklist: ['example.com'] }, 'www.example.com', isBlacklisted),
    ).toBe(false);
  });

  it('通配规则也生效', () => {
    expect(
      shouldRunOn({ ...settings, blacklist: ['*.example.com'] }, 'www.example.com', isBlacklisted),
    ).toBe(false);
  });

  it('黑名单里的站点即使开关打开也不干', () => {
    // 两个条件都要满足，缺一不可
    expect(
      shouldRunOn({ enabled: true, blacklist: ['blocked.com'] }, 'blocked.com', isBlacklisted),
    ).toBe(false);
  });

  it('blacklist 缺失时不崩（旧版本数据）', () => {
    expect(shouldRunOn({ enabled: true } as never, 'example.com', isBlacklisted)).toBe(true);
  });
});

/**
 * 收到 `settings-changed` 后的动作计划（FR-A14 的开关联动 + FR-I2 的语速）。
 *
 * 这段判定原先内联在 `entrypoints/content.ts` 的消息监听里，而入口模块没有单测
 * （import 它就会注册内容脚本）。抽出来的直接收益：**四种开关组合 + 语速传递**
 * 都能断言，而不是靠读码确认。
 */
describe('FR-A14 + FR-I2：设置变更要做的事', () => {
  const next = (over: Partial<{ enabled: boolean; speechRate: number }> = {}) => ({
    enabled: true,
    speechRate: 1,
    ...over,
  });

  it('正在跑 + 已关闭 → 停', () => {
    expect(planSettingsChange(true, next({ enabled: false }))).toMatchObject({
      stop: true,
      start: false,
    });
  });

  it('没在跑 + 已开启 → 起', () => {
    expect(planSettingsChange(false, next({ enabled: true }))).toMatchObject({
      stop: false,
      start: true,
    });
  });

  it('状态没变 → 既不停也不起（别把已画好的下划线重扫一遍）', () => {
    expect(planSettingsChange(true, next())).toMatchObject({ stop: false, start: false });
    expect(planSettingsChange(false, next({ enabled: false }))).toMatchObject({
      stop: false,
      start: false,
    });
  });

  it('FR-I2：语速在四种组合里都要带上', () => {
    for (const running of [true, false]) {
      for (const enabled of [true, false]) {
        expect(planSettingsChange(running, next({ enabled, speechRate: 0.75 })).speechRate).toBe(0.75);
      }
    }
  });

  it('关着的时候改语速也要记住（否则重新打开后第一次发音还是旧速度）', () => {
    const plan = planSettingsChange(false, next({ enabled: false, speechRate: 2 }));
    expect(plan.speechRate).toBe(2);
    expect(plan.start).toBe(false);
  });

  it('全局开启但当前站点在黑名单中，仍然不得启动', () => {
    const plan = planSettingsChange(false, next({ enabled: true }), false);
    expect(plan.start).toBe(false);
    expect(plan.stop).toBe(false);
  });
});
