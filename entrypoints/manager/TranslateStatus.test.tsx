/**
 * 翻译状态块的两件事（PLAN.md FR-D6 / FR-D7）：
 * 告知未确认时不显示统计、点了才写标记；计数分开报。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Meta } from '@/utils/db/types';
import { TranslateStatus } from './TranslateStatus';

function metaWith(translationNoticeAt: number | null): Meta {
  return {
    schemaVersion: 1,
    dictVersion: '',
    installedAt: 1,
    persistGranted: false,
    lastExportAt: null,
    lastSyncAt: null,
    syncState: 'idle',
    lastSyncError: null,
    onboardingDoneAt: null,
    translationNoticeAt,
    translateCalls: null,
    importedInflections: {},
  };
}

describe('FR-D7：首次开启告知', () => {
  it('没确认过 → 显示告知、不显示待翻译统计', async () => {
    render(
      <TranslateStatus
        loadMeta={async () => metaWith(null)}
        loadStats={async () => ({ pending: 3, failed: 0, exhausted: 0, waiting: 3 })}
        saveMeta={vi.fn() as never}
      />,
    );

    await waitFor(() => expect(document.querySelector('[data-block="translate-status"]')).not.toBeNull());
    expect(screen.getByRole('status')).toBeDefined();
    expect(document.body.textContent).toContain('只有你划选的那一句会离开浏览器');
    expect(document.body.textContent).not.toContain('待翻译');
  });

  it('点「我知道了」才写标记，写完切到统计视图', async () => {
    const save = vi.fn(async () => metaWith(123));
    render(
      <TranslateStatus
        loadMeta={async () => metaWith(null)}
        loadStats={async () => ({ pending: 2, failed: 0, exhausted: 0, waiting: 2 })}
        saveMeta={save as never}
      />,
    );

    const button = await screen.findByRole('button', { name: '我知道了，开启翻译' });
    fireEvent.click(button);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const patch = (save.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(typeof patch.translationNoticeAt).toBe('number');
    await waitFor(() => expect(document.body.textContent).toContain('待翻译'));
  });

  it('已确认过 → 直接显示统计', async () => {
    render(
      <TranslateStatus
        loadMeta={async () => metaWith(1)}
        loadStats={async () => ({ pending: 4, failed: 1, exhausted: 0, waiting: 5 })}
      />,
    );

    await waitFor(() => expect(document.body.textContent).toContain('待翻译 5 条'));
    expect(document.body.textContent).not.toContain('只有你划选的那一句');
  });
});

describe('FR-D6：计数与重试', () => {
  it('没有待办时说明白"没有"，不显示重试按钮', async () => {
    render(
      <TranslateStatus
        loadMeta={async () => metaWith(1)}
        loadStats={async () => ({ pending: 0, failed: 0, exhausted: 0, waiting: 0 })}
      />,
    );

    await waitFor(() => expect(document.body.textContent).toContain('没有待翻译的句子'));
    expect(screen.queryByRole('button', { name: '全部重试' })).toBeNull();
  });

  it('失败到顶的条数单独说出来（否则数字永远不归零，像是卡住）', async () => {
    render(
      <TranslateStatus
        loadMeta={async () => metaWith(1)}
        loadStats={async () => ({ pending: 0, failed: 0, exhausted: 2, waiting: 0 })}
      />,
    );

    await waitFor(() => expect(document.body.textContent).toContain('2 条已连续失败'));
    expect(screen.getByRole('button', { name: '全部重试' })).toBeDefined();
  });

  it('点「全部重试」调用 retry 并刷新计数', async () => {
    const retry = vi.fn(async () => 2);
    let calls = 0;
    const loadStats = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? ({ pending: 0, failed: 0, exhausted: 2, waiting: 0 } as never)
        : ({ pending: 2, failed: 0, exhausted: 0, waiting: 2 } as never);
    });

    render(<TranslateStatus loadMeta={async () => metaWith(1)} loadStats={loadStats as never} retry={retry as never} />);

    const button = await screen.findByRole('button', { name: '全部重试' });
    fireEvent.click(button);

    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.body.textContent).toContain('待翻译 2 条'));
  });

  it('读统计失败不崩，也不编数字', async () => {
    render(
      <TranslateStatus
        loadMeta={async () => metaWith(1)}
        loadStats={async () => {
          throw new Error('boom');
        }}
      />,
    );

    await waitFor(() => expect(document.body.textContent).toContain('句子翻译'));
    expect(document.body.textContent).not.toContain('待翻译');
  });
});
