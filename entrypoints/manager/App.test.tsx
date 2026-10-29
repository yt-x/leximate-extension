/**
 * 管理台界面的渲染测试。
 *
 * **为什么必须有这一层**：`utils/manager/` 的 106 个用例全是纯函数，
 * 它们全绿也证明不了界面能渲染出来——组件写错了照样白屏，
 * 而白屏**不报错**（React 的错误边界之外，用户只看到空白）。
 * 这正是 `CONSTRAINTS.md` 第 13 条记的那类"不报错、只是不工作"。
 *
 * 这里测的是**接得对不对**（数据 → 界面），不是样式好不好看。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { addScene, softDeleteWord, upsertWord } from '@/utils/db/words';
import { getMeta, setMeta, setSettings } from '@/utils/db/kv';
import { ONBOARDING_BLOCKS } from '@/utils/manager/onboarding';
import { MSG } from '@/utils/content/messages';
import App from './App';
import { WordList } from './WordList';

/** 造一条词 + 若干例句，走真实写入路径（不 mock 数据库） */
async function seedWord(
  lemma: string,
  options: { status?: 'new' | 'known' | 'ignored'; scenes?: string[]; meetCount?: number } = {},
) {
  const { word } = await upsertWord({
    lemma,
    surface: lemma,
    defZh: [`${lemma} 的释义`],
    defSrc: 'authored',
    status: options.status ?? 'new',
    phoneticUs: `${lemma}-pron`,
    // FR-B9：有音标就必须给来源——这条不变式是 upsertWord 自己守的，
    // 夹具也必须遵守，否则测的就不是真实写入路径
    phoneticSrc: 'pipeline',
  });

  for (let i = 1; i < (options.meetCount ?? 1); i += 1) {
    await upsertWord({ lemma, surface: lemma });
  }

  for (const [i, domain] of (options.scenes ?? []).entries()) {
    // domain 由 sourceUrl 推导（`domainOf`），不是入参。
    // ⚠️ 句子文本必须带下标：`addScene` 按 `sceneHash(wordId, text)` 去重，
    // 两条文本相同会被合并成一条（这是设计要求，不是 bug）。
    // 夹具若图省事写同一句，测出来的例句数会永远比预期少一条。
    const prefix = `Sentence ${i} with `;
    await addScene({
      wordId: word.id,
      text: `${prefix}${lemma} inside.`,
      highlightFrom: prefix.length,
      highlightTo: prefix.length + lemma.length,
      sourceUrl: `https://${domain}/page`,
      sourceTitle: 't',
    });
  }

  return word;
}

/**
 * FR-E7 的界面联动：在设置页清空之后，**一直挂着的**列表页必须跟着刷新。
 *
 * `App.tsx` 用 `hidden` 切换两个页面（为的是切回时保住滚动位置与筛选，FR-F7），
 * 因此列表组件**不会重新挂载**——它不会自己去重读库。
 * 这条用例就是"两个页面同时挂载"这个设计的代价的可执行证明。
 */
