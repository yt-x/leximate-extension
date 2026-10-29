#!/usr/bin/env node
/**
 * 校验：内容脚本的**依赖图**不得触达扩展源存储。
 *
 *   node scripts/check-content-boundary.ts
 *
 * ## 这个门禁防的是什么
 *
 * 内容脚本跑在**宿主页面**里，因此它调用 IndexedDB / localStorage / chrome.storage
 * 时，访问的是**宿主页面的源**，不是扩展的源。官方原文
 * （`docs/reference/extension-storage-and-messaging.md` §1）：
 *
 * > In content scripts, calling web storage APIs accesses data from the host page
 * > the content script is injected on and not the extension.
 *
 * 2026-10-15 的真机冒烟暴露了这个 bug 的**真实形态**：`content.ts` 里
 * `import { getSettings } from '@/utils/db/kv'`——**一个字面量 import**。
 * 于是内容脚本与后台各开一个同名但互不可见的库，**不报任何错**，
 * 只是数据永远对不上（`CONSTRAINTS.md` 第 12 条）。
 *
 * ## 为什么不做成"断言某文件不含某字符串"
 *
 * 因为 bug 在**传递依赖**上同样成立：`content.ts` 只要 import 了任何一个
 * 最终会走到 `utils/db/*` 的模块，结论一样。逐文件做字符串匹配既漏又脆。
 * 这里转而**遍历整个依赖图**，对**闭包里的每一个模块**做判定。
 *
 * ## 判定口径
 *
 * 1. **模块可达性**（硬失败）：闭包中不得出现存储访问模块
 *    （`utils/db/*`、`utils/settings-bus` 除外——后者是纯进程内事件，见下）。
 * 2. **源码特征**（硬失败）：闭包中任何模块的源码不得出现
 *    `indexedDB` / `localStorage` / `sessionStorage` / `chrome.storage`
 *    ——这一条防的是"不 import 我们自己的 db 层、却直接调平台 API"。
 * 3. **例外白名单**（显式、可审计）：见 `ALLOWED`。
 *
 * 判定在**源码层**做，不在打包产物层做：源码是改动发生的地方，
 * 报错能直接指到行。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 内容脚本入口（可能多个，逐个查） */
const ENTRIES = [join(root, 'entrypoints', 'content.ts')];

/**
 * 允许出现在闭包里的模块（相对 root 的 POSIX 路径）。
 *
 * **每一条都要写出理由**——白名单是审计面，不是图省事的后门。
 */
const ALLOWED: Record<string, string> = {
  'utils/settings-bus.ts':
    '纯进程内的事件总线（onSettingsWritten / notifySettingsWritten），' +
    '不碰任何浏览器 API；后台与 kv 层用它解耦，内容脚本不 import 它，' +
    '但若将来 import 也安全，故列白名单。',
  'utils/db/types.ts':
    '**纯类型声明**（WordStatus / Settings 等），编译后不产生任何运行时代码。' +
    '内容脚本需要 `Settings` 类型做标注，这是 `import type`，不入运行时依赖图。',
  'utils/db/defaults.ts':
    '**纯数据**：DEFAULT_SETTINGS 与 defaultMeta()，不 import 任何模块、' +
    '不产生副作用（文件头有约束说明）。' +
    '它**故意**放在 utils/db/ 下与存储层同目录，但自身不碰存储——' +
    '内容脚本需要 DEFAULT_SETTINGS 做消息失败时的兜底。' +
    '注意：本白名单按**文件**授权，不是按目录；给该文件加任何 import 都会' +
    '被下面的源码特征检查重新审视（indexedDB 等仍会命中）。',
};

/**
 * 禁止出现在闭包源码里的平台存储 API。
 *
 * 用正则而不是子串：要能匹配 `window.localStorage` 也能匹配裸 `localStorage`。
 */
const FORBIDDEN_APIS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bindexedDB\b/, label: 'indexedDB' },
  { pattern: /\blocalStorage\b/, label: 'localStorage' },
  { pattern: /\bsessionStorage\b/, label: 'sessionStorage' },
  { pattern: /\bchrome\.storage\b/, label: 'chrome.storage' },
  { pattern: /\bbrowser\.storage\b/, label: 'browser.storage' },
];

/**
 * 剥掉注释与字符串字面量后再做特征匹配。
 *
 * **为什么必须剥**：本项目在源码里大量**讨论**这些 API 名（`content.ts` 的
 * 头部警示、`word-state-cache.ts` 解释旧实现为什么错、`CONSTRAINTS.md` 第 12 条）。
 * 直接扫原文会把"文档"判成"违规"，这样的门禁会逼人删掉有价值的注释——
 * 那是反效果。真正要防的是**可执行的引用**，注释不是引用。
 *
 * 只做粗剥（块注释、行注释、三种字符串），不追求完美：
 * 这是防回归的启发式，不是编译器。
 */
