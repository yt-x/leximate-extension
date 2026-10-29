/**
 * 导出面板的界面测试（PLAN.md FR-G1 ~ FR-G7）。
 *
 * 纯函数层（`utils/export/*.test.ts`）证明"文件内容是对的"，
 * 这一层证明**接得对**：选了 CSV 就一定按 CSV 走、点导出就一定把文件交给
 * `browser.downloads`、失败一定看得见。
 *
 * 数据走真实写入路径（`upsertWord` / `addScene`），因此这里顺带覆盖了
 * "面板 → 装载 → 序列化 → 下载"的整条链路，而不是各段的替身。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { addScene, upsertWord } from '@/utils/db/words';
import { loadRows } from '@/utils/manager/load';
import type { ListRow } from '@/utils/manager/filter';
import { parseDelimited } from '../../tests/csv-parser';
import { ExportPanel } from './ExportPanel';
import { WordList } from './WordList';

interface TestGlobals {
  __leximateDownloads?: Array<{ url: string; filename: string }>;
  __leximateObjectUrls?: Map<string, Blob>;
}

const g = globalThis as unknown as TestGlobals;

/** 取最近一次交给浏览器的文件（jsdom 里由 `tests/setup-ui.ts` 记录） */
async function lastFile(): Promise<{ filename: string; text: string }> {
  const calls = g.__leximateDownloads ?? [];
  const call = calls[calls.length - 1];
  if (!call) throw new Error('没有任何下载发生');
  const blob = g.__leximateObjectUrls?.get(call.url);
  if (!blob) throw new Error(`下载的 URL 没有对应内容：${call.url}`);
  return { filename: call.filename, text: await blob.text() };
}

/**
 * 两个词 + 三条例句，其中含 §3.2.1 的测试点：
 * 双引号、逗号、字面量 `<br>`、中文释义。
 */
async function seedAndLoad(): Promise<ListRow[]> {
  const { word: run } = await upsertWord({
    lemma: 'run',
    surface: 'running',
    defZh: ['v. 跑，奔跑'],
    defSrc: 'authored',
    phoneticUs: 'rʌn',
    phoneticSrc: 'pipeline',
  });
  await addScene({
    wordId: run.id,
    text: 'He said "hi" and ran, fast.',
    highlightFrom: 9,
    highlightTo: 12,
    sourceUrl: 'https://a.com/1',
    // `capturedAt` 显式给：两次 addScene 落在同一毫秒时，顺序要靠 id（uuid）兜底，
    // 那样断言会随运行而变——夹具不该把不确定性带进用例
    capturedAt: 1000,
  });
  await addScene({
    wordId: run.id,
    text: 'literal <br> here',
    highlightFrom: 8,
    highlightTo: 11,
    sourceUrl: 'https://b.com/2',
    capturedAt: 2000,
  });

  const { word: jump } = await upsertWord({
    lemma: 'jump',
    surface: 'jump',
    defZh: ['v. 跳'],
    defSrc: 'authored',
  });
  await addScene({
    wordId: jump.id,
    text: 'Jump now.',
    highlightFrom: 0,
    highlightTo: 4,
    sourceUrl: 'https://c.com/3',
  });

  return loadRows();
}

function renderPanel(rows: ListRow[], over: Partial<Parameters<typeof ExportPanel>[0]> = {}) {
  const onClose = over.onClose ?? (() => {});
  return render(
    <ExportPanel
      rows={rows}
      filtered={rows}
      selection={new Set<string>()}
      onClose={onClose}
      {...over}
    />,
  );
}

