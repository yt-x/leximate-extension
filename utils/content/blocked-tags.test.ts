/**
 * 标注排除清单的单一来源（`changes/M1M2-closeout.md` 切片 7）。
 *
 * 背景：`selection.ts`（选区触发判定）与 `controller.ts`（标注扫描）各写了一份清单，
 * 且内容不同——`controller` 多 `NOSCRIPT`、少 `SELECT`，注释却写着「与 FR-A4 同一份清单」。
 *
 * 本轮口径（用户拍板）：**以 `selection.ts` 的七类为准**抽成共享常量，两处引用同一份，
 * **不改变用户可见行为**（`NOSCRIPT` 里本来就没有可划的文本；`SELECT` 的选项文本也不该被标注）。
 */
import { describe, expect, it } from 'vitest';

import { BLOCKED_TAGS, isBlockedByTag } from './blocked-tags';

describe('共享排除清单', () => {
  it('就是 FR-A4 的七类', () => {
    expect([...BLOCKED_TAGS]).toEqual([
      'INPUT',
      'TEXTAREA',
      'SELECT',
      'SCRIPT',
      'STYLE',
      'CODE',
      'PRE',
    ]);
  });

  it('大小写不敏感', () => {
    expect(isBlockedByTag('input')).toBe(true);
    expect(isBlockedByTag('Pre')).toBe(true);
  });

  it('不排除的标签返回 false', () => {
    expect(isBlockedByTag('DIV')).toBe(false);
    expect(isBlockedByTag('P')).toBe(false);
    // NOSCRIPT 不在七类里：它的内容不会渲染成可划文本，不需要单独排除
    expect(isBlockedByTag('NOSCRIPT')).toBe(false);
  });
});