/**
 * 只做粗剥（块注释、行注释、三种字符串），不追求完美：
 * 这是防回归的启发式，不是编译器。
 *
 * **导出是为了单测**（`check-content-boundary.test.ts`）。门禁本身一旦失灵，
 * 表现是"永远通过"，比没有门禁更危险——所以要测。
 */
export function stripNonCode(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i];
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      // 用等长空白占位，保持行号不变（报错要能指到行）
      out += ' ';
      continue;
    }

    out += source[i];
    i += 1;
  }

  return out;
}

/**
 * 产物校验：真正跑起来的是打包结果，判定就该落在它上面。
 *
 * 与源码校验的区别：产物里已经没有注释，因此这里**不做剥注释**——
 * 出现即违规。这是最强的一条证据：不管源码怎么写、tree-shaking 怎么走，
 * 只要内容脚本产物里出现存储 API，就是真 bug。
 */
function verifyBundle(): string[] {
  const bundlePath = join(root, '.output', 'chrome-mv3', 'content-scripts', 'content.js');
  if (!existsSync(bundlePath)) {
    return ['产物不存在（先跑 `node .\\node_modules\\wxt\\bin\\wxt.mjs build`）'];
  }

  const bundle = readFileSync(bundlePath, 'utf8');
  const found: string[] = [];

  for (const { pattern, label } of FORBIDDEN_APIS) {
    // 产物是压缩过的单行，按出现次数报，不报行号
    const matches = bundle.match(new RegExp(pattern.source, 'g'));
    if (matches) found.push(`产物出现 ${label}（${matches.length} 次）`);
  }

  return found;
}

/** 禁止成为闭包成员的模块前缀（我方存储层） */
const FORBIDDEN_MODULE_PREFIXES = ['utils/db/'];

/**
 * 允许**被引用但不许存活到产物**的模块。
 *
 * 这一组是 `content.ts → utils/db/kv.ts → utils/db/schema.ts` 这条链：
 * `content.ts` 只为拿 `DEFAULT_SETTINGS`（一个纯对象字面量）而引用 `kv.ts`。
 * Rollup 会把读库的那半边 tree-shake 掉，实测产物里没有 `indexedDB`。
 *
 * **但这依赖于当前的代码形状，不是保证**：给 `kv.ts` 或 `schema.ts`
 * 加一句顶层副作用，`indexedDB` 就会静默回到内容脚本里。
 *
 * 所以这里不判硬失败，而是**强制要求产物校验通过**——
 * 真正会执行的是产物，最终判定就该落在产物上；
 * 源码可达性只用来生成"值得盯"的清单（见报告的 treeShakenReliance）。
 */
const TREE_SHAKEN_ALLOWED = new Set(['utils/db/kv.ts', 'utils/db/schema.ts']);

interface Violation {
  kind: 'module' | 'api';
  message: string;
  /** 违规模块，以及**是哪个入口经哪条路径引到它的** */
  path: string[];
}

/** 把 `@/x` / `./x` / `../x` 解析成相对 root 的 POSIX 路径；解析不了返回 null */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) {
    base = join(root, spec.slice(2));
  } else if (spec.startsWith('.')) {
    base = resolve(dirname(fromFile), spec);
  } else {
    // 裸包名（wxt/browser、react 等）：一律放行。
    // 本门禁管的是"我方数据层"，不是第三方包 —— 用 host_permissions 与
    // 运行时零网络（FR-K1）另行约束。
    return null;
  }

  // TS 项目里 specifier 可能省略扩展名，按常见顺序补全
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('.d.ts')) {
      // 目录要排掉
      try {
        if (readFileSync(candidate)) return relative(root, candidate).split('\\').join('/');
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** 广度优先遍历依赖图，记录每个模块的引入路径（用于报错时指出链路） */
async function walk(entry: string): Promise<Map<string, string[]>> {
  const entryRel = relative(root, entry).split('\\').join('/');
  const seen = new Map<string, string[]>([[entryRel, [entryRel]]]);
  const queue: string[] = [entryRel];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = readFileSync(join(root, current), 'utf8');
    const [imports] = parse(source);

    for (const imp of imports) {
      // 动态 import 与静态 import 都要查：`await import('@/utils/db/words')`
      // 同样是真实的运行时依赖（M1-6 里就出现过一处）
      if (!imp.n) continue;
      const resolved = resolveSpecifier(join(root, current), imp.n);
      if (resolved === null || seen.has(resolved)) continue;
      seen.set(resolved, [...seen.get(current)!, resolved]);
      queue.push(resolved);
    }
  }

  return seen;
}

/**
 * 被单测 import 时不要执行主流程。
 *
 * 用 `import.meta.url` 与 argv 比对：Vitest 加载本模块时 argv[1] 指向测试文件。
 */
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  await run();
}