describe('范围选择（FR-G1）', () => {
  it('三种范围都显示各自的条数', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows, { filtered: [rows[0] as ListRow], selection: new Set([rows[1]!.word.id]) });

    expect(screen.getByRole('radio', { name: '全部生词（2）' })).toBeDefined();
    expect(screen.getByRole('radio', { name: '当前筛选结果（1）' })).toBeDefined();
    expect(screen.getByRole('radio', { name: '选中项（1）' })).toBeDefined();
  });

  it('从"导出选中"进来时默认范围就是选中项', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows, { initialScope: 'selected', selection: new Set([rows[0]!.word.id]) });

    expect((screen.getByRole('radio', { name: /选中项/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('选中项为空时导出按钮不可点，并说明要先勾选', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows, { initialScope: 'selected' });

    expect(screen.getByText('先在列表里勾选要导出的词。')).toBeDefined();
    expect((screen.getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Anki TSV 导出（§3.2.1）', () => {
  it('文件名合规，内容回读后记录数 = 词数 + 4 行文件头，<br> 保持字面量', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows);

    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await screen.findByText(/已导出/);

    const file = await lastFile();
    expect(file.filename).toMatch(/^leximate-anki-\d{8}-\d{4}\.tsv$/);
    expect(file.text.startsWith('#separator:tab\n#html:false\n')).toBe(true);

    const records = parseDelimited(file.text, '\t');
    expect(records).toHaveLength(rows.length + 4);
    for (const record of records.slice(4)) expect(record).toHaveLength(11);

    const run = records.slice(4).find((record) => record[0] === 'run');
    expect(run?.[3]).toBe('He said "hi" and ran, fast.\nliteral <br> here');
    expect(run?.[1]).toBe('/rʌn/');
  });
});

describe('通用 CSV 导出（§3.2.2 / FR-G3）', () => {
  it('勾子集列时表头只含所选列', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows);

    fireEvent.change(screen.getByLabelText('导出格式'), { target: { value: 'csv' } });
    // 只留 word 与 meetCount
    for (const label of ['phonetic', 'definition', 'examples', 'example_translations', 'source', 'examTags', 'frequency', 'status', 'createdAt']) {
      fireEvent.click(screen.getByLabelText(`列 ${label}`));
    }
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await screen.findByText(/已导出/);

    const file = await lastFile();
    expect(file.filename).toMatch(/^leximate-csv-\d{8}-\d{4}\.csv$/);
    const records = parseDelimited(file.text, ',');
    expect(records[0]).toEqual(['word', 'meetCount']);
    expect(records).toHaveLength(rows.length + 1);
  });

  it('一列都不勾时拒绝导出并说明原因（不产出只有表头的空文件）', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows);

    fireEvent.change(screen.getByLabelText('导出格式'), { target: { value: 'csv' } });
    // 只点**已勾选**的：`unlisted` 初始就是不勾的（OQ13 默认不占列），
    // 无脑全点会把唯一剩下的那一列打开
    for (const column of screen.getAllByRole('checkbox')) {
      if ((column as HTMLInputElement).checked) fireEvent.click(column);
    }
    fireEvent.click(screen.getByRole('button', { name: '导出' }));

    expect(await screen.findByText(/至少要勾选一列/)).toBeDefined();
    expect(g.__leximateDownloads).toHaveLength(0);
  });
});

describe('纯单词表导出（§3.2.3 / §3.2.4）', () => {
  it('不背单词：文件里只有单词，并把后继操作写在面板上', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows);

    fireEvent.change(screen.getByLabelText('导出格式'), { target: { value: 'bbdc' } });
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await screen.findByText(/已导出/);

    const file = await lastFile();
    expect(file.filename).toMatch(/^leximate-bbdc-\d{8}-\d{4}\.txt$/);
    expect(file.text.split('\n').sort()).toEqual(['jump', 'run']);
    // 释义、音标、例句一个都不能进文件
    expect(file.text).not.toContain('跑');
    expect(file.text).not.toContain('rʌn');
    expect(file.text).not.toContain('He said');
    // 提示在"格式说明"与"导出结果"两处都会出现，因此按"至少一处"断言
    expect(screen.getAllByText(/点「识别」/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/由不背单词自己匹配/).length).toBeGreaterThan(0);
  });

  it('墨墨：填了章节名时首行是归一后的 `#章节名`', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows);

    fireEvent.change(screen.getByLabelText('导出格式'), { target: { value: 'maimemo' } });
    fireEvent.change(screen.getByLabelText('章节名'), { target: { value: '##考研核心' } });
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await screen.findByText(/已导出/);

    const file = await lastFile();
    expect(file.filename).toMatch(/^leximate-maimemo-\d{8}-\d{4}\.txt$/);
    expect(file.text.split('\n')[0]).toBe('#考研核心');
    expect(file.text).toContain('run');
  });
});

