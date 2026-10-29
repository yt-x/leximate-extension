/**
 * 管理台的数据装载：把 `Word` 与例句聚成列表行（`ListRow`）。
 *
 * 与筛选/排序分离是刻意的：那一层是纯函数（可完整单测），
 * 这一层才碰 IndexedDB。这样"筛选逻辑对不对"不必起数据库就能测。
 *
 * 口径沿用 `listWords`：**整表读进内存**。1 万词实测远快于 300ms 预算
 * （`verification/M1-2.md`），等规模上来再换游标分页。
 */
import { listWords } from '../db/words';
import { readTx, req, STORE } from '../db/schema';
import type { Word } from '../db/types';
import type { ListRow } from './filter';

export interface SceneFact {
  wordId: string;
  domain: string;
}

export interface LoadOptions {
  wordLoader?: () => Promise<Word[]>;
  sceneLoader?: () => Promise<SceneFact[]>;
}

/**
 * 装载列表行。
 *
 * **为什么要一次读全表 `scenes`**：FR-F2 的列表要显示"例句数"与"来源域名"，
 * 两项都不在 `Word` 上。逐词查询是 N+1 次事务（1 万词 = 1 万次），
 * 所以一次读回后在内存里归组。
 */
export async function loadRows(options: LoadOptions = {}): Promise<ListRow[]> {
  // 默认只读**活着的**词：墓碑（`deletedAt`）是给同步用的删除标记，
  // 读进来只会被筛选层丢掉，却会让"加载到的总数"把删掉的词也算上
  // （实测形态：删光之后计数显示 `0 / 67`）。
  const loadWords = options.wordLoader ?? (() => listWords());
  const loadScenes = options.sceneLoader ?? defaultSceneLoader;

  const [words, scenes] = await Promise.all([loadWords(), loadScenes()]);

  // 一次归组，避免对每个词做线性查找
  const sceneDomains = new Map<string, string[]>();
  for (const scene of scenes) {
    const list = sceneDomains.get(scene.wordId);
    if (list) list.push(scene.domain);
    else sceneDomains.set(scene.wordId, [scene.domain]);
  }

  return words.map((word) => {
    const domains = sceneDomains.get(word.id) ?? [];

    // 每个域名下的例句条数（不去重）
    const domainCounts: Record<string, number> = {};
    for (const domain of domains) {
      if (domain === '') continue;
      domainCounts[domain] = (domainCounts[domain] ?? 0) + 1;
    }

    return {
      word,
      // 例句**条数**（含重复域名）——列表显示的是"有几条例句"
      sceneCount: domains.length,
      // 域名**去重**——列表显示的是"来自哪些站"
      domains: Object.keys(domainCounts),
      domainCounts,
    };
  });
}

async function defaultSceneLoader(): Promise<SceneFact[]> {
  const all = await readTx(STORE.scenes, (tx) =>
    req<Array<{ wordId: string; domain: string }>>(tx.objectStore(STORE.scenes).getAll()),
  );
  return all.map((s) => ({ wordId: s.wordId, domain: s.domain }));
}
