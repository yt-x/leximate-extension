/**
 * 合并策略与预演统计（PLAN.md FR-J4、FR-J5、FR-J6、FR-J7）。
 *
 * ## 为什么"预演"和"执行"共用这一个函数
 *
 * FR-J7 要求**预演数字与真实导入后的统计一致**。如果预演自己算一遍、
 * 执行时再算一遍，两份统计一定会随改动漂移（而漂移的表现是"预演说 537 词，
 * 导完显示 539"这种没人能解释的差）。这里的做法是：
 * `planImport()` 产出**将要写什么**（完整的 `Word` 记录 + 要新增的 `Scene`），
 * `applyImportPlan()` 只执行它并**原样返回同一个 stats 对象**。
 * 两边不可能算出不同的数字，因为它们只算了一次。
 *
 * ## 合并规则（每条对应 FR 原话）
 *
 * | 规则 | 依据 |
 * |---|---|
 * | 音标、释义**库里已有则库里赢**，库里为空才采纳导入值 | FR-J4："不是无条件用导入数据重算" |
 * | 词库命中 → 用词库的 `lemma` / 释义 / 音标（来源标 `pipeline` / `authored`） | FR-B3 / FR-B9 / FR-B10 |
 * | `meetCount = max(库里, 导入)` | FR-J5。⚠️ 不能用 `upsertWord`（它是"+1"） |
 * | `status` 按 `updatedAt` 保护：只有本项目备份带每词修改时间，文件更新才覆盖，否则保留本地
 *   （MetWord 存量文件没有可靠时间，仍以导入值为准） | FR-J5 + `decisions/0026` |
 * | 词库未收录 → 导入的释义进 `fallbackDef` | FR-J5 |
 * | 例句按 `sceneHash(wordId, text)` 去重 | FR-J6 的幂等落点，与 `addScene` 同一把钥匙 |
 */
import { normalizeLemma, domainOf } from '../db/words';
import { sceneHash } from '../hash';
import type {
  DefinitionSource,
  PhoneticSource,
  Scene,
  Word,
  WordOrigin,
  WordStatus,
} from '../db/types';
import type { ImportBundle, ImportScene, ImportWord } from './parse';

/** 词库的一次命中（只带导入需要的字段） */
export interface DictProbeEntry {
  lemma: string;
  phoneticUs: string;
  defZh: string[];
  pos: string[];
}

/**
 * 词库探针。
 *
 * ⚠️ **调用方必须保证词库已载入**（含低频分片，见 `warmDictForWords`）：
 * 探针查不到就等于"词库未收录"，而未载入与未收录在结果上无法区分——
 * 那会让整份文件被标成未收录（`CONSTRAINTS.md` 第 34 条：
 * "拿不到"与"是空的"必须分开）。
 */
export interface DictProbe {
  lookup(surface: string): DictProbeEntry | undefined;
}

export interface ExistingData {
  /** 库里的全部词，**含墓碑**（导入要把它复活） */
  words: readonly Word[];
  /** 库里全部例句的 `contentHash`，用于幂等去重 */
  sceneHashes: ReadonlySet<string>;
}

export interface WordPlan {
  action: 'create' | 'update';
  lemma: string;
  unlisted: boolean;
  /** 将要写入的完整记录（id 已定：已存在的词沿用原 id） */
  word: Word;
  /** 预演时当前词的修改时间；执行时用于识别预演后的本地修改 */
  currentUpdatedAt: number | null;
  /** 将要新增的例句（库里已有的不在其中） */
  scenes: Scene[];
  /** 这个文件为它带来的例句数（去重后） */
  fileScenes: number;
  /** 其中库里已有、本次不写的条数 */
  duplicateScenes: number;
}