async function run(): Promise<void> {
  let failures = 0;
  await init;

  for (const entry of ENTRIES) {
    if (!existsSync(entry)) {
      console.error(`[error] 入口不存在：${relative(root, entry)}`);
      failures += 1;
      continue;
    }

    const graph = await walk(entry);
    const violations: Violation[] = [];
    /** 引用了我方存储层、但靠 tree-shaking 兜住的模块——需由产物校验背书 */
    const treeShaken: string[] = [];

    for (const [module, path] of graph) {
      if (ALLOWED[module]) continue;

      // 靠 tree-shaking 兜住的模块：**两条源码判定都跳过**，
      // 改由产物校验（verifyBundle）背书。理由见 TREE_SHAKEN_ALLOWED 的注释。
      const isTreeShaken = TREE_SHAKEN_ALLOWED.has(module);

      // 1) 可达性：不得触达存储层
      for (const prefix of FORBIDDEN_MODULE_PREFIXES) {
        if (module.startsWith(prefix)) {
          if (isTreeShaken) treeShaken.push(module);
          else violations.push({ kind: 'module', message: `依赖图触达存储模块 ${module}`, path });
        }
      }
      if (isTreeShaken) continue;

      // 2) 源码特征：不得**可执行地**引用平台存储 API（注释不算引用）
      const code = stripNonCode(readFileSync(join(root, module), 'utf8'));
      for (const { pattern, label } of FORBIDDEN_APIS) {
        const match = pattern.exec(code);
        if (match) {
          const line = code.slice(0, match.index).split('\n').length;
          violations.push({ kind: 'api', message: `${module}:${line} 可执行地引用 ${label}`, path });
        }
      }
    }

    const entryRel = relative(root, entry).split('\\').join('/');

    if (violations.length > 0) {
      failures += violations.length;
      console.error(`\n[boundary] ${entryRel} 的依赖图越界（${violations.length} 处）：\n`);
      for (const v of violations) {
        console.error(`  ✗ ${v.message}`);
        console.error(`    引入链路：${v.path.join(' → ')}`);
        console.error('');
      }
      console.error('内容脚本运行在宿主页面源，其 Web 存储访问落在**宿主页面**上，');
      console.error('不是扩展源。数据必须经 runtime.sendMessage 向后台要（decisions/0010）。');
      console.error('若某个模块确实安全，请在 scripts/check-content-boundary.ts 的');
      console.error('ALLOWED 里显式登记并写明理由。\n');
      continue;
    }

    console.log(
      JSON.stringify(
        {
          entry: entryRel,
          modules: graph.size,
          allowed: Object.keys(ALLOWED).filter((m) => graph.has(m)),
          // 靠 tree-shaking 兜住的引用：源码可达，但产物里不该留下痕迹。
          // 列出它是**故意的**——这是脆弱点，改动 kv.ts 时要多看一眼。
          // 理想值是空数组：说明依赖图上根本不存在"为常量而拉进存储层"的边。
          treeShakenReliance: treeShaken,
          violations: 0,
        },
        null,
        2,
      ),
    );
  }

  /**
   * 产物校验 —— 本门禁最强的一条。
   *
   * 源码层判定会受 tree-shaking 影响。所以最终判定落在**真正会跑的东西**上：
   * 产物里出现存储 API 即失败，与源码怎么写、摇树怎么走都无关。
   */
  const bundleIssues = verifyBundle();
  if (bundleIssues.length > 0) {
    failures += bundleIssues.length;
    console.error(`\n[boundary] 内容脚本产物越界（${bundleIssues.length} 处）：\n`);
    for (const issue of bundleIssues) console.error(`  ✗ ${issue}`);
    console.error('');
    console.error('源码可能看着没问题（甚至依赖图也干净），但产物是最终会执行的东西。');
    console.error('常见原因：给 utils/db/* 加了顶层副作用，tree-shaking 不再生效。\n');
  }

  if (failures > 0) {
    console.error(`内容脚本边界校验失败：${failures} 处。`);
    process.exit(1);
  }
}
