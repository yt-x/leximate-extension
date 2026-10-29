/**
 * 设置页的"清空所有数据"验收（PLAN.md FR-E7）。
 *
 * 验收原话：**「清空后所有 store 为空且设置保留；未确认时不执行」**。
 *
 * "未确认时不执行"这条**只能在这一层验**：数据层的 `clearAllData()`
 * 不做任何拦截（调用即清），拦截在界面上。
 *
 * 用真实 IndexedDB（jsdom + fake-indexeddb）走真实写入路径，
 * 因此"设置保留"这种跨 store 的判定不会被 mock 掩盖。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listWords, upsertWord } from '@/utils/db/words';
import { getSettings, setMeta, setSettings } from '@/utils/db/kv';
import { SettingsPage } from './SettingsPage';

async function seedWord(lemma: string) {
  await upsertWord({ lemma, surface: lemma });
}

/** 打开确认区（第一次点击只是"问一句"） */
async function openConfirm() {
  render(<SettingsPage />);
  // 按 role 找：文案里"清空"出现多次（按钮、对话框标题、说明），按文本找会歧义
  await waitFor(() => expect(screen.getByRole('button', { name: '清空所有数据' })).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: '清空所有数据' }));
  await waitFor(() => expect(screen.getByRole('alertdialog')).toBeDefined());
}

/**
 * 设置页**不放不可用的假开关**（本页自己写的原则）。
 *
 * 复核时发现三个开关**没有任何消费者**：`ui.language`（FR-L1 的多语言没实现，
 * `_locales` 只覆盖 manifest 三个字符串）、`ui.theme`、`ui.pageSize`
 * （后两个不在任何 FR 里）。字段留在数据模型里（已保存的值不丢），
 * 但界面不再提供入口——`utils/settings-wiring.test.ts` 里登记了它们的去向。
 *
 * 这条用例是防止"顺手再放回来"的守卫：要放回来，先让它们真的被读。
 */
describe('设置页不放没有消费者的开关', () => {
  it('不渲染「主题 / 每页条数」两个仍未接线的开关', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '清空所有数据' })).toBeDefined());

    for (const label of ['主题', '每页条数']) {
      expect(screen.queryByLabelText(label), label).toBeNull();
    }
  });

  it('已接线的设置项仍在（下划线样式 / 颜色 / 线宽 / 最短词长 / 语速 / 选中即入库 / 黑名单）', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '清空所有数据' })).toBeDefined());

    for (const label of ['全局开关', '下划线样式', '下划线颜色', '线宽（px）', '最短词长', '发音语速', '选中即入库', '站点黑名单']) {
      expect(screen.queryByLabelText(label), label).not.toBeNull();
    }
  });
});

/**
 * FR-L5：体积自检。
 *
 * 验收原话是"占用数值来自**真实配额查询**；超阈值时确实出现备份提示"。
 * 因此这里两条都验：读的是 `navigator.storage.estimate()` 给的值；
 * 拿不到配额时显示"未知"而**不是**"正常"（不知道 ≠ 健康）。
 */