export interface ImportStats {
  /** 文件里的词条数（未合并同词） */
  fileWords: number;
  /** 文件里的例句数（未去重） */
  fileScenes: number;
  /** 合并同词后涉及的词数 */
  words: number;
  newWords: number;
  mergedWords: number;
  /** 这批词带来的例句数（文件内去重后） */
  scenes: number;
  newScenes: number;
  /** 库里已有、本次不写的例句数 */
  duplicateScenes: number;
  /** FR-J7 的 K：词库未收录的词数 */
  unlistedWords: number;
  /** 导入值改掉库里状态的词数 */
  statusChanged: number;
  /** 导入值抬高遇见次数的词数 */
  meetCountRaised: number;
  skippedWords: number;
  skippedScenes: number;
  /** 时间解析不出来、用导入时间兜底的条目数 */
  unparsedTimes: number;
}

export interface ImportSample {
  lemma: string;
  action: 'create' | 'update';
  unlisted: boolean;
  scenes: number;
}

export interface ImportPlan {
  format: ImportBundle['format'];
  stats: ImportStats;
  words: WordPlan[];
  /** 预演里给用户看的样本（前 N 个词） */
  samples: ImportSample[];
}

export interface PlanOptions {
  probe: DictProbe;
  /** 注入时间戳（测试用） */
  now?: number;
  /** 生成 id（测试用；默认 `crypto.randomUUID`） */
  newId?: () => string;
  /** 预演样本条数，默认 5 */
  sampleSize?: number;
}

/** 同一个词在文件里出现多次时的合并（M0 脚本会把"标记中"与"已掌握"两批并起来） */
function mergeEntries(items: readonly ImportWord[]): {
  surface: string;
  phoneticUs: string;
  phoneticUk: string;
  defZh: string[];
  meetCount: number;
  status: WordStatus;
  origin: WordOrigin;
  createdAt: number | null;
  scenes: ImportScene[];
  backup: Word | null;
} {
  let surface = '';
  let phoneticUs = '';
  let phoneticUk = '';
  let defZh: string[] = [];
  let meetCount = 1;
  let createdAt: number | null = null;
  let status: WordStatus = 'new';
  let migrated = false;
  let backup: Word | null = null;
  const scenes: ImportScene[] = [];
  const seenText = new Set<string>();

  for (const item of items) {
    if (surface === '') surface = item.surface;
    if (phoneticUs === '') phoneticUs = item.phoneticUs;
    if (phoneticUk === '') phoneticUk = item.phoneticUk;
    if (defZh.length === 0 && item.defZh.length > 0) defZh = item.defZh;
    if (backup === null && item.backup) backup = item.backup;
    meetCount = Math.max(meetCount, item.meetCount);
    if (item.origin === 'migrated') migrated = true;
    if (item.createdAt !== null && (createdAt === null || item.createdAt < createdAt)) {
      createdAt = item.createdAt;
    }
    // 与 M0 脚本同一口径：任一条是"已掌握"，这个词就是已掌握
    if (item.status === 'known') status = 'known';
    else if (item.status === 'ignored' && status === 'new') status = 'ignored';

    for (const scene of item.scenes) {
      if (seenText.has(scene.text)) continue;
      seenText.add(scene.text);
      scenes.push(scene);
    }
  }

  return {
    surface,
    phoneticUs,
    phoneticUk,
    defZh,
    meetCount,
    status,
    origin: migrated ? 'migrated' : 'native',
    createdAt,
    scenes,
    backup,
  };
}

