/**
 * M1-5 性能实测（PLAN.md FR-A1、FR-A3d、FR-A11、FR-A12）。
 *
 * 写成测试而不是 `node scripts/...`：`utils/` 下的模块用无扩展名 import，
 * Node 的 ESM 解析器不认，vitest 的 Vite 解析器认。
 * 因此这是**唯一**能对真产物跑性能的入口。
 *
 * 用真产物（`public/dict/`），不用造的小词表——性能结论只有对真实数据量才算数。
 * 口径按 PLAN.md §1.A：「同一个宏任务内」的耗时，取中位数；冷启动单列。
 *
 * 阈值定得比规格松一档（规格 100ms，这里断言 50ms），
 * 因为 CI 机器比开发机慢且抖动大。**规格判据仍是 100ms**，
 * 这里只是要在回归时更早报警。
 */
import { describe, expect, it } from 'vitest';
import {
  benchGroup,
  benchQuery,
  benchScan,
  makeRealDict,
  pickLemmatizedSamples,
} from '../scripts/bench-content';

describe('FR-A1 / FR-B3d：划词到卡片就绪', () => {
  it('三条路径的中位数都远低于 100ms 预算', async () => {
    const { dict, reverse, words, artifact, index, coldMs } = await makeRealDict();

    const direct = words.filter((w) => w.length > 3).slice(0, 8);
    const lemmatized = pickLemmatizedSamples(dict, reverse);
    const missing = ['zzzzzz', 'qqqqqq', 'xyzzy'];

    // 三条路径都要有足够样本，否则"通过"没有意义
    expect(direct.length).toBeGreaterThan(0);
    expect(missing.length).toBeGreaterThan(0);
    // 还原路径必须真的取到样本——第一次跑只有 1 个，那一行等于没测
    expect(lemmatized.length, '还原路径样本数').toBeGreaterThanOrEqual(3);

    const results = {
      direct: benchQuery(dict, direct),
      lemmatized: benchQuery(dict, lemmatized),
      missing: benchQuery(dict, missing),
    };

    // 把真实数字打出来，供 verification/M1-5.md 抄录——不靠记忆写证据
    console.log('');
    console.log('=== M1-5 性能实测（真产物）===');
    console.log(`词表版本 ${index.version} / 核心词条 ${words.length} / 变形 surface ${artifact.count}`);
    console.log(`冷启动（首次可划词，不计入 100ms 预算） ${coldMs.toFixed(2)} ms`);
    for (const [label, r] of Object.entries(results)) {
      console.log(
        `${label.padEnd(12)} 样本 ${String(r.count).padEnd(3)} 中位数 ${r.median.toFixed(3)} ms  最差 ${r.max.toFixed(3)} ms`,
      );
    }

    const scan = benchScan(dict, words, 5000);
    console.log(
      `扫描         5000 词 ${scan.chars} 字符 中位数 ${scan.median.toFixed(2)} ms  最差 ${scan.max.toFixed(2)} ms  命中 ${scan.spans} 处`,
    );

    const text = Array.from(
      { length: 5000 },
      () => words[Math.floor(Math.random() * words.length)]!,
    ).join(' ');
    const group = benchGroup(dict, text);
    console.log(`分组         ${group.spans} 个词 中位数 ${group.median.toFixed(2)} ms`);
    console.log('');

    for (const [label, r] of Object.entries(results)) {
      expect(r.median, `${label} 中位数`).toBeLessThan(50);
    }
  });

  it('冷启动（首次可划词）单独记录，不混入 100ms 预算', async () => {
    const { coldMs } = await makeRealDict();
    // 只断言"能跑完且不荒谬"，因为冷启动不含在 FR-A1 预算里
    expect(coldMs).toBeGreaterThan(0);
    expect(coldMs).toBeLessThan(2000);
  });
});

describe('FR-A12：标注扫描吞吐', () => {
  it('5000 词的扫描中位数在 50ms 内（长页面滚动不卡顿的基础）', async () => {
    const { dict, words } = await makeRealDict();
    const r = benchScan(dict, words, 5000);

    expect(r.chars).toBeGreaterThan(10000);
    expect(r.spans).toBeGreaterThan(0);
    expect(r.median, '扫描中位数').toBeLessThan(50);
  });
});

describe('FR-A11：分组开销', () => {
  it('对 5000 词的扫描结果分组在 20ms 内', async () => {
    const { dict, words } = await makeRealDict();
    const text = Array.from(
      { length: 5000 },
      () => words[Math.floor(Math.random() * words.length)]!,
    ).join(' ');

    const r = benchGroup(dict, text);
    expect(r.spans).toBeGreaterThan(0);
    expect(r.median, '分组中位数').toBeLessThan(20);
  });
});
