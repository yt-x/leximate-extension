/**
 * 站点黑名单（PLAN.md FR-A13）。
 *
 * 规格口径（§1.A「FR-A1 ~ A4 / A7 / A13 / A14 的实现口径」）：
 * - 两种写法：**精确域名**（`example.com`）与**通配**（`*.example.com`）
 * - 精确域名匹配**它自己及其任意子域**；通配**只匹配子域，不含根域**
 * - 匹配对象是 `location.hostname`，**大小写不敏感**
 * - **不做**路径匹配、不做正则
 *
 * 纯函数，不碰 DOM 与浏览器 API，因此可逐条单测。
 */

/** 归一化一条黑名单规则：去空白、去协议、去路径、转小写 */
export function normalizeRule(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    // 用户可能整条粘 URL 进来，容错掉协议与路径——但规格只匹配主机名
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0]!
    .split('?')[0]!
    .replace(/\.$/, '');
}

/**
 * 判断 hostname 是否命中黑名单（FR-A13）。
 *
 * 规则语义：
 * - `example.com`    → 命中 `example.com`、`www.example.com`、`a.b.example.com`
 * - `*.example.com`  → 命中 `www.example.com`、`a.b.example.com`，**不命中** `example.com`
 * - 空规则、空 hostname → 不命中（宁可漏标，不可误伤）
 */
export function isBlacklisted(hostname: string, rules: string[]): boolean {
  const host = normalizeRule(hostname);
  if (host === '') return false;

  for (const raw of rules) {
    const rule = normalizeRule(raw);
    if (rule === '') continue;

    if (rule.startsWith('*.')) {
      const base = rule.slice(2);
      if (base === '') continue;
      // 通配只匹配子域：host 必须以 ".base" 结尾
      if (host.endsWith(`.${base}`)) return true;
      continue;
    }

    // 精确域名：它自己或其任意子域
    if (host === rule || host.endsWith(`.${rule}`)) return true;
  }

  return false;
}

/** 首次命中的规则，便于诊断日志写明"被哪条挡了" */
export function matchedRule(hostname: string, rules: string[]): string | null {
  const host = normalizeRule(hostname);
  if (host === '') return null;
  for (const raw of rules) {
    if (isBlacklisted(host, [raw])) return raw;
  }
  return null;
}
