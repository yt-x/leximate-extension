/**
 * 诊断页的界面测试（PLAN.md FR-L4）。
 *
 * 验收原话："记录运行日志……**可查看、可导出、不上报任何数据**"。
 * - 可查看：筛选与列表（本文件）
 * - 可导出：导出当前筛选后的内容（本文件，读回下载到的 Blob）
 * - 不上报：`utils/diag/no-network.test.ts` 扫源码守住
 *
 * 日志走真实写入路径（`writeLog`），因此"页面读到的是库里那条"这件事
 * 不是靠 mock 说出来的。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listLogs, writeLog } from '@/utils/diag';
import { DiagnosticsPage } from './DiagnosticsPage';

interface TestGlobals {
  __leximateDownloads?: Array<{ url: string; filename: string }>;
  __leximateObjectUrls?: Map<string, Blob>;
}

const g = globalThis as unknown as TestGlobals;

async function lastFile(): Promise<{ filename: string; text: string }> {
  const calls = g.__leximateDownloads ?? [];
  const call = calls[calls.length - 1];
  if (!call) throw new Error('没有任何下载发生');
  const blob = g.__leximateObjectUrls?.get(call.url);
  if (!blob) throw new Error(`下载的 URL 没有对应内容：${call.url}`);
  return { filename: call.filename, text: await blob.text() };
}

async function seedLogs() {
  await writeLog({ level: 'info', scope: 'install', message: '扩展已安装', at: 1_000, detail: { reason: 'install' } });
  await writeLog({ level: 'warn', scope: 'badge', message: '角标刷新失败', at: 2_000, detail: { error: 'boom' } });
  await writeLog({ level: 'debug', scope: 'content', message: 'popup-shown', at: 3_000, detail: { surface: 'Running' } });
}

describe('FR-L4：可查看', () => {
  it('列出日志，最新在前，并显示来源与消息', async () => {
    await seedLogs();
    render(<DiagnosticsPage />);

    await waitFor(() => expect(screen.getByText('角标刷新失败')).toBeDefined());
    expect(screen.getByText('扩展已安装')).toBeDefined();
    expect(screen.getByText('popup-shown')).toBeDefined();

    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('popup-shown');
  });

  it('按级别筛（只留警告）', async () => {
    await seedLogs();
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText('角标刷新失败')).toBeDefined());

    fireEvent.change(screen.getByLabelText('日志级别'), { target: { value: 'warn' } });

    expect(screen.getByText('角标刷新失败')).toBeDefined();
    expect(screen.queryByText('扩展已安装')).toBeNull();
    expect(screen.queryByText('popup-shown')).toBeNull();
  });

  it('按来源筛', async () => {
    await seedLogs();
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText('扩展已安装')).toBeDefined());

    fireEvent.change(screen.getByLabelText('日志来源'), { target: { value: 'content' } });

    expect(screen.getByText('popup-shown')).toBeDefined();
    expect(screen.queryByText('扩展已安装')).toBeNull();
  });

  it('文本搜索同时看消息与 detail', async () => {
    await seedLogs();
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText('扩展已安装')).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText('搜索日志内容'), { target: { value: 'boom' } });

    expect(screen.getByText('角标刷新失败')).toBeDefined();
    expect(screen.queryByText('扩展已安装')).toBeNull();
  });

  it('空库显示空态；筛不出结果时说的是另一句', async () => {
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText('还没有日志。')).toBeDefined());

    await seedLogs();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByText('角标刷新失败')).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText('搜索日志内容'), { target: { value: '不存在' } });
    expect(screen.getByText('没有符合筛选条件的日志。')).toBeDefined();
  });
});

describe('FR-L4：可导出', () => {
  it('导出的是当前筛选后的内容（不是全部）', async () => {
    await seedLogs();
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText('角标刷新失败')).toBeDefined());

    fireEvent.change(screen.getByLabelText('日志级别'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: '导出日志' }));

    await waitFor(() => expect(screen.getByText(/已导出/)).toBeDefined());
    const file = await lastFile();

    expect(file.filename).toMatch(/^leximate-diag-\d{8}-\d{4}\.json$/);
    const payload = JSON.parse(file.text) as {
      kind: string;
      counts: { entries: number };
      entries: Array<{ message: string; detail: unknown }>;
    };
    expect(payload.kind).toBe('diagnostics');
    expect(payload.counts.entries).toBe(1);
    expect(payload.entries[0]!.message).toBe('角标刷新失败');
    expect(payload.entries[0]!.detail).toEqual({ error: 'boom' });
    // 导出文件里不该出现凭据字段（与 FR-H7 同一条底线）
    expect(file.text).not.toContain('apiKey');
  });

  it('没有可导出的内容时按钮不可点', async () => {
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText('还没有日志。')).toBeDefined());

    expect((screen.getByRole('button', { name: '导出日志' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('FR-L4：清空日志是两步的', () => {
  it('第一次点击只问一句，确认后才真的清', async () => {
    await seedLogs();
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText('角标刷新失败')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: '清空日志' }));
    expect(screen.getByRole('alertdialog', { name: '确认清空日志' })).toBeDefined();
    expect(await listLogs()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));

    await waitFor(() => expect(screen.getByText('还没有日志。')).toBeDefined());
    expect(await listLogs()).toHaveLength(0);
  });

  it('取消什么也不做', async () => {
    await seedLogs();
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText('角标刷新失败')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: '清空日志' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await listLogs()).toHaveLength(3);
  });
});

describe('FR-L4：页面上说明日志不上报', () => {
  it('明确写出"只保存在本机、不会上传"', async () => {
    render(<DiagnosticsPage />);
    await waitFor(() => expect(screen.getByText(/不会上传到任何服务器/)).toBeDefined());
  });
});
