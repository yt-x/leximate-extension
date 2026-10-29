/**
 * 浏览器侧的词库装配（PLAN.md §4.5 P2/P3）。
 *
 * 为什么抽出来：**内容脚本与管理台都要查词库**——内容脚本划词要查，
 * 管理台的导入器预演要判断"哪些词词库未收录"（FR-J7 的 K）。
 * 两边各写一遍"载入清单 + 变形索引 + 查询器"必然慢慢分叉，
 * 而分叉的表现是"同一份文件在内容脚本里查得到、在导入预演里算未收录"。
 *
 * ⚠️ **本函数不 `warm()`**：拉清单与常驻分片由调用方决定时机
 * （内容脚本在 `controller.start()` 里 warm，导入器在预演前 warm）。
 * 也不要在没 warm 的情况下查——未载入会被当成"未收录"
 * （`CONSTRAINTS.md` 第 34 条）。
 */
import { parseInflections, toReverseIndex } from './inflections';
import { createLemmatizer } from './lemmatize';
import { createDictLookup, type DictLookup } from './lookup';
import { createFetchSource, createMessageSource, type DictSource } from './source';

/**
 * 造一个词库查询器。
 *
 * `source` 决定"怎么读分片"：
 * - **内容脚本传 `createMessageSource(browser.runtime.sendMessage)`**——它直接 `fetch` 会被页面 CSP 拦（见 `source.ts`）；
 * - **管理台/后台可传 `createFetchSource(...)`**——那里是扩展源，不受页面 CSP 限制；
 * - 测试传 `createMemorySource`。
 */
export async function createBrowserDictLookup(source: DictSource): Promise<DictLookup> {
  const artifact = await loadInflectionsFrom(source);
  const reverse = toReverseIndex(artifact);

  // 循环引用：词形还原要问"还原出来的词在不在词库里"，而词库查询器又要用还原器。
  // 闭包在**调用时**才读 `dict`，那时它一定已经赋值。
  const dict = createDictLookup(source, {
    lemmatize: createLemmatizer(reverse, (lemma) => dict.lookup(lemma) !== undefined),
  });

  return dict;
}

/** 读变形索引（`inflections.json`），走同一个 source */
async function loadInflectionsFrom(source: DictSource) {
  return parseInflections(await source.readShard('inflections.json'));
}

/** 内容脚本用：经后台消息读分片 */
export function createContentDictLookup(
  send: (file: string) => Promise<unknown>,
): Promise<DictLookup> {
  return createBrowserDictLookup(createMessageSource(send));
}

/** 扩展页面用：直接 fetch 扩展资源（不受页面 CSP 限制） */
export function createPageDictLookup(baseUrl: string): Promise<DictLookup> {
  return createBrowserDictLookup(createFetchSource(baseUrl));
}

/**
 * 让这批词形的查询都落在已载入的分片上。
 *
 * 只有**未命中常驻分片**的词才需要补拉它首字母所在的分片；
 * 已经命中的不必拉（`ensureFor` 因此可以省掉大量请求）。
 */
export async function warmDictForWords(
  dict: DictLookup,
  words: readonly string[],
): Promise<void> {
  const pending = new Set<string>();
  for (const word of words) {
    const surface = word.trim();
    if (surface === '') continue;
    if (dict.lookup(surface) !== undefined) continue;
    pending.add(surface);
  }

  for (const surface of pending) {
    await dict.ensureFor(surface);
  }
}
