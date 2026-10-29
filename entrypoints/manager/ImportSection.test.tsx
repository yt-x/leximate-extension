/**
 * 导入区的界面测试（PLAN.md FR-J4 ~ FR-J7）。
 *
 * 纯函数层与写入层分别在 `utils/import/*.test.ts` 里验；
 * 这一层验的是**接得对**：选了文件会不会预演、点了确认会不会真的写库、
 * 失败看不看得见。数据用真实 IndexedDB（fake-indexeddb），只有词库探针是假的
 * ——桩的是"词库内容"，不是被测代码。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { countScenes, listScenesByWord, listWords, upsertWord } from '@/utils/db/words';
import { applyImportPlan, type DictProbe } from '@/utils/import';
import { metwordExport } from '@/utils/import/testing';
import { ImportSection, type ImportDeps } from './ImportSection';

/** 假词库：`run`/`running`/`gone` 收录，`proof` 不收录 */
const probe: DictProbe = {
  lookup(surface) {
    const table: Record<string, { lemma: string; phoneticUs: string; defZh: string[]; pos: string[] }> = {
      run: { lemma: 'run', phoneticUs: 'rʌn', defZh: ['v. 跑'], pos: ['v.'] },
      running: { lemma: 'run', phoneticUs: 'rʌn', defZh: ['v. 跑'], pos: ['v.'] },
      gone: { lemma: 'gone', phoneticUs: 'ɡɒn', defZh: ['go 的过去分词'], pos: ['v.'] },
    };
    return table[surface.trim().toLowerCase()];
  },
};

function deps(over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    prepareProbe: async () => probe,
    applyPlan: applyImportPlan,
    ...over,
  };
}

async function pickFile(json: unknown, name = 'metword-export-20261013.json') {
  const input = screen.getByLabelText('选择导入文件') as HTMLInputElement;
  const file = new File([JSON.stringify(json)], name, { type: 'application/json' });
  // jsdom 里 `files` 是只读的，直接赋值会被忽略
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

const FILE = metwordExport([
  {
    word: 'running',
    meetCount: 4,
    defZh: ['原平台释义'],
    scenes: [{ text: 'I am running.' }, { text: 'Running is fun.' }],
  },
  { word: 'proof', meetCount: 2, defZh: ['n. 证据'] },
]);

describe('FR-J7：先预演，确认后才写库', () => {
  it('选文件后显示"将导入 N 词 / M 句，其中 K 词词库未收录"，且库里还没有任何东西', async () => {
    render(<ImportSection deps={deps()} />);
    await pickFile(FILE);

    const dialog = await screen.findByRole('alertdialog', { name: '确认导入' });
    expect(dialog.textContent).toContain('将导入');
    expect(dialog.textContent).toContain('2');
    expect(dialog.textContent).toContain('词库未收录');

    // 预演**本身不写库**：这才是 FR-J7 的后半句
    expect(await listWords()).toHaveLength(0);
    expect(await countScenes()).toBe(0);
  });

  it('点"取消"什么也不写', async () => {
    render(<ImportSection deps={deps()} />);
    await pickFile(FILE);
    await screen.findByRole('alertdialog', { name: '确认导入' });

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await listWords()).toHaveLength(0);
  });

  it('点"确认导入"后词与例句真的进库，并显示结果', async () => {
    render(<ImportSection deps={deps()} />);
    await pickFile(FILE);
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));

    await waitFor(async () => expect(await listWords()).toHaveLength(2));
    expect(await countScenes()).toBe(2);
    expect(screen.getByText(/已导入 2 词/)).toBeDefined();
    // 未收录的释义进了兜底字段（界面提示里说明）
    expect(screen.getByText(/词库未收录，原平台释义已作为兜底保留/)).toBeDefined();

    const run = (await listWords()).find((word) => word.lemma === 'run')!;
    expect(run.phoneticSrc).toBe('pipeline');
    const proof = (await listWords()).find((word) => word.lemma === 'proof')!;
    expect(proof.fallbackDef).toEqual(['n. 证据']);
  });
});

describe('FR-J4：库里已有的释义与音标不被覆盖', () => {
  it('已自撰的释义与已算出的音标保持原样', async () => {
    await upsertWord({
      lemma: 'run',
      surface: 'runs',
      defZh: ['自撰释义'],
      defSrc: 'authored',
      phoneticUs: 'rʌn',
      phoneticSrc: 'pipeline',
    });

    render(<ImportSection deps={deps()} />);
    await pickFile(metwordExport([{ word: 'running', defZh: ['原平台释义'], phoneticUs: 'ˈrʌnɪŋ' }]));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));

    await waitFor(() => expect(screen.getByText(/已导入 1 词/)).toBeDefined());

    const run = (await listWords())[0]!;
    expect(run.defZh).toEqual(['自撰释义']);
    expect(run.defSrc).toBe('authored');
    expect(run.phoneticUs).toBe('rʌn');
    expect(run.phoneticSrc).toBe('pipeline');
    expect(run.surface).toBe('runs');
  });
});

describe('FR-J6：重复导入同一份文件', () => {
  it('第二次导入不增加词与例句，并显示"已存在"', async () => {
    render(<ImportSection deps={deps()} />);

    await pickFile(FILE);
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    await waitFor(async () => expect(await listWords()).toHaveLength(2));

    // 同一份文件再来一次
    await pickFile(FILE);
    const dialog = await screen.findByRole('alertdialog', { name: '确认导入' });
    expect(dialog.textContent).toContain('新增 0 词');
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));

    await waitFor(() => expect(screen.getByText(/已导入 2 词/)).toBeDefined());
    expect(await listWords()).toHaveLength(2);
    expect(await countScenes()).toBe(2);
  });

  it('第二次导入的例句 id 与第一次相同（没有重建）', async () => {
    render(<ImportSection deps={deps()} />);
    await pickFile(FILE);
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    await waitFor(async () => expect(await listWords()).toHaveLength(2));

    const run = (await listWords()).find((word) => word.lemma === 'run')!;
    const idsBefore = (await listScenesByWord(run.id)).map((scene) => scene.id);

    await pickFile(FILE);
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(screen.getByText(/已导入 2 词/)).toBeDefined());

    expect((await listScenesByWord(run.id)).map((scene) => scene.id)).toEqual(idsBefore);
  });
});

describe('失败可见', () => {
  it('认不出的文件显示错误，不写任何东西', async () => {
    render(<ImportSection deps={deps()} />);
    await pickFile({ hello: 'world' }, 'unknown.json');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('认不出这个文件的格式');
    expect(await listWords()).toHaveLength(0);
  });

  it('不是 JSON 的文件同样报错', async () => {
    render(<ImportSection deps={deps()} />);
    const input = screen.getByLabelText('选择导入文件') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['word,phonetic\nrun,rʌn'], 'a.csv', { type: 'text/csv' })],
      configurable: true,
    });
    fireEvent.change(input);

    expect((await screen.findByRole('alert')).textContent).toContain('合法的 JSON');
  });
});

describe('导入后通知后台', () => {
  it('写库成功后发一条 data-changed（后台据此重算角标）', async () => {
    const browserStub = (globalThis as unknown as { browser: { runtime: { sendMessage: unknown } } })
      .browser;
    const original = browserStub.runtime.sendMessage;
    const sendMessage = vi.fn(async () => undefined);
    browserStub.runtime.sendMessage = sendMessage;

    try {
      render(<ImportSection deps={deps()} />);
      await pickFile(FILE);
      fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));

      await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    } finally {
      browserStub.runtime.sendMessage = original;
    }
  });
});