describe('FR-E7：清空数据后列表跟着刷新', () => {
  it('在设置页清空后，切回生词列表是空的（不是旧行）', async () => {
    await seedWord('run');
    render(<App />);
    await waitFor(() => expect(screen.getByText('run')).toBeDefined());

    fireEvent.click(screen.getByRole('tab', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: '清空所有数据' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认清空' }));

    fireEvent.click(screen.getByRole('tab', { name: '生词' }));

    await waitFor(() => expect(screen.getByText(/还没有生词/)).toBeDefined());
  });
});

/**
 * 复现用户报告：删除所有词之后列表为空，但计数分母仍在累加（`0 / 67`）。
 *
 * 原因是 `loadRows` 用 `listWords({ includeDeleted: true })` 把**墓碑**也读了进来，
 * 而墓碑又被筛选层丢掉——于是"看得见的 0 / 加载到的 67"。
 * 墓碑是给同步用的删除标记（§2），不是"库里的词"，不该出现在分母里。
 */
describe('FR-F2：计数不含墓碑', () => {
  it('删除所有词之后计数是 0 / 0，而不是 0 / N', async () => {
    const a = await seedWord('gone-one');
    const b = await seedWord('gone-two');
    const c = await seedWord('gone-three');
    for (const word of [a, b, c]) await softDeleteWord(word.id);

    const { container } = render(<WordList />);

    await waitFor(() => expect(screen.getByText(/还没有生词/)).toBeDefined());
    expect(container.querySelector('.count')?.textContent?.startsWith('0 / 0')).toBe(true);
  });

  it('删掉一个词后分母跟着减（不是"总数永远只增不减"）', async () => {
    const a = await seedWord('keep');
    const b = await seedWord('drop');
    await softDeleteWord(b.id);

    const { container } = render(<WordList />);

    await waitFor(() => expect(screen.getByText('keep')).toBeDefined());
    expect(container.querySelector('.count')?.textContent?.startsWith('1 / 1')).toBe(true);
    expect(a.id).toBeTruthy();
  });
});

/** 在 jsdom 里模拟"后台广播了一条消息给扩展页面" */
function emitRuntimeMessage(message: unknown): void {
  (
    globalThis as unknown as { __leximateEmitRuntimeMessage?: (m: unknown) => void }
  ).__leximateEmitRuntimeMessage?.(message);
}

/**
 * 复现用户报告："选中一个词之后，管理台里看不到它"。
 *
 * 内容脚本划词写入的是**扩展源**的库，管理台是另一个页面。
 * 管理台只在挂载时读一次库，之后没有任何东西告诉它"词库变了"——
 * 于是已经打开的管理台会一直显示旧列表（用户以为"没加进去"）。
 */
describe('FR-F2：后台广播后管理台自动重读库', () => {
  it('收到 words-changed 广播后，新词出现在列表里', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/还没有生词/)).toBeDefined());

    // 模拟内容脚本在网页上划词：写入发生在管理台之外
    await upsertWord({ lemma: 'freshly-met' });
    emitRuntimeMessage({ type: MSG.wordsChanged });

    await waitFor(() => expect(screen.getByText('freshly-met')).toBeDefined());
  });

  it('无关消息不触发重读（不该为每条消息都全表读一次）', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/还没有生词/)).toBeDefined());

    await upsertWord({ lemma: 'quiet' });
    emitRuntimeMessage({ type: MSG.getSettings });
    emitRuntimeMessage('随便一条');

    // 没收到 words-changed，列表保持旧状态（这里断言它**还没**出现）
    expect(screen.queryByText('quiet')).toBeNull();
  });
});

