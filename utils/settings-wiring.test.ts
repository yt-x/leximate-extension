/**
 * 设置项的"接线登记"门禁。
 *
 * ## 为什么需要它
 *
 * 用户实测遇到的是：设置页有开关、能保存、有提示文案，但**没有任何代码读它**。
 * 本轮一次就查出三个：
 *
 * | 设置项 | 谁读它 |
 * |---|---|
 * | `minWordLength` | **没人读**（已修：查询管道现在按它拒绝过短的选中） |
 * | `trigger` | **没人读**（规格里只有"划词"触发，没有"点击查词"） |
 * | `autoAddOnSelect` | **没人读**（它承诺的"由你确认后再收藏"在 FR-A6 的六个操作里没有对应动作） |
 *
 * 这类缺陷的恶劣之处：**它看起来很完整**——有界面、有校验、有默认值、有提示文案，
 * 不报错，只是永远不生效。`decisions/0013` 记过同一形状的教训
 * （"接线看起来合理、有监听有分支、不报错、只是永远不触发"）。
 *
 * ## 这个门禁管什么
 *
 * 断言 `DEFAULT_SETTINGS` 的**每个顶层字段**都被显式分类为下列三种之一：
 * 已接线 / 仅管理台用 / 未接线（**必须写明原因**）。
 *
 * 它**不检查"接线是否真的正确"**（那是各模块用例的事），
 * 它只保证**没有人能在不表态的情况下加一个字段**——
 * 加字段就会红，于是"这个开关到底谁读"这个问题必须在提交前回答一次。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './db/defaults';

/** 内容脚本或后台真的会读的字段（读点见括号） */
const WIRED: Record<string, string> = {
  enabled: 'settings-bridge.ts 的 shouldRunOn / controller 的 applyHighlights',
  underlineStyle: 'settings-bridge.ts 的 themeFromSettings',
  underlineColor: 'settings-bridge.ts 的 themeFromSettings',
  underlineThickness: 'settings-bridge.ts 的 themeFromSettings',
  reflectMeetCount: 'settings-bridge.ts 的 themeFromSettings',
  blacklist: 'settings-bridge.ts 的 shouldRunOn → blacklist.ts',
  minWordLength: 'controller.ts → query.ts 的 minLength',
  autoAddOnSelect:
    'controller.ts：true 时划词即入库；false（默认）时只弹卡片，由「加入生词本」写库',
  speechRate:
    'controller.ts 用 safeRate 后交给 createSpeech 的 rate；settings-changed 时经 controller.setSpeechRate 即时生效；管理台详情抽屉的发音按钮同源',
};

/** 只在管理台自己的界面里用，内容脚本不需要读 */
const MANAGER_ONLY: Record<string, string> = {
  // FR-L1（decisions/0026）：只管管理台。App.tsx 读它 → resolveLocale → utils/i18n 的 t()。
  // 内容脚本的划词弹窗**故意不参与** i18n，所以它不该出现在 WIRED 里。
  'ui.language': 'App.tsx → resolveLocale（utils/i18n）；设置页切换，保存后生效',
};

/**
 * 尚未接线的字段：**必须写明原因**，且原因只能是两类之一——
 * "属后续里程碑"或"缺规格，需先立 FR"。
 *
 * ⚠️ **粒度是"字段路径"，不是"顶层字段"**：`ui` 这一类对象里曾经同时住着
 * "真的在用"和"完全没人读"的字段（`ui.language` / `ui.theme` / `ui.pageSize`
 * 三个都只有写它们的表单在读），把 `ui` 整体标成"仅管理台用"就全都漏过去了。
 */
const NOT_WIRED: Record<string, string> = {
  trigger: '缺规格：PLAN.md 只定义了划词触发（FR-A1），"点击单词查词"还没有 FR',
  translation: '属后续里程碑：翻译管道是 M3',
  webdav: '属后续里程碑：同步是 M3',

  'ui.theme': '缺规格：主题（浅色/深色）不在 FR 表里，没有任何代码读它',
  'ui.pageSize': '缺规格：列表是虚拟滚动、不分页，没有任何代码读它',
};

/**
 * 收集 `DEFAULT_SETTINGS` 里可被独立配置的**叶子字段路径**。
 *
 * 一层对象（`ui` / `translation`）继续下钻，因为它们内部的字段各自独立；
 * `null` 值（`webdav` / `llm`）当叶子，因为它们本身就是开关。
 */
function leafPaths(value: object, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      out.push(...leafPaths(child as object, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

/** 登记表里的路径可能指向中间层（如 `ui`），用它判断某个叶子是否已被覆盖 */
function isClassified(path: string, registered: Set<string>): boolean {
  return registered.has(path) || [...registered].some((key) => path.startsWith(`${key}.`));
}

describe('设置项必须被显式分类（防止"假开关"）', () => {
  it('DEFAULT_SETTINGS 的每个叶子字段都登记了去向', () => {
    const classified = new Set([
      ...Object.keys(WIRED),
      ...Object.keys(MANAGER_ONLY),
      ...Object.keys(NOT_WIRED),
    ]);
    const actual = leafPaths(DEFAULT_SETTINGS);

    // 新加字段却没登记时，这里会列出它——先回答"谁读它"，再改这份登记表
    const unclassified = actual.filter((path) => !isClassified(path, classified));
    expect(unclassified).toEqual([]);

    // 反向：登记表里不能有已经不存在的字段（改名/删字段后忘了更新）。
    // 中间层也能登记（如 `translation` / `webdav` 整块属 M3），
    // 因此判定是"有没有任何叶子落在它下面"。
    const stale = [...classified].filter(
      (key) => !actual.some((path) => path === key || path.startsWith(`${key}.`)),
    );
    expect(stale).toEqual([]);
  });

  it('"未接线"的每一项都写明了原因（不是空话）', () => {
    for (const [key, reason] of Object.entries(NOT_WIRED)) {
      expect(reason.length, `${key} 的原因太短`).toBeGreaterThan(10);
      expect(reason).toMatch(/缺规格|里程碑/);
    }
  });

  it('已接线的字段不能同时出现在"未接线"里（分类互斥）', () => {
    const overlap = Object.keys(WIRED).filter((key) => key in NOT_WIRED);
    expect(overlap).toEqual([]);
  });
});
