/**
 * 英文覆盖层的**完整性门禁**（PLAN.md FR-L1 的"两种语言下无缺失文案"）。
 *
 * 做法：扫已接入 `tx()` 的管理台文件，把每个 `tx('中文…')` 里的中文原文抠出来，
 * 逐条断言 `EN_OVERLAY` 里有对应英文。
 *
 * 为什么用"扫源码"而不是"渲染后查 DOM"：渲染断言只能覆盖当前用例碰到的那几条文案，
 * 而漏翻的往往正是没被点到的那些（空态、错误分支、aria-label）。扫源码是**全覆盖**的，
 * 而且新增文案忘了翻译时它会直接红——把"无缺失文案"变成不可绕过的门禁。
 *
 * 注意：注释里的中文不算（只匹配 `tx(` 的实参），所以本文件不会因为注释而误报。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EN_OVERLAY } from './overlay';

/**
 * 已接入 `tx()` 的文件：**直接产出界面文字的模块**都在这里。
 *
 * 只收"产出的字符串就是最终文案"的文件（页面组件、提醒文案、校验错误、下载错误）。
 * **不收**"把中文当数据存着、由渲染处取 `tx()`"的模块——`utils/export/scope.ts` 的
 * `label`、`utils/export/record.ts` 的 `ankiHeader`、`utils/diag/format.ts` 的
 * `LEVEL_LABEL` 都属于这一类：它们在模块顶层算成常量，若在里面调 `tx()` 会被冻结成
 * 导入时的语言（这是个真实的坑，`utils/diag/format.ts` 试过一次就退回来了）。
 */
const CONVERTED_FILES = [
  'entrypoints/manager/App.tsx',
  'entrypoints/manager/WordList.tsx',
  'entrypoints/manager/Onboarding.tsx',
  'entrypoints/manager/DiagnosticsPage.tsx',
  'entrypoints/manager/WordDrawer.tsx',
  'entrypoints/manager/ExportPanel.tsx',
  'entrypoints/manager/ImportSection.tsx',
  'entrypoints/manager/SettingsPage.tsx',
  'entrypoints/manager/TranslateStatus.tsx',
  'entrypoints/manager/SyncStatus.tsx',
  'utils/manager/backup-health.ts',
  'utils/manager/settings-form.ts',
  'utils/export/download.ts',
  'utils/import/parse.ts',
] as const;

/** 扫出 `tx('…')` 里的中文字面量（单引号；含多行的不算——本项目文案都是单行字符串） */
function txLiterals(source: string): string[] {
  const out: string[] = [];
  const re = /tx\(\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  for (const match of source.matchAll(re)) {
    const raw = match[1] ?? '';
    if (/[\u4e00-\u9fff]/.test(raw)) out.push(raw);
  }
  return out;
}

describe('FR-L1：tx() 用到的每条中文都要有英文', () => {
  it('覆盖层不缺条目', () => {
    const missing: string[] = [];
    for (const file of CONVERTED_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const literal of txLiterals(source)) {
        if (!Object.hasOwn(EN_OVERLAY, literal)) missing.push(`${file} → ${literal}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('覆盖层里没有空白英文（避免"翻了但等于没翻"）', () => {
    for (const [zh, en] of Object.entries(EN_OVERLAY)) {
      expect(en.trim(), zh).not.toBe('');
      // 英文里不该混进中文（专有名词如"中文"是有意的）
      if (zh !== '中文') expect(en, `${zh} → ${en}`).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('扫源码这一步本身有效（防止正则写坏后静默通过）', () => {
    const sample = "const a = tx('生词'); const b = tx('总词数');";
    expect(txLiterals(sample)).toEqual(['生词', '总词数']);
  });
});

/**
 * 更严的一条：已转换的文件里，**除注释外**不允许出现没被 `tx()` 包裹的中文。
 *
 * 为什么需要它：上一条只检查"包了的有没有英文"，而真机反馈的漏网恰恰是**根本没包**
 * （`清除筛选`、诊断页三个按钮、诊断页来源说明——缩进不匹配导致替换静默失败）。
 * 这条把"漏包"变成红测，不再依赖人点一遍。
 */
function unwrappedCjk(source: string): string[] {
  const stripped = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX 注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^\s*\/\/.*$/gm, ''); // 行注释

  const out: string[] = [];
  for (const line of stripped.split('\n')) {
    if (!/[\u4e00-\u9fff]/.test(line)) continue;
    if (line.includes('tx(')) continue;
    out.push(line.trim());
  }
  return out;
}

describe('FR-L1：不留未包裹的中文（除注释）', () => {
  it('已转换的文件里没有漏网的中文文案', () => {
    const leftovers: string[] = [];
    for (const file of CONVERTED_FILES) {
      for (const line of unwrappedCjk(readFileSync(file, 'utf8'))) leftovers.push(`${file} → ${line}`);
    }
    expect(leftovers).toEqual([]);
  });

  it('这条检查本身有效（注释里的中文不算、包裹过的也不算）', () => {
    const sample = [
      '// 注释里的中文',
      '{/* JSX 注释里的中文 */}',
      "const a = tx('生词');",
      'const b = 生词;',
    ].join('\n');
    expect(unwrappedCjk(sample)).toEqual(['const b = 生词;']);
  });
});