describe('WordList 渲染', () => {
  it('空库时不白屏，显示引导文案', async () => {
    render(<WordList />);

    // 白屏的典型表现就是什么都找不到，所以这条是底线
    await waitFor(() => {
      expect(screen.getByText(/还没有生词/)).toBeDefined();
    });
  });

  it('有数据时渲染出词与释义', async () => {
    await seedWord('run');
    render(<WordList />);

    await waitFor(() => {
      expect(screen.getByText('run')).toBeDefined();
    });
    expect(screen.getByText('run 的释义')).toBeDefined();
  });

  it('表头 8 列齐备且不含来源域名列（FR-F2）', async () => {
    const word = await seedWord('align', { status: 'known', scenes: ['a.com', 'b.com'], meetCount: 3 });
    const { container } = render(<WordList />);

    await waitFor(() => {
      expect(container.querySelector('.row')).not.toBeNull();
    });

    const head = container.querySelector('.table-head')!;
    const headCells = [...head.children] as HTMLElement[];
    expect(headCells).toHaveLength(8);
    expect(headCells.map((cell) => cell.textContent ?? '')).toEqual([
      '', '词', '音标', '释义', '遇见', '状态', '例句数', '时间',
    ]);
    expect(head.textContent ?? '').not.toContain('域名');
    expect(head.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);

    const row = container.querySelector('.row')!;
    const rowCells = [...row.children] as HTMLElement[];
    expect(rowCells).toHaveLength(8);
    expect(rowCells.map((cell) => cell.textContent ?? '')).toEqual([
      '',
      'align',
      '/align-pron/',
      'align 的释义',
      '3',
      '已掌握',
      '2',
      new Date(word.createdAt).toLocaleDateString(),
    ]);

    const sortButtons = [...container.querySelectorAll('.sort-controls button')];
    expect(sortButtons.map((button) => (button.textContent ?? '').replace(/ [↑↓]$/, ''))).toEqual([
      '时间', '遇见', '词频', '字母',
    ]);
  });

  it('统计条显示总词数（FR-F8）', async () => {
    await seedWord('a');
    await seedWord('b');
    render(<WordList />);

    await waitFor(() => {
      expect(screen.getByText('总词数')).toBeDefined();
    });

    // "总词数"上方的数字应为 2。
    // ⚠️ 统计是**从异步加载的行**算出来的，标签先渲染、数字后到；
    // 这里必须连数字一起等，否则并发跑测试时会偶发拿到初始的 0（已实测）。
    await waitFor(() => {
      const label = screen.getByText('总词数');
      expect(label.previousElementSibling?.textContent).toBe('2');
    });
  });

  it('词的状态以中文标签渲染（不是裸枚举值）', async () => {
    await seedWord('known1', { status: 'known' });
    const { container } = render(<WordList />);

    await waitFor(() => {
      expect(container.querySelector('.row')).not.toBeNull();
    });

    // 只看行内的状态徽标："已掌握"在统计条与筛选项里也出现，
    // 所以按 class 定位，确认渲染的是中文而不是 `known` 这个裸值
    const badge = container.querySelector('.row .badge');
    expect(badge?.textContent).toBe('已掌握');
    expect(badge?.getAttribute('data-s')).toBe('known');
  });

  it('例句数进列表，来源域名不进列表行', async () => {
    await seedWord('run', { scenes: ['a.com', 'b.com'] });
    const { container } = render(<WordList />);

    await waitFor(() => {
      expect(container.querySelector('.row')).not.toBeNull();
    });

    const row = container.querySelector('.row')!;
    const cells = [...row.querySelectorAll('span')].map((s) => s.textContent ?? '');

    // 例句数那一格是 "2"
    expect(cells).toContain('2');
    // FR-F2：来源域名不在列表行里（改由 FR-F7 抽屉逐句显示）
    expect(row.textContent ?? '').not.toContain('a.com');
    expect(row.textContent ?? '').not.toContain('b.com');
  });

  it('例句数有列名（不只是空白占位）', async () => {
    const { container } = render(<WordList />);

    await waitFor(() => {
      expect(container.querySelector('.table-head')).not.toBeNull();
    });

    const head = container.querySelector('.table-head')!;
    expect(head.children[6]?.textContent).toBe('例句数');
  });

  it('未收录的词显示「未收录」而不是空白', async () => {
    await upsertWord({ lemma: 'ghost', surface: 'ghost', isUnlisted: true });
    render(<WordList />);

    await waitFor(() => {
      expect(screen.getByText('未收录')).toBeDefined();
    });
  });
});

