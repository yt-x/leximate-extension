/**
 * 标注与选区判定的共享排除清单（PLAN.md FR-A4，`changes/M1M2-closeout.md` 切片 7）。
 *
 * 单一来源：`selection.ts`（选区触发判定）与 `controller.ts`（标注扫描）都从这里取。
 * 之前两处各写一份，且内容不同（`controller` 多 `NOSCRIPT`、少 `SELECT`），
 * 注释却声称「与 FR-A4 同一份清单」——两份清单会随任一侧的改动悄悄分叉。
 *
 * 口径（规格原文）：`input` / `textarea` / `select` / `script` / `style` / `code` / `pre`，
 * 外加任何 `isContentEditable === true` 的祖先（后者不是标签，由调用方单独判）。
 */
export const BLOCKED_TAGS = [
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'SCRIPT',
  'STYLE',
  'CODE',
  'PRE',
] as const;

const BLOCKED_SET: ReadonlySet<string> = new Set(BLOCKED_TAGS);

/** 这个标签名是否该被排除（大小写不敏感） */
export function isBlockedByTag(nodeName: string): boolean {
  return BLOCKED_SET.has(nodeName.toUpperCase());
}
