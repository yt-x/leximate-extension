/**
 * 同步状态块（PLAN.md FR-H6）：三种时间状态、成功、失败都要说清楚。
 *
 * 这里最要紧的一条是**失败时不假装成功**——界面上的"上次成功时间"只能来自库里，
 * 不能因为按钮点过就往前推。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Meta } from '@/utils/db/types';
import { SyncStatus } from './SyncStatus';

function metaWith(lastSyncAt: number | null): Meta {
  return {
    schemaVersion: 1,
    dictVersion: '',
    installedAt: 1,
    persistGranted: false,
    lastExportAt: null,
    lastSyncAt,
    syncState: 'idle',
    lastSyncError: null,
    onboardingDoneAt: null,
    translationNoticeAt: null,
    translateCalls: null,
    importedInflections: {},
  };
}

describe('FR-H6：同步状态', () => {
  it('从未同步 → 直说没同步过，不显示一个假时间', async () => {
    render(<SyncStatus loadMeta={async () => metaWith(null)} />);

    await waitFor(() => expect(document.body.textContent).toContain('还没有成功同步过'));
  });

  it('有过同步 → 显示上次成功时间', async () => {
    render(<SyncStatus loadMeta={async () => metaWith(1700000000000)} />);

    await waitFor(() => expect(document.body.textContent).toContain('上次成功同步'));
  });

  it('手动同步成功 → 显示完成，并重读真实时间', async () => {
    const loadMeta = vi.fn(async () => metaWith(null));
    const requestSync = vi.fn(async () => ({ ok: true }));

    render(<SyncStatus loadMeta={loadMeta} requestSync={requestSync} />);
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }));

    await waitFor(() => expect(document.body.textContent).toContain('同步完成'));
    // 读了一次（初始）+ 一次（跑完重读）
    expect(loadMeta.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('失败 → 显示原因，且不说"完成"', async () => {
    const requestSync = vi.fn(async () => ({ ok: false, message: 'HTTP 401' }));

    render(<SyncStatus loadMeta={async () => metaWith(null)} requestSync={requestSync} />);
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }));

    await waitFor(() => expect(document.body.textContent).toContain('同步失败'));
    expect(document.body.textContent).toContain('HTTP 401');
    expect(document.body.textContent).not.toContain('同步完成');
  });

  it('请求本身抛错也不崩（把错误说出来）', async () => {
    const requestSync = vi.fn(async () => {
      throw new Error('消息通道断了');
    });

    render(<SyncStatus loadMeta={async () => metaWith(null)} requestSync={requestSync} />);
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }));

    await waitFor(() => expect(document.body.textContent).toContain('消息通道断了'));
  });

  it('自动同步失败后在重载时仍显示持久化错误', async () => {
    render(<SyncStatus loadMeta={async () => ({
      ...metaWith(null), syncState: 'error', lastSyncError: 'HTTP 401',
    })} />);

    await waitFor(() => expect(document.body.textContent).toContain('HTTP 401'));
    expect(document.body.textContent).toContain('同步失败');
  });

  it('自动同步进行中在重载时也显示同步中', async () => {
    render(<SyncStatus loadMeta={async () => ({
      ...metaWith(null), syncState: 'running', lastSyncError: null,
    })} />);

    await waitFor(() => expect(document.body.textContent).toContain('同步中'));
    expect(screen.getByRole('button', { name: '同步中…' })).toHaveProperty('disabled', true);
  });

  it('读 meta 失败时显示"未知"，不编时间', async () => {
    render(
      <SyncStatus
        loadMeta={async () => {
          throw new Error('boom');
        }}
      />,
    );

    await waitFor(() => expect(document.body.textContent).toContain('同步状态'));
    expect(document.body.textContent).not.toContain('上次成功同步');
    expect(document.body.textContent).not.toContain('还没有成功同步过');
  });
});
