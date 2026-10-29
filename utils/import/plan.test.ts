/**
 * 合并策略与预演统计的测试（PLAN.md FR-J4 / FR-J5 / FR-J7 的纯函数部分）。
 *
 * 这里逐条验的是"库里已有的东西不会被导入值改坏"与"统计口径"。
 * 幂等（FR-J6）需要真实数据库，在 `apply.test.ts` 里验。
 */
import { describe, expect, it } from 'vitest';
import { makeWord } from '../manager/testing';
import { parseImport } from './parse';
import { planImport, type DictProbe, type ExistingData } from './plan';
import { leximateBackup, metwordExport } from './testing';

/** 假词库：`run` / `jump` 收录，`proof` 不收录 */
const probe: DictProbe = {
  lookup(surface) {
    const table: Record<string, { lemma: string; phoneticUs: string; defZh: string[]; pos: string[] }> = {
      run: { lemma: 'run', phoneticUs: 'rʌn', defZh: ['v. 跑'], pos: ['v.'] },
      running: { lemma: 'run', phoneticUs: 'rʌn', defZh: ['v. 跑'], pos: ['v.'] },
      jump: { lemma: 'jump', phoneticUs: 'dʒʌmp', defZh: ['v. 跳'], pos: ['v.'] },
    };
    return table[surface.trim().toLowerCase()];
  },
};

const noExisting: ExistingData = { words: [], sceneHashes: new Set() };

function bundleOf(words: Parameters<typeof metwordExport>[0]) {
  return parseImport(JSON.stringify(metwordExport(words)));
}

describe('FR-J5：同词按 lemma 归并', () => {
  it('词形还原后落到同一个词条（running 与 run 不是两个词）', () => {
    const plan = planImport(
      bundleOf([
        { word: 'running', meetCount: 3, scenes: [{ text: 'I am running.' }] },
        { word: 'run', meetCount: 5, scenes: [{ text: 'I run daily.' }] },
      ]),
      noExisting,
      { probe, now: 1000, newId: idFactory() },
    );

    expect(plan.stats.fileWords).toBe(2);
    expect(plan.stats.words).toBe(1);
    expect(plan.words[0]!.lemma).toBe('run');
    // 次数取较大值
    expect(plan.words[0]!.word.meetCount).toBe(5);
    // 两条例句都留下（文件内同词合并）
    expect(plan.words[0]!.scenes).toHaveLength(2);
  });

  it('合并同词时 status 与 M0 脚本同口径：任一条已掌握就是已掌握', () => {
    const plan = planImport(
      bundleOf([
        { word: 'run', status: 'new' },
        { word: 'run', status: 'known' },
      ]),
      noExisting,
      { probe, now: 1000, newId: idFactory() },
    );
    expect(plan.words[0]!.word.status).toBe('known');
  });
});

describe('FR-J4：库里已有的释义与音标不被覆盖', () => {
  const existingWord = makeWord({
    lemma: 'run',
    surface: 'running',
    defZh: ['自撰释义'],
    defSrc: 'authored',
    phoneticUs: 'rʌn',
    phoneticSrc: 'pipeline',
    meetCount: 2,
    status: 'ignored',
    createdAt: 500,
  });
  const existing: ExistingData = { words: [existingWord], sceneHashes: new Set() };

  const plan = planImport(
    bundleOf([{ word: 'run', meetCount: 9, defZh: ['原平台释义'], phoneticUs: 'ˈrʌnɪŋ' }]),
    existing,
    { probe, now: 1000, newId: idFactory() },
  );
  const word = plan.words[0]!.word;

  it('释义与音标仍是库里的那一份（来源标记也不变）', () => {
    expect(word.defZh).toEqual(['自撰释义']);
    expect(word.defSrc).toBe('authored');
    expect(word.phoneticUs).toBe('rʌn');
    expect(word.phoneticSrc).toBe('pipeline');
  });

  it('imported 的释义不会被塞进 defZh（只在未收录时进 fallbackDef）', () => {
    expect(word.fallbackDef).toEqual([]);
  });

  it('meetCount 取较大值、status 以导入值为准（FR-J5 原话）', () => {
    expect(word.meetCount).toBe(9);
    expect(word.status).toBe('new');
    expect(plan.stats.meetCountRaised).toBe(1);
    expect(plan.stats.statusChanged).toBe(1);
  });

  it('id 与 createdAt 沿用库里那条（不是新建一个词）', () => {
    expect(plan.words[0]!.action).toBe('update');
    expect(word.id).toBe(existingWord.id);
    expect(word.createdAt).toBe(500);
  });
});

