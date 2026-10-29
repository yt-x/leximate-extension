/**
 * 工具栏角标文案（PLAN.md FR-A14）。
 *
 * 规格原文：**关闭时角标显示 `OFF`；恢复时角标显示遇见词数（`0` 时不显示角标）**。
 *
 * 这里只算**文案**，不碰 `browser.action`。理由是这一段有真分支要测
 * （关 / 0 / 负数 / 小数 / 极大值 / 非法输入），而 `setBadgeText` 本身
 * 在单测环境里根本不存在。把判定抽成纯函数之后，FR-A14 的角标分句
 * 就有了可执行的验收，而不是"看着没问题"。
 */

/**
 * 关闭态的角标文案。
 *
 * 用 `OFF` 而不是 `⏸` 或空字符串：空字符串在本 API 里是**清除角标**的意思
 * （见 `docs/reference/action-badge.md`），用它表达"已暂停"会与"没有角标"
 * 撞在一起，用户看不出扩展是暂停了还是装坏了。
 */
export const OFF_TEXT = 'OFF';

/**
 * 角标文案的字符上界（`9999+` 的 5 个字符）。
 *
 * Chrome 的角标区域约能容纳 4 个字符，超出是**布局后果**（挤掉/显示不全），
 * 不是报错。本项目最长文案是 `9999+`（5 字符）：它已经贴着显示上限，
 * 这也是 `BADGE_OVERFLOW_AT` 取 9999 而不是更大值的原因——再大必然显示不全。
 *
 * 这个常量是给测试做**上界断言**用的，不是"保证显示得下"的承诺；
 * 真正的硬限制是 `MAX_BADGE_BYTES`（超了会抛错）。
 */
export const MAX_BADGE_CHARS = 5;

/**
 * 超过这个数就不再显示精确值，改用 `9999+`。
 *
 * 理由同上：角标不是统计面板，精确到个位没有意义，
 * 而截断显示（比如 12345 显示成 "1234"）是**错误信息**——用户会以为那就是真实数量。
 * 宁可显示 `9999+` 明确表示"很多"。
 */
export const BADGE_OVERFLOW_AT = 9999;

/**
 * Chrome 152 起的硬上限：badge 文本超过 **100 字节**会被拒绝并**抛错**
 * （不是截断）。见 `docs/reference/action-badge.md` §2。
 *
 * 本项目所有文案都远低于这个值（最长 5 字符），这里留一个可断言的常量，
 * 让"文案不会触发该抛错路径"成为测试里的一条断言，而不是一句口头保证。
 */
export const MAX_BADGE_BYTES = 100;

export interface BadgeInput {
  /** FR-A14 全局开关 */
  enabled: boolean;
  /** 遇见词数（词库里 `words` 的总数） */
  wordCount: number;
}

/**
 * 算出该显示什么角标文案。
 *
 * 返回 `null` 表示**清除角标**（区别于返回空字符串：调用方需要能区分
 * "没有角标"与"我们把角标设成了空"这两种意图，虽然落到 API 上都是 `''`）。
 *
 * 规则（与 FR-A14 逐字对应）：
 * - 开关关闭 → `OFF`（**不管词数是多少**，暂停态优先，用户要先看到"已暂停"）
 * - 词数 `<= 0` → 清除（规格：`0` 时不显示角标）
 * - 词数非整数 → 向下取整（上限保护用，不制造"遇见 3.5 个词"）
 * - 超过 `9999` → `9999+`
 * - 其余 → 十进制数字
 */
export function badgeText(input: BadgeInput): string | null {
  // 暂停优先于词数：关掉扩展时用户最需要知道的是"它现在是停的"，
  // 而不是"我攒了多少词"。这也让 OFF 成为关闭态唯一可能的文案。
  if (input.enabled !== true) return OFF_TEXT;

  const raw = input.wordCount;
  // NaN / Infinity / 字符串等一律当作"没有可显示的数"，清除角标。
  // 不抛错：角标是装饰性的，坏数据不该让后台服务崩掉。
  const count = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(count)) return null;

  const whole = Math.floor(count);
  if (whole <= 0) return null;

  if (whole > BADGE_OVERFLOW_AT) return `${BADGE_OVERFLOW_AT}+`;

  return String(whole);
}
