/**
 * 管理台「改库后必须通知后台」的接线门禁（PLAN.md FR-A14）。
 *
 * ## 为什么要它
 *
 * IndexedDB 写入**不产生任何事件**，后台（Service Worker）与后台是两个上下文，
 * 因此管理台每改一次影响角标的库，都必须显式发 `data-changed` 让后台重算角标，
 * 否则界面长期显示旧状态（`decisions/0009`、`decisions/0010`）。
 *
 * 这条约定已经**漏过三次**：
 * 1. 删光生词后角标不掉（`decisions/0014`，墓碑计入 + 无刷新触发）
 * 2. 管理台「清空数据」后角标不更新
 * 3. **管理台「保存设置」后角标不更新**（2026-10-22 用户实测：关掉全局开关，角标很久才变 OFF）
 *
 * 前两次都是"出事哪补哪"，没有系统性防漏。本门禁把这条约定变成可执行的检查：
 * **凡是改「会影响角标的库」的调用点，同一函数体内必须有通知调用。**
 *
 * ## 哪些写操作影响角标
 *
 * 角标文案 = `enabled` ? 词数 : 'OFF'（见 `utils/badge/badge.ts`）。
 * 因此只影响这两者的写入需要通知：
 * - `setSettings`（可能改 `enabled`）
 * - `clearAllData`（词数清零）
 * - `updateWordStatus` / `softDeleteWord` / `upsertWord`（改词数或词的可见性）
 *
 * **不影响**的（不需要通知）：`setMeta` 改导出时间、引导状态等——它们不改变词数也不改变开关。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** 会改变「角标文案」的写库调用 */
const AFFECTS_BADGE = [
  'setSettings',
  'clearAllData',
  'updateWordStatus',
  'softDeleteWord',
  'upsertWord',
];

/** 通知后台的两种写法（模块级 notifier 或就地构造） */
const NOTIFY_PATTERN = /notifyDataChanged|createDataChangeNotifier/;

const MANAGER_DIR = join(process.cwd(), 'entrypoints', 'manager');

interface Finding {
  file: string;
  line: number;
  call: string;
  notified: boolean;
}

/** 扫一个文件里所有"影响角标的写库调用"，看同一函数体内有没有通知 */
function scanFile(path: string): Finding[] {
  const source = readFileSync(path, 'utf8');
  const lines = source.split(/\r?\n/);
  const out: Finding[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const call = AFFECTS_BADGE.find((name) => new RegExp(`(^|[^\\w.])${name}\\s*\\(`).test(line));
    if (!call) continue;
    // 跳过 import 行与注释行
    if (/^\s*import\b/.test(line) || /^\s*(\*|\/\/)/.test(line)) continue;

    // 看这个调用之后 12 行内有没有通知（够覆盖同一函数体的常见写法）
    const window = lines.slice(i, Math.min(i + 13, lines.length)).join('\n');
    out.push({ file: path, line: i + 1, call, notified: NOTIFY_PATTERN.test(window) });
  }
  return out;
}

describe('FR-A14 接线门禁：管理台改库后必须通知后台重算角标', () => {
  const files = readdirSync(MANAGER_DIR)
    .filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))
    .map((n) => join(MANAGER_DIR, n));

  it('扫到了管理台组件（防止门禁因路径变化而静默失效）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('所有影响角标的写库调用都配了通知', () => {
    const findings = files.flatMap(scanFile);
    // 至少要扫到几处，否则说明正则或路径坏了
    expect(findings.length).toBeGreaterThan(2);

    const missing = findings.filter((f) => !f.notified);
    const report = missing
      .map((f) => `${f.file}:${f.line} 调了 ${f.call} 但附近没有 notifyDataChanged`)
      .join('\n');
    expect(missing, `以下调用点改了影响角标的库却没通知后台：\n${report}`).toHaveLength(0);
  });

  it('已知的三处修复点都被扫到（回归保护）', () => {
    const findings = files.flatMap(scanFile);
    const calls = findings.map((f) => f.call);
    expect(calls).toContain('setSettings'); // 2026-10-22 修的第 3 次
    expect(calls).toContain('clearAllData'); // 第 2 次
    expect(calls).toContain('updateWordStatus'); // 改状态
  });
});