describe('FR-J5：词库未收录的词保留原始释义', () => {
  const plan = planImport(
    bundleOf([{ word: 'proof', defZh: ['n. 证据', 'v. 防…'], meetCount: 4 }]),
    noExisting,
    { probe, now: 1000, newId: idFactory() },
  );
  const word = plan.words[0]!.word;

  it('未收录标记为 true，原平台释义进 fallbackDef，defZh 保持空', () => {
    expect(word.isUnlisted).toBe(true);
    expect(word.fallbackDef).toEqual(['n. 证据', 'v. 防…']);
    expect(word.defZh).toEqual([]);
    expect(word.defSrc).toBeNull();
    expect(plan.stats.unlistedWords).toBe(1);
  });

  it('FR-J7 的 K 就是它', () => {
    expect(plan.stats.unlistedWords).toBe(1);
  });
});

describe('词库命中的词用词库的音标与释义（FR-B9 / FR-B10）', () => {
  const plan = planImport(bundleOf([{ word: 'jump' }]), noExisting, {
    probe,
    now: 1000,
    newId: idFactory(),
  });
  const word = plan.words[0]!.word;

  it('音标来自 pipeline、释义来自 authored，且都带来源标记', () => {
    expect(word.phoneticUs).toBe('dʒʌmp');
    expect(word.phoneticSrc).toBe('pipeline');
    expect(word.defZh).toEqual(['v. 跳']);
    expect(word.defSrc).toBe('authored');
  });

  it('没有例句也算导入成功（不丢词）', () => {
    expect(plan.words[0]!.scenes).toHaveLength(0);
    expect(plan.stats.newWords).toBe(1);
  });
});

describe('FR-J6 的判据（纯函数部分）：例句按 contentHash 去重', () => {
  const word = makeWord({ lemma: 'run', id: 'w1' });
  // 库里已经有这一句：hash 与 apply 时算出来的一致
  const plan0 = planImport(bundleOf([{ word: 'run', scenes: [{ text: 'I run daily.' }] }]), noExisting, {
    probe,
    now: 1000,
    newId: idFactory(),
  });
  const firstScene = plan0.words[0]!.scenes[0]!;
  const existing: ExistingData = {
    words: [{ ...word, id: firstScene.wordId }],
    sceneHashes: new Set([firstScene.contentHash]),
  };

  const plan = planImport(
    bundleOf([
      {
        word: 'run',
        scenes: [{ text: 'I run daily.' }, { text: 'She runs.' }, { text: 'She runs.' }],
      },
    ]),
    existing,
    { probe, now: 2000, newId: idFactory() },
  );

  it('已存在的例句不重复写，文件内重复的也只算一条', () => {
    expect(plan.words[0]!.fileScenes).toBe(2); // 文件内去重后：'I run daily.' + 'She runs.'
    expect(plan.words[0]!.duplicateScenes).toBe(1); // 库里已有 'I run daily.'
    expect(plan.words[0]!.scenes.map((scene) => scene.text)).toEqual(['She runs.']);
    expect(plan.stats.newScenes).toBe(1);
    expect(plan.stats.duplicateScenes).toBe(1);
  });

  it('统计不变式：新增 + 已存在 = 这批词带来的例句数', () => {
    expect(plan.stats.newScenes + plan.stats.duplicateScenes).toBe(plan.stats.scenes);
  });
});

describe('墓碑与时间兜底', () => {
  it('墓碑会被复活（deletedAt 清空、id 沿用）', () => {
    const dead = makeWord({ lemma: 'run', deletedAt: 123 });
    const plan = planImport(bundleOf([{ word: 'run' }]), { words: [dead], sceneHashes: new Set() }, {
      probe,
      now: 1000,
      newId: idFactory(),
    });
    expect(plan.words[0]!.word.id).toBe(dead.id);
    expect(plan.words[0]!.word.deletedAt).toBeNull();
  });

  it('时间解析不出来时用导入时间兜底，并按解析结果建词', () => {
    const bundle = parseImport(
      JSON.stringify(
        metwordExport([
          { word: 'jump', firstSeenAt: '不是日期', scenes: [{ text: 'x', capturedAt: '' }] },
        ]),
      ),
    );
    const plan = planImport(bundle, noExisting, { probe, now: 4242, newId: idFactory() });

    expect(plan.words[0]!.word.createdAt).toBe(4242);
    expect(plan.words[0]!.scenes[0]!.capturedAt).toBe(4242);
    expect(plan.stats.unparsedTimes).toBe(2);
  });
});

