/**
 * 首装引导的渲染验收（PLAN.md FR-E6 / FR-F10 / FR-F11）。
 *
 * @vitest-environment jsdom
 *
 * 纯判定在 `utils/manager/onboarding.test.ts` 里测；这里验"四块真的渲染出来"
 * 与"关闭时把决定交给调用方"。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LogEntry } from '@/utils/db/types';
import { ONBOARDING_BLOCKS } from '@/utils/manager/onboarding';
import { Onboarding } from './Onboarding';

const dictLogs: LogEntry[] = [
  {
    level: 'info',
    scope: 'dict',
    message: '词库就绪',
    detail: { version: '0.1.0', entries: 3004, shards: ['core'], elapsedMs: 412 },
    at: 1,
  },
];

function renderOnboarding(logs: () => Promise<LogEntry[]> = async () => []) {
  const onDismiss = vi.fn();
  render(<Onboarding onDismiss={onDismiss} loadLogs={logs} />);
  return { onDismiss };
}

describe('FR-F10：四块内容齐备', () => {
  it('四块都渲染出来（按 data-block 逐块断言）', () => {
    renderOnboarding();
    for (const block of ONBOARDING_BLOCKS) {
      expect(document.querySelector(`[data-block="${block}"]`), `缺 ${block}`).not.toBeNull();
    }
  });

  it('卸载风险那块点名"卸载"与"一起清除"（FR-E6 的硬性要求）', () => {
    renderOnboarding();
    const block = document.querySelector('[data-block="uninstall-risk"]');
    expect(block?.textContent ?? '').toContain('卸载');
    expect(block?.textContent ?? '').toContain('一起清除');
  });

  it('核心开关那块写清了"选中即入库默认关"', () => {
    renderOnboarding();
    const block = document.querySelector('[data-block="core-switches"]');
    expect(block?.textContent ?? '').toContain('加入生词本');
  });

  it('隐私那块写清了"默认不联网"', () => {
    renderOnboarding();
    const block = document.querySelector('[data-block="privacy"]');
    expect(block?.textContent ?? '').toContain('默认不发出任何网络请求');
  });
});

describe('FR-F11：词库状态可见', () => {
  it('有诊断记录时显示分片数、词数、版本与耗时', async () => {
    renderOnboarding(async () => dictLogs);
    await waitFor(() => {
      expect(screen.getByText(/3004 词/)).toBeDefined();
    });
    expect(screen.getByText(/载入耗时 412 ms/)).toBeDefined();
    expect(screen.getByText(/版本 0\.1\.0/)).toBeDefined();
  });

  it('没有记录时说明"尚未载入"，不编数字', async () => {
    renderOnboarding(async () => []);
    await waitFor(() => {
      expect(screen.getByText(/尚未载入/)).toBeDefined();
    });
  });

  it('读日志失败也照常渲染（降级成"尚未载入"）', async () => {
    renderOnboarding(async () => {
      throw new Error('读不到日志');
    });
    await waitFor(() => {
      expect(screen.getByText(/尚未载入/)).toBeDefined();
    });
  });
});

describe('关闭引导：决定权交给调用方', () => {
  it('点「知道了，开始使用」调用 onDismiss（写库由 App 负责）', () => {
    const { onDismiss } = renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: '知道了，开始使用' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('按钮文案不与备份提醒的「知道了」重名（否则两处同名按钮会互相误触）', () => {
    renderOnboarding();
    expect(screen.queryByRole('button', { name: '知道了' })).toBeNull();
  });
});