export function planImport(
  bundle: ImportBundle,
  existing: ExistingData,
  options: PlanOptions,
): ImportPlan {
  const now = options.now ?? Date.now();
  const newId = options.newId ?? (() => crypto.randomUUID());
  const sampleSize = options.sampleSize ?? 5;

  const existingByLemma = new Map<string, Word>();
  for (const word of existing.words) existingByLemma.set(word.lemma, word);

  // ① 按 **lemma** 归并：`running` 与 `run` 是同一个词（FR-J5 的"同词"）
  interface Group {
    lemma: string;
    hit: DictProbeEntry | undefined;
    items: ImportWord[];
  }
  const groups = new Map<string, Group>();
  for (const item of bundle.words) {
    const hit = options.probe.lookup(item.raw);
    const lemma = normalizeLemma(hit?.lemma ?? item.raw);
    if (lemma === '') continue;
    const group = groups.get(lemma);
    if (group) group.items.push(item);
    else groups.set(lemma, { lemma, hit, items: [item] });
  }

  const plans: WordPlan[] = [];
  const stats: ImportStats = {
    fileWords: bundle.words.length,
    fileScenes: bundle.words.reduce((total, item) => total + item.scenes.length, 0),
    words: 0,
    newWords: 0,
    mergedWords: 0,
    scenes: 0,
    newScenes: 0,
    duplicateScenes: 0,
    unlistedWords: 0,
    statusChanged: 0,
    meetCountRaised: 0,
    skippedWords: bundle.skippedWords,
    skippedScenes: bundle.skippedScenes,
    unparsedTimes: bundle.unparsedTimes,
  };

  for (const group of groups.values()) {
    const imported = mergeEntries(group.items);
    const current = existingByLemma.get(group.lemma);
    const hit = group.hit;
    /**
     * 合并的**底子**：库里已有 → 用库里的；否则用备份里的原始记录（回灌时保住
     * `examTags`/`freqBnc`/`defSrc`/`inflectionOf` 这些 metword 文件里没有的字段）。
     *
     * ⚠️ 顺序不能反：库里的是用户当前的数据，备份是历史快照。
     */
    const base: Word | null = current ?? imported.backup;
    const unlisted = hit === undefined;
    /**
     * FR-J5 的"未收录"标记。
     *
     * 词库是判定者；但它"不认识"时**不重新打标**——本来就标着已收录的记录
     * （库里的，或备份里的）保持已收录。否则一份备份在一台词库版本不同的机器上回灌，
     * 会把有自撰释义的词统统标成"未收录"。
     */
    const previouslyListed = base !== null && base.isUnlisted === false;
    const isUnlisted = unlisted && !previouslyListed;

    // ② 音标：底子已有 → 底子赢；否则词库（pipeline）优先于导入值
    const basePhonetic = (base?.phoneticUs ?? '') !== '' || (base?.phoneticUk ?? '') !== '';
    const phoneticUs = base?.phoneticUs || hit?.phoneticUs || imported.phoneticUs || '';
    const phoneticUk = base?.phoneticUk || imported.phoneticUk || '';
    const hasPhonetic = phoneticUs !== '' || phoneticUk !== '';
    const phoneticSrc: PhoneticSource = !hasPhonetic
      ? null
      : basePhonetic
        ? (base?.phoneticSrc ?? 'imported')
        : hit && hit.phoneticUs !== '' && phoneticUs === hit.phoneticUs
          ? 'pipeline'
          : 'imported';

    // ③ 释义：底子已有 → 底子赢；否则词库（authored）。导入的释义**不进 defZh**，
    //    只在词库未收录时进 fallbackDef（FR-J5 的"兜底字段"）
    const defZh = (base?.defZh.length ?? 0) > 0 ? (base?.defZh as string[]) : (hit?.defZh ?? []);
    const defSrc: DefinitionSource =
      defZh.length === 0
        ? null
        : (base?.defZh.length ?? 0) > 0
          ? (base?.defSrc ?? 'imported')
          : hit
            ? 'authored'
            : 'imported';

    const fallbackDef =
      (base?.fallbackDef.length ?? 0) > 0
        ? (base?.fallbackDef as string[])
        : isUnlisted
          ? imported.defZh
          : [];

    const surface = base?.surface || imported.surface || group.lemma;
    const meetCount = Math.max(base?.meetCount ?? 0, imported.meetCount);
    // 备份回灌沿用原来的 id：例句的 `contentHash` 是拿它算的，换 id 会让
    // "已经有这批例句"的判断失效（同一份备份导两次就成了两批）
    const id = base?.id ?? newId();

    /**
     * FR-J5（`decisions/0026` 修订）：`status` 按时间戳保护。
     *
     * 只有**本项目的 JSON 备份**带每条词的 `updatedAt`（`imported.backup` 非空）；
     * MetWord 存量文件没有可靠的 per-word 修改时间，那一路维持"以导入值为准"。
     * 要防的场景：导入 → 本地把若干词标成"已掌握" → 再导一次**旧**备份 → 不该被打回"生词"。
     */
    const importedUpdatedAt = imported.backup?.updatedAt ?? null;
    const keepLocalStatus =
      current !== undefined && importedUpdatedAt !== null && current.updatedAt > importedUpdatedAt;
    const status: WordStatus = keepLocalStatus ? current.status : imported.status;

    const word: Word = {
      id,
      lemma: group.lemma,
      surface,
      phoneticUs,
      phoneticUk,
      phoneticSrc,
      defSrc,
      defZh,
      pos: (base?.pos.length ?? 0) > 0 ? (base?.pos as string[]) : (hit?.pos ?? []),
      examTags: base?.examTags ?? [],
      freqBnc: base?.freqBnc ?? 0,
      freqCoca: base?.freqCoca ?? 0,
      exchange: base?.exchange ?? '',
      status,
      meetCount,
      isLemmatized: normalizeLemma(surface) !== group.lemma,
      inflectionOf: base?.inflectionOf ?? null,
      isUnlisted,
      origin: base?.origin ?? imported.origin,
      fallbackDef,
      llmDef: base?.llmDef ?? [],
      createdAt: base?.createdAt || imported.createdAt || now,
      updatedAt: now,
      // 导入要复活墓碑：用户把这份文件导进来，就是要它回来
      deletedAt: null,
    };

    // ④ 例句：按 contentHash 与库里比对（幂等），同一词内再按文本去重
    const scenes: Scene[] = [];
    let duplicates = 0;
    for (const item of imported.scenes) {
      const hash = sceneHash(id, item.text);
      if (existing.sceneHashes.has(hash)) {
        duplicates += 1;
        continue;
      }
      scenes.push({
        id: newId(),
        wordId: id,
        text: item.text,
        highlightFrom: item.highlightFrom,
        highlightTo: item.highlightTo,
        translation: item.translation,
        sourceUrl: item.sourceUrl,
        sourceTitle: '',
        domain: domainOf(item.sourceUrl),
        // 时间解析不出来时用导入时间兜底（解析层已计数上报）
        capturedAt: item.capturedAt ?? now,
        contentHash: hash,
      });
    }

    plans.push({
      action: current ? 'update' : 'create',
      lemma: group.lemma,
      unlisted,
      word,
      currentUpdatedAt: current?.updatedAt ?? null,
      scenes,
      fileScenes: imported.scenes.length,
      duplicateScenes: duplicates,
    });

    // ⑤ 统计（唯一的计算点：预演与执行共用）
    stats.words += 1;
    if (current) stats.mergedWords += 1;
    else stats.newWords += 1;
    if (unlisted) stats.unlistedWords += 1;
    // 只统计**真的改了**的状态（按时间戳保护之后，导入值可能被本地值压过）
    if (current && current.status !== status) stats.statusChanged += 1;
    if (current && meetCount > current.meetCount) stats.meetCountRaised += 1;
    stats.scenes += imported.scenes.length;
    stats.newScenes += scenes.length;
    stats.duplicateScenes += duplicates;
  }

  // 顺序稳定：按 lemma 排，预演与执行看到的顺序一致
  plans.sort((a, b) => a.lemma.localeCompare(b.lemma));

  return {
    format: bundle.format,
    stats,
    words: plans,
    samples: plans.slice(0, sampleSize).map((plan) => ({
      lemma: plan.lemma,
      action: plan.action,
      unlisted: plan.unlisted,
      scenes: plan.scenes.length,
    })),
  };
}