describe('FR-L5：体积自检', () => {
  async function withStorage(estimate: (() => Promise<{ usage: number; quota: number }>) | null, fn: () => Promise<void>) {
    const nav = navigator as unknown as { storage?: unknown };
    const original = nav.storage;
    nav.storage = estimate ? { estimate } : undefined;
    try {
      await fn();
    } finally {
      nav.storage = original;
    }
  }

  it('显示真实占用与配额、词数句数、上次导出时间', async () => {
    await upsertWord({ lemma: 'run', surface: 'run' });
    await setMeta({ lastExportAt: Date.UTC(2026, 9, 1) });

    await withStorage(async () => ({ usage: 2 * 1024 * 1024, quota: 1024 * 1024 * 1024 }), async () => {
      render(<SettingsPage />);

      const block = await screen.findByLabelText('体积自检');
      await waitFor(() => expect(block.textContent).toContain('2.0 MB'));
      expect(block.textContent).toContain('配额 1.0 GB');
      expect(block.textContent).toContain('词 1 条 / 例句 0 条');
      // 上次导出时间用本地时间显示，"有没有显示"这件事比格式更重要
      expect(block.textContent).toContain('上次导出：');
    });
  });

  it('超过阈值时出现备份提示（原因：接近配额）', async () => {
    const quota = 100 * 1024 * 1024;
    await withStorage(async () => ({ usage: quota * 0.4, quota }), async () => {
      render(<SettingsPage />);

      const block = await screen.findByLabelText('体积自检');
      await waitFor(() => expect(block.textContent).toContain('占用已超过阈值'));
      expect(block.textContent).toContain('接近浏览器给的配额');
      expect(block.textContent).toContain('建议先导出一次备份');
    });
  });

  it('拿不到配额信息时说"未知"，不说"正常"', async () => {
    await withStorage(null, async () => {
      render(<SettingsPage />);

      const block = await screen.findByLabelText('体积自检');
      await waitFor(() => expect(block.textContent).toContain('占用 未知'));
      expect(block.textContent).toContain('浏览器没有提供配额信息');
      expect(block.textContent).not.toContain('占用已超过阈值');
    });
  });

  it('清空数据后占用与条数跟着刷新（同一上下文的总线）', async () => {
    await upsertWord({ lemma: 'run', surface: 'run' });
    render(<SettingsPage />);

    const block = await screen.findByLabelText('体积自检');
    await waitFor(() => expect(block.textContent).toContain('词 1 条'));

    fireEvent.click(screen.getByRole('button', { name: '清空所有数据' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认清空' }));

    await waitFor(() => expect(block.textContent).toContain('词 0 条'));
  });
});

describe('FR-F9：WebDAV 与翻译上限可改可存', () => {
  it('保存后完整写入 WebDAV 五字段与 translation.limits', async () => {
    render(<SettingsPage />);
    const url = await screen.findByLabelText('WebDAV 服务器');

    fireEvent.change(url, { target: { value: 'http://localhost:8080/dav/' } });
    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('应用密码（不是登录密码）'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByPlaceholderText('远端路径，如 /leximate/sync.json'), { target: { value: '/leximate/custom.json' } });
    fireEvent.change(screen.getByPlaceholderText('同步口令（可选，填了就加密远端）'), { target: { value: 'phrase' } });
    fireEvent.change(screen.getByLabelText('翻译批量与上限'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('并发数'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('每日上限'), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(screen.getByText('已保存')).toBeDefined());
    const saved = await getSettings();
    expect(saved.webdav).toEqual({
      url: 'http://localhost:8080/dav/',
      username: 'alice',
      password: 'secret',
      path: '/leximate/custom.json',
      passphrase: 'phrase',
    });
    expect(saved.translation.limits).toEqual({ dailyLimit: 17, batchSize: 4, concurrency: 3 });
  });
});

/**
 * FR-I2：语速可配。
 *
 * 验收原话是"设置项改动后**下一次发音即生效**，无需重载页面"。
 * "即生效"那一半在内容脚本侧（`speech.test.ts` 的 `setRate` 用例与
 * `controller.test.ts` 的转交用例），这里验的是另一半：**界面能改、能存、重载后还在**。
 */
describe('FR-I2：发音语速可改可存', () => {
  it('默认是 1，改完保存后写进库', async () => {
    render(<SettingsPage />);
    const input = (await screen.findByLabelText('发音语速')) as HTMLInputElement;
    expect(input.value).toBe('1');

    fireEvent.change(input, { target: { value: '0.8' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(screen.getByText('已保存')).toBeDefined());
    expect((await getSettings()).speechRate).toBe(0.8);
  });

  /**
   * 用户实测（2026-10-23）：设置页关掉全局开关后，角标仍显示生词数，
   * "很久之后"才变成 OFF。
   *
   * 根因：`setSettings` 里的 `notifySettingsWritten` 只通知**同一上下文**，
   * 管理台与后台是两个上下文，后台收不到 → 不会重算角标。
   * 管理台保存设置后必须发 `data-changed` 让后台重算。
   */
  it('保存设置后通知后台重算角标（关开关后角标要立刻变 OFF）', async () => {
    const sendMessage = vi.fn(async (_message?: unknown) => undefined);
    const browserStub = (globalThis as unknown as { browser: { runtime: { sendMessage: unknown } } })
      .browser;
    const original = browserStub.runtime.sendMessage;
    browserStub.runtime.sendMessage = sendMessage;

    try {
      render(<SettingsPage />);
      await screen.findByLabelText('发音语速');
      fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
      await waitFor(() => expect(screen.getByText('已保存')).toBeDefined());

      await waitFor(() => expect(sendMessage).toHaveBeenCalled());
      const sent = sendMessage.mock.calls.map((c) => c[0] as { type?: string });
      expect(sent.some((m) => m && m.type === 'leximate:data-changed')).toBe(true);
    } finally {
      browserStub.runtime.sendMessage = original;
    }
  });

  it('越界的语速不让保存，并说明范围', async () => {
    render(<SettingsPage />);
    const input = (await screen.findByLabelText('发音语速')) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(screen.getByText(/发音语速需在/)).toBeDefined());
    // 库里仍是默认值：非法输入不该落库
    expect((await getSettings()).speechRate).toBe(1);
  });
});

describe('FR-E7：清空所有数据是两步的', () => {
  it('第一次点击**不执行**，只显示确认区与将要删除的条数', async () => {
    await seedWord('run');
    await seedWord('go');

    await openConfirm();

    // 提示里带上条数（与 FR-F6 的批量删除同一口径：界面内展示条数，不用 window.confirm）
    // ⚠️ 条数是**异步**统计出来的（先显示"正在统计…"），所以必须用 waitFor；
    // 直接断言会在并发跑测试时偶发失败。
    await waitFor(() => expect(screen.getByText(/2 个词/)).toBeDefined());
    // 数据还在——这是"未确认时不执行"的直接断言
    expect(await listWords()).toHaveLength(2);
  });

  it('点"取消"后什么也没发生，确认区收起', async () => {
    await seedWord('run');
    await openConfirm();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await listWords()).toHaveLength(1);
  });

  it('点"确认清空"之后词库为空、设置保留', async () => {
    await seedWord('run');
    await setSettings({ enabled: false, underlineColor: '#123456' });
    await openConfirm();

    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));

    await waitFor(async () => expect(await listWords()).toHaveLength(0));
    const settings = await getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.underlineColor).toBe('#123456');
  });

  it('清空完成后给出反馈，且确认区收起', async () => {
    await seedWord('run');
    await openConfirm();

    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));

    await waitFor(() => expect(screen.getByText(/已清空/)).toBeDefined());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('空库时也允许清空（不报错、条数为 0）', async () => {
    await openConfirm();

    // 同样要等异步统计（它先渲染"正在统计…"）
    await waitFor(() => expect(screen.getByText(/0 个词/)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));

    await waitFor(() => expect(screen.getByText(/已清空/)).toBeDefined());
  });
});

/**
 * FR-E6：卸载风险可知。
 *
 * 验收原文：「设置页与 README 明确说明"卸载扩展会连同本地数据一起清除"；
 * **首次安装引导中必须出现该提示**」。
 *
 * 这条说明以前只在"存储占用告警"分支里出现过一句，正常用户看不到它——
 * 所以这里锁的是"设置页上**常驻**有这段话"，与占用是否告警无关。
 */
describe('FR-E6：设置页常驻卸载风险说明', () => {
  it('无论占用是否告警，设置页都写明"卸载…会连同本地数据一起清除"', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: '清空所有数据' })).toBeDefined());

    const text = document.body.textContent ?? '';
    expect(text).toContain('卸载本扩展');
    expect(text).toContain('一起清除');
    expect(text).toContain('无法恢复');
  });
});

/**
 * FR-L1：界面语言（口径见 `decisions/0026`：只管管理台，弹窗不参与）。
 *
 * 这条守卫在上一条用例里被"扶正"：`ui.language` 此前没有消费者、所以界面不提供入口；
 * 现在 `utils/i18n` 真的读它，入口就该在。
 */
describe('FR-L1：界面语言可改可存', () => {
  it('设置页提供三种取值，保存后回调通知外壳切换', async () => {
    const onLocaleChange = vi.fn();
    render(<SettingsPage onLocaleChange={onLocaleChange} />);

    const select = (await screen.findByLabelText('界面语言')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['auto', 'zh-CN', 'en']);

    fireEvent.change(select, { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(onLocaleChange).toHaveBeenCalledWith('en'));
    // 存进去了，重开页面仍是 en
    expect((await getSettings()).ui.language).toBe('en');
  });
});