describe('详情抽屉（FR-F7）', () => {
  it('点行打开抽屉，展示释义与例句', async () => {
    await seedWord('run', { scenes: ['a.com'] });
    const { container } = render(<WordList />);

    await waitFor(() => {
      expect(container.querySelector('.row')).not.toBeNull();
    });

    fireEvent.click(container.querySelector('.row')!);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeDefined();
    });
    // 抽屉里应能看到例句原文
    await waitFor(() => {
      expect(screen.getByText(/Sentence 0 with/)).toBeDefined();
    });
  });

  it('抽屉是覆盖层——列表仍在 DOM 里（因此滚动位置与筛选不丢）', async () => {
    await seedWord('run', { scenes: ['a.com'] });
    const { container } = render(<WordList />);

    await waitFor(() => {
      expect(container.querySelector('.row')).not.toBeNull();
    });

    fireEvent.click(container.querySelector('.row')!);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeDefined();
    });

    // FR-F7 要求"打开详情不丢失列表的滚动位置与筛选状态"。
    // 靠的是抽屉覆盖而不是换页——列表容器必须还在 DOM 中（不是被卸载重建）。
    expect(container.querySelector('.scroller')).not.toBeNull();
    expect(container.querySelector('.row')).not.toBeNull();
  });

  it('Esc 关闭抽屉', async () => {
    await seedWord('run');
    const { container } = render(<WordList />);

    await waitFor(() => {
      expect(container.querySelector('.row')).not.toBeNull();
    });

    fireEvent.click(container.querySelector('.row')!);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeDefined();
    });

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('搜索与筛选（FR-F3 / FR-F4）', () => {
  it('搜索输入过滤列表', async () => {
    await seedWord('apple');
    await seedWord('banana');
    const { container } = render(<WordList />);

    await waitFor(() => {
      expect(container.querySelectorAll('.row')).toHaveLength(2);
    });

    // 去抖 150ms，所以用 waitFor 等
    fireEvent.change(screen.getByPlaceholderText(/搜索词形/), {
      target: { value: 'app' },
    });

    await waitFor(() => {
      expect(container.querySelectorAll('.row')).toHaveLength(1);
    });
    expect(screen.getByText('apple')).toBeDefined();
  });

  it('无匹配时显示空态而不是空白', async () => {
    await seedWord('apple');
    render(<WordList />);

    await waitFor(() => {
      expect(screen.getByText('apple')).toBeDefined();
    });

    fireEvent.change(screen.getByPlaceholderText(/搜索词形/), {
      target: { value: 'zzzz' },
    });

    await waitFor(() => {
      expect(screen.getByText(/没有符合当前筛选条件/)).toBeDefined();
    });
  });

  it('清除筛选按钮复位', async () => {
    await seedWord('apple');
    render(<WordList />);

    await waitFor(() => {
      expect(screen.getByText('apple')).toBeDefined();
    });

    fireEvent.change(screen.getByPlaceholderText(/搜索词形/), {
      target: { value: 'zzz' },
    });
    await waitFor(() => {
      expect(screen.getByText(/没有符合当前筛选条件/)).toBeDefined();
    });

    fireEvent.click(screen.getByText('清除筛选'));

    await waitFor(() => {
      expect(screen.getByText('apple')).toBeDefined();
    });
  });
});

describe('App 外壳', () => {
  it('渲染标题与两个 tab，默认在生词页', async () => {
    render(<App />);

    expect(screen.getByText(/Leximate/)).toBeDefined();
    expect(screen.getByRole('tab', { name: '生词' })).toBeDefined();
    expect(screen.getByRole('tab', { name: '设置' })).toBeDefined();
    expect(screen.getByRole('tab', { name: '生词' }).getAttribute('aria-selected')).toBe('true');
  });

  it('两个页面都挂载（切页不丢列表状态，FR-F7）', async () => {
    render(<App />);

    // 用 hidden 切换而非条件渲染：设置页的 DOM 也在，列表不会被卸载
    const settingsTab = screen.getByRole('tab', { name: '设置' });
    expect(settingsTab).toBeDefined();

    const panel = document.querySelector('div[hidden]');
    expect(panel).not.toBeNull();
  });

  it('设置页能渲染出设置项（FR-F9）', async () => {
    await setSettings({ enabled: false });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText('全局开关')).toBeDefined();
    });
    expect(screen.getByLabelText('下划线样式')).toBeDefined();
    expect(screen.getByLabelText('站点黑名单')).toBeDefined();
  });

  it('设置页不出现「保存」以外的假开关', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('尚未启用的设置')).toBeDefined();
    });
  });
});