describe('预演样本', () => {
  it('按 lemma 排序并给出前 N 个（预演与执行看到同一顺序）', () => {
    const plan = planImport(
      bundleOf([{ word: 'run' }, { word: 'jump' }, { word: 'proof' }]),
      noExisting,
      { probe, now: 1000, newId: idFactory(), sampleSize: 2 },
    );
    expect(plan.words.map((item) => item.lemma)).toEqual(['jump', 'proof', 'run']);
    expect(plan.samples.map((item) => item.lemma)).toEqual(['jump', 'proof']);
    expect(plan.samples[1]).toMatchObject({ action: 'create', unlisted: true, scenes: 0 });
  });
});

/** 可预测的 id：让"每次新建的 id 不同"不干扰断言 */
function idFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

/**
 * FR-J5 的 `status` 合并口径（`decisions/0026` 修订）。
 *
 * 要防的场景：**导入 → 本地把词标成"已掌握" → 再导一次旧备份 → 不该被打回"生词"**。
 *
 * 口径：
 * - 本项目的 JSON 备份带每词 `updatedAt` → **文件那条更新才覆盖 status**，否则保留本地；
 * - MetWord 存量文件没有可靠的 per-word 修改时间 → 维持"以导入值为准"（上一条 describe 里的用例锁着）。
 */
describe('FR-J5：status 按 updatedAt 保护（decisions/0026）', () => {
  const LOCAL_UPDATED = 2000;
  const OLDER_BACKUP = 1000;
  const NEWER_BACKUP = 3000;

  function backupBundle(status: 'new' | 'known', updatedAt: number) {
    const word = makeWord({ lemma: 'run', status, meetCount: 1, updatedAt });
    return parseImport(JSON.stringify(leximateBackup({ words: [word], scenes: [] })));
  }

  function existingWith(status: 'new' | 'known', updatedAt: number): ExistingData {
    return {
      words: [makeWord({ lemma: 'run', status, meetCount: 1, updatedAt })],
      sceneHashes: new Set(),
    };
  }

  it('备份更旧 → 保留本地状态（本地已掌握不被旧备份打回生词）', () => {
    const plan = planImport(
      backupBundle('new', OLDER_BACKUP),
      existingWith('known', LOCAL_UPDATED),
      { probe, now: 9000, newId: idFactory() },
    );

    const merged = plan.words[0]!;
    expect(merged.word.status).toBe('known');
    // 没有真的改状态，就不该计进"导入值改掉库里状态的词数"
    expect(plan.stats.statusChanged).toBe(0);
  });

  it('备份更新 → 以导入值为准（换机恢复能把状态带回来）', () => {
    const plan = planImport(
      backupBundle('known', NEWER_BACKUP),
      existingWith('new', LOCAL_UPDATED),
      { probe, now: 9000, newId: idFactory() },
    );

    expect(plan.words[0]!.word.status).toBe('known');
    expect(plan.stats.statusChanged).toBe(1);
  });

  it('两处时间相同 → 以导入值为准（不制造"永远保留本地"的死角）', () => {
    const plan = planImport(
      backupBundle('known', LOCAL_UPDATED),
      existingWith('new', LOCAL_UPDATED),
      { probe, now: 9000, newId: idFactory() },
    );

    expect(plan.words[0]!.word.status).toBe('known');
  });

  it('MetWord 格式（没有 per-word 时间）→ 仍以导入值为准', () => {
    const plan = planImport(
      bundleOf([{ word: 'run', status: 'known' }]),
      existingWith('new', LOCAL_UPDATED),
      { probe, now: 9000, newId: idFactory() },
    );

    expect(plan.words[0]!.word.status).toBe('known');
    expect(plan.stats.statusChanged).toBe(1);
  });

  it('库里没有这个词时，导入值照常进来（保护只针对"已有记录被覆盖"）', () => {
    const plan = planImport(backupBundle('known', OLDER_BACKUP), noExisting, {
      probe,
      now: 9000,
      newId: idFactory(),
    });

    expect(plan.words[0]!.word.status).toBe('known');
  });
});