describe('JSON 备份导出（§3.2 / OQ8）', () => {
  it('载荷带计数与 schemaVersion，且不含任何凭据字段', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows);

    fireEvent.change(screen.getByLabelText('导出格式'), { target: { value: 'json' } });
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await screen.findByText(/已导出/);

    const file = await lastFile();
    expect(file.filename).toMatch(/^leximate-json-\d{8}-\d{4}\.json$/);

    const payload = JSON.parse(file.text) as {
      app: string;
      schemaVersion: number;
      counts: { words: number; scenes: number };
      words: unknown[];
      scenes: Array<{ translation: string | null }>;
    };
    expect(payload.app).toBe('leximate');
    expect(payload.schemaVersion).toBe(1);
    expect(payload.counts).toEqual({ words: 2, scenes: 3 });
    expect(payload.words).toHaveLength(2);
    expect(file.text).not.toContain('apiKey');
    expect(file.text).not.toContain('webdav');
  });

  it('OQ8：勾掉"包含例句翻译"后例句翻译为空', async () => {
    const rows = await seedAndLoad();
    renderPanel(rows);

    fireEvent.change(screen.getByLabelText('导出格式'), { target: { value: 'json' } });
    fireEvent.click(screen.getByLabelText('包含例句翻译（OQ8）'));
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await screen.findByText(/已导出/);

    const payload = JSON.parse((await lastFile()).text) as {
      scenes: Array<{ translation: string | null }>;
    };
    expect(payload.scenes.every((scene) => scene.translation === null)).toBe(true);
  });
});

describe('失败可见（FR-G7 的失败路径）', () => {
  it('浏览器拒绝下载时，面板上出现错误而不是静默什么也没发生', async () => {
    const rows = await seedAndLoad();
    const downloads = (globalThis as unknown as { browser: { downloads: { download: unknown } } })
      .browser.downloads;
    const original = downloads.download;
    downloads.download = async () => {
      throw new Error('用户取消了下载');
    };

    try {
      renderPanel(rows);
      fireEvent.click(screen.getByRole('button', { name: '导出' }));

      expect(await screen.findByRole('alert')).toBeDefined();
      expect(screen.getByText(/导出失败：用户取消了下载/)).toBeDefined();
    } finally {
      downloads.download = original;
    }
  });
});

describe('列表页的入口（FR-G1 / FR-F6）', () => {
  it('点工具栏的「导出…」能打开面板，默认导出全部', async () => {
    await seedAndLoad();
    render(<WordList />);
    await waitFor(() => expect(screen.getByText('running')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: '导出…' }));

    expect(screen.getByRole('dialog', { name: '导出' })).toBeDefined();
    expect((screen.getByRole('radio', { name: /全部生词/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('有筛选条件时默认范围是「当前筛选结果」（筛完再导出，想要的几乎总是筛出来的那批）', async () => {
    await seedAndLoad();
    render(<WordList />);
    await waitFor(() => expect(screen.getByText('running')).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText(/搜索词形/), { target: { value: 'run' } });
    // FR-F3：输入停顿 150ms 后才真正过滤
    await waitFor(() => expect(screen.getByText(/1 \/ 2/)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '导出…' }));

    expect((screen.getByRole('radio', { name: /当前筛选结果/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('勾选若干词后，批量区出现「导出选中」并以选中项为默认范围', async () => {
    await seedAndLoad();
    render(<WordList />);
    await waitFor(() => expect(screen.getByText('running')).toBeDefined());

    fireEvent.click(screen.getByLabelText('选择 run'));
    fireEvent.click(screen.getByRole('button', { name: '导出选中' }));

    expect((screen.getByRole('radio', { name: /选中项/ }) as HTMLInputElement).checked).toBe(true);
  });
});
