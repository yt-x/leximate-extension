/**
 * FR-A14 角标文案的单测。
 *
 * 覆盖规格里逐字写明的两个分句（关闭显示 `OFF`、`0` 时不显示），
 * 外加边界：负数、小数、`NaN`、溢出、以及"关闭时词数再大也显示 OFF"。
 */
import { describe, expect, it } from 'vitest';
import {
  BADGE_OVERFLOW_AT,
  badgeText,
  MAX_BADGE_BYTES,
  MAX_BADGE_CHARS,
  OFF_TEXT,
} from './badge';

describe('badgeText', () => {
  describe('FR-A14 规格明文的两条', () => {
    it('关闭时显示 OFF', () => {
      expect(badgeText({ enabled: false, wordCount: 0 })).toBe(OFF_TEXT);
      expect(badgeText({ enabled: false, wordCount: 12 })).toBe(OFF_TEXT);
    });

    it('词数为 0 时不显示角标', () => {
      expect(badgeText({ enabled: true, wordCount: 0 })).toBeNull();
    });
  });

  it('开启且有词时显示十进制数字', () => {
    expect(badgeText({ enabled: true, wordCount: 1 })).toBe('1');
    expect(badgeText({ enabled: true, wordCount: 42 })).toBe('42');
    expect(badgeText({ enabled: true, wordCount: 920 })).toBe('920');
  });

  it('关闭优先于词数：关闭态下词数不影响文案', () => {
    // 暂停时用户要看的是"它停了"，不是"攒了多少词"
    expect(badgeText({ enabled: false, wordCount: 999 })).toBe(OFF_TEXT);
    // 关闭 + 空词库 仍然是 OFF，不能退化成"清除角标"
    expect(badgeText({ enabled: false, wordCount: 0 })).toBe(OFF_TEXT);
  });

  describe('词数的边界处理', () => {
    it('负数当作没有可显示的数', () => {
      expect(badgeText({ enabled: true, wordCount: -1 })).toBeNull();
      expect(badgeText({ enabled: true, wordCount: -100 })).toBeNull();
    });

    it('小数向下取整，不显示半个词', () => {
      expect(badgeText({ enabled: true, wordCount: 3.9 })).toBe('3');
      expect(badgeText({ enabled: true, wordCount: 0.5 })).toBeNull();
    });

    it('超过上限显示 9999+ 而不是截断', () => {
      // 截断会把 12345 显示成 "1234"，那是**错的信息**；加号才表达"很多"
      expect(badgeText({ enabled: true, wordCount: BADGE_OVERFLOW_AT })).toBe('9999');
      expect(badgeText({ enabled: true, wordCount: BADGE_OVERFLOW_AT + 1 })).toBe('9999+');
      expect(badgeText({ enabled: true, wordCount: 1_000_000 })).toBe('9999+');
    });

    it('NaN / Infinity 清除角标而不抛错', () => {
      expect(badgeText({ enabled: true, wordCount: Number.NaN })).toBeNull();
      expect(badgeText({ enabled: true, wordCount: Number.POSITIVE_INFINITY })).toBeNull();
      expect(badgeText({ enabled: true, wordCount: Number.NEGATIVE_INFINITY })).toBeNull();
    });
  });

  it('所有返回的文案都不超过 MAX_BADGE_CHARS', () => {
    const samples = [0, 1, 9, 99, 999, 9999, 10000, 123456];
    for (const wordCount of samples) {
      const text = badgeText({ enabled: true, wordCount });
      if (text !== null) {
        expect(text.length).toBeLessThanOrEqual(MAX_BADGE_CHARS);
      }
    }
    expect(OFF_TEXT.length).toBeLessThanOrEqual(MAX_BADGE_CHARS);
  });

  it('所有返回的文案都远低于 Chrome 152 的 100 字节硬上限', () => {
    // 该上限**抛错**而非截断（见 docs/reference/action-badge.md §2），
    // 因此这里断言的是"不会走进抛错路径"，不是"显示得下"
    const samples = [0, 1, 9, 99, 999, 9999, 10000, Number.MAX_SAFE_INTEGER];
    for (const wordCount of samples) {
      const text = badgeText({ enabled: true, wordCount });
      if (text !== null) {
        expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_BADGE_BYTES);
      }
    }
    expect(new TextEncoder().encode(OFF_TEXT).length).toBeLessThan(MAX_BADGE_BYTES);
  });

  it('OFF 与数字不会混淆：OFF 不是数字文案', () => {
    expect(Number.isNaN(Number(OFF_TEXT))).toBe(true);
  });
});
