/**
 * 导出的数据装载（PLAN.md FR-G8：导出**无损**——不修改、不删除任何本地数据）。
 *
 * 这一层是 `utils/export/` 里唯一碰 IndexedDB 的部分，而且**只读**：
 * 两个默认装载函数走 `readTx`，整个导出链路没有任何写库动作
 * （写 `meta.lastExportAt` 是唯一的例外，由界面层显式做，且不动词与例句）。
 *
 * 为什么一次读全表而不是逐词查：与 `loadRows` 同一个理由——
 * 逐词查询是 N+1 次事务（1 万词 = 1 万次），而导出本来就要读全部例句。
 */
import { readTx, req, STORE } from '../db/schema';
import { listWords } from '../db/words';
import type { Scene, Word } from '../db/types';
import type { ListRow } from '../manager/filter';
import { sortScenes, type RecordInput } from './record';

export interface CollectOptions {
  wordLoader?: () => Promise<Word[]>;
  /** 例句装载器（测试注入用）。默认读全表 */
  sceneLoader?: () => Promise<Scene[]>;
}

async function defaultSceneLoader(): Promise<Scene[]> {
  return readTx(STORE.scenes, (tx) => req<Scene[]>(tx.objectStore(STORE.scenes).getAll()));
}

/**
 * 例句按词归组，**每组内已按采集时间排好**。
 *
 * 排序在这里做一次，下游（构建记录、组装备份）就不必各自再排一遍——
 * 而"导出的 `source` 取首条例句"这条约定依赖顺序必须确定。
 */
export async function loadScenesByWord(options: CollectOptions = {}): Promise<Map<string, Scene[]>> {
  const load = options.sceneLoader ?? defaultSceneLoader;
  const all = await load();

  const grouped = new Map<string, Scene[]>();
  for (const scene of all) {
    const list = grouped.get(scene.wordId);
    if (list) list.push(scene);
    else grouped.set(scene.wordId, [scene]);
  }
  for (const [wordId, list] of grouped) grouped.set(wordId, sortScenes(list));

  return grouped;
}

/** 供 `buildRecords` 用：按**列表顺序**取出每行的词与例句 */
export function toRecordInputs(
  rows: readonly ListRow[],
  scenesByWord: ReadonlyMap<string, Scene[]>,
): RecordInput[] {
  return rows.map((row) => ({ word: row.word, scenes: scenesByWord.get(row.word.id) ?? [] }));
}

export interface BackupData {
  words: Word[];
  scenes: Scene[];
}

/**
 * 备份载荷用的原始数据（词 + 例句，顺序与列表一致）。
 *
 * 与 `toRecordInputs` 分开：备份要的是**原始记录**（能回灌），
 * 而 CSV/TSV 要的是**扁平成字符串的记录**（给人看）。两者的取值口径不同，
 * 合成一个函数就会让"备份里少了字段"这种错悄悄发生。
 */
export function collectBackupData(
  rows: readonly ListRow[],
  scenesByWord: ReadonlyMap<string, Scene[]>,
): BackupData {
  const words: Word[] = [];
  const scenes: Scene[] = [];

  for (const row of rows) {
    words.push(row.word);
    for (const scene of scenesByWord.get(row.word.id) ?? []) scenes.push(scene);
  }

  return { words, scenes };
}

/** 全部活着的词（`listWords` 的默认口径已排除墓碑，见 `CONSTRAINTS.md` 第 28 条） */
export async function loadAllWords(options: CollectOptions = {}): Promise<Word[]> {
  const load = options.wordLoader ?? (() => listWords());
  return load();
}
