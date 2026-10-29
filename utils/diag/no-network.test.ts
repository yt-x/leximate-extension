/**
 * FR-L4 的"**不上报任何数据**"守卫。
 *
 * FR 的原话是"记录运行日志……不上报任何数据"。这条**不能只写在注释里**：
 * 谁哪天顺手在诊断页加一个"上报日志"的开关，注释不会拦住他
 * （`CONSTRAINTS.md` 第 13.1 条：边界约束要靠门禁，不能靠注释）。
 *
 * 做法与 `scripts/check-content-boundary.ts` 的"源码特征"层一致：
 * **先剥掉注释与字符串**再找网络 API——本项目的注释里大量讨论这些 API，
 * 直接扫原文会把文档判成违规（并逼人删掉有价值的注释）。
 *
 * 另有一条**阳性对照**：拿一个确实用 `fetch` 的文件（`utils/dict/source.ts`）
 * 验探针本身有效。永远通过的门禁比没有门禁更危险。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripNonCode } from '../../scripts/check-content-boundary';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 明令禁止出现在诊断链路里的能力 */
const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // `fetch` / `fetchImpl(` 都要抓：本项目习惯把实现注入（见 utils/dict/source.ts）
  { name: 'fetch', pattern: /\bfetch[A-Za-z_$]*\s*\(/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'sendBeacon', pattern: /\bsendBeacon\b/ },
  { name: 'WebSocket', pattern: /\bWebSocket\b/ },
  { name: 'EventSource', pattern: /\bEventSource\b/ },
];

function read(relative: string): string {
  return stripNonCode(readFileSync(`${ROOT}${relative}`, 'utf8'));
}

/** 诊断链路的所有源文件（测试文件除外） */
function diagnosticsSources(): string[] {
  const dir = `${ROOT}utils/diag`;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `utils/diag/${name}`);
  return [...files, 'entrypoints/manager/DiagnosticsPage.tsx'];
}

describe('FR-L4：诊断链路不碰网络', () => {
  const sources = diagnosticsSources();

  it('被检查的文件确实存在（否则这条门禁是空的）', () => {
    expect(sources.length).toBeGreaterThanOrEqual(4);
    for (const file of sources) {
      expect(read(file).length).toBeGreaterThan(0);
    }
  });

  it('诊断模块与诊断页里没有任何网络 API', () => {
    const violations: string[] = [];
    for (const file of sources) {
      const code = read(file);
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(code)) violations.push(`${file}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('阳性对照：确实用 fetch 的文件会被抓出来（探针有效）', () => {
    const code = read('utils/dict/source.ts');
    const hits = FORBIDDEN.filter(({ pattern }) => pattern.test(code)).map(({ name }) => name);
    expect(hits).toContain('fetch');
  });

  it('剥注释确实生效：注释里写了 fetch( 也不算违规', () => {
    const sample = '// 这里讨论 fetch( 的用法\nconst a = 1; /* 也不要 fetch( */';
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(stripNonCode(sample)))).toBe(false);
  });
});