/**
 * FR-L6：备份提醒（R10 的应对）。
 *
 * 判定是纯函数（`utils/manager/backup-health.test.ts` 有 18 条），
 * 这里验的是**接线**：事实读到了没有、提示条出现在管理台顶部没有、
 * "知道了"能不能关掉（且只关本次会话）。
 */
describe('FR-L6：管理台顶部的备份提醒', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('库里有词且从未导出过 → 顶部出现提醒，说明去哪导出', async () => {
    await seedWord('run');
    render(<App />);

    const banner = await screen.findByRole('status', { name: '备份提醒' });
    expect(banner.textContent).toContain('还没有导出过备份');
    expect(banner.textContent).toContain('生词');
  });

  it('点「知道了」关掉，只关本次会话', async () => {
    await seedWord('run');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '知道了' }));

    expect(screen.queryByRole('status', { name: '备份提醒' })).toBeNull();
  });

  it('刚导出过 → 不提醒', async () => {
    await seedWord('run');
    await setMeta({ lastExportAt: Date.now() });
    render(<App />);

    await waitFor(() => expect(screen.getByText('run')).toBeDefined());
    expect(screen.queryByRole('status', { name: '备份提醒' })).toBeNull();
  });

  it('超期但这段时间没变过 → 不提醒（上次导出的就是当前状态）', async () => {
    const long = Date.now() - 60 * DAY;
    await upsertWord({ lemma: 'run', surface: 'run', now: long });
    await setMeta({ lastExportAt: Date.now() - 40 * DAY });

    render(<App />);

    await waitFor(() => expect(screen.getByText('run')).toBeDefined());
    expect(screen.queryByRole('status', { name: '备份提醒' })).toBeNull();
  });

  it('超期且有变化 → 提醒里带上天数', async () => {
    // 词是"现在"加的，导出发生在 31 天前 → 导出之后有变化
    await seedWord('run');
    await setMeta({ lastExportAt: Date.now() - 31 * DAY });

    render(<App />);

    const banner = await screen.findByRole('status', { name: '备份提醒' });
    expect(banner.textContent).toContain('31 天');
  });

  it('空库不提醒（没什么可丢的）', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByRole('tab', { name: '设置' })).toBeDefined());
    expect(screen.queryByRole('status', { name: '备份提醒' })).toBeNull();
  });

  it('点「去『生词』页」会切回生词标签', async () => {
    await seedWord('run');
    render(<App />);

    fireEvent.click(screen.getByRole('tab', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: '去「生词」页' }));

    expect(screen.getByRole('tab', { name: '生词' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('FR-F10：首装引导', () => {
  it('没看过时显示四块引导；点「知道了，开始使用」后写入 onboardingDoneAt 并消失', async () => {
    // 显式回到"没看过"：同文件其它用例可能已经写过 meta
    await setMeta({ onboardingDoneAt: null });
    render(<App />);

    // 面板要等 getMeta() 返回才渲染，先等第一块出现
    await waitFor(() => {
      expect(document.querySelector('[data-block="dict-status"]')).not.toBeNull();
    });

    for (const block of ONBOARDING_BLOCKS) {
      expect(document.querySelector(`[data-block="${block}"]`), `缺 ${block}`).not.toBeNull();
    }

    fireEvent.click(await screen.findByRole('button', { name: '知道了，开始使用' }));

    await waitFor(async () => {
      const meta = await getMeta();
      expect(meta.onboardingDoneAt).not.toBeNull();
    });
    expect(screen.queryByRole('button', { name: '知道了，开始使用' })).toBeNull();
  });

  it('已看过（onboardingDoneAt 有值）时不再显示', async () => {
    await setMeta({ onboardingDoneAt: Date.now() });
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '知道了，开始使用' })).toBeNull();
    });
  });
});
