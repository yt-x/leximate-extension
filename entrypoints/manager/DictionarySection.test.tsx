/**
 * 词库导入区的验收判定（`changes/M1M2-closeout.md` 切片 3，`plan/b-dictionary.md` FR-B7）。
 *
 * - C1 选文件后显示"将导入 N 条"预演，**分档可选**（标准档默认）
 * - C2 导入中显示进度，可取消；取消后提示已导入多少
 * - C3 表头不符时明确报错，不进入预演
 * - C4 「移除导入词库」有二次确认，确认后调用移除并提示
 * - C5 已导入时显示条数；未导入时显示引导（来源、文件名、体积）
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';

import { DictionarySection, type DictionaryDeps } from './DictionarySection';

const COLUMNS = [
  'word', 'phonetic', 'definition', 'translation', 'pos',
  'collins', 'oxford', 'tag', 'bnc', 'frq', 'exchange', 'detail', 'audio',
];
const HEADER = COLUMNS.join(',');

/** 按列序造一行，避免手数 13 个字段 */
function csvRow(fields: Partial<Record<(typeof COLUMNS)[number], string>>): string {
  return COLUMNS.map((c) => fields[c] ?? '').join(',');
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\r\n');
}

function makeFile(content: string, name = 'ecdict.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

function deps(patch: Partial<DictionaryDeps> = {}): DictionaryDeps {
  return {
    readImportedCount: vi.fn(async () => 0),
    parseAndCount: vi.fn(async () => ({ total: 14942, skippedBadRows: 0, standardTier: 14942 })),
    importFile: vi.fn(async () => ({ written: 14942, cancelled: false })),
    removeImported: vi.fn(async () => ({ removed: 14942 })),
    rebuildInflections: vi.fn(async () => ({ mappings: 56718 })),
    ...patch,
  };
}

const SAMPLE = csv(csvRow({ word: 'constraint', translation: 'n. 约束', tag: 'cet6' }));

describe('C1 预演与分档', () => {
  it('选文件后显示将导入的条数', async () => {
    const d = deps();
    render(<DictionarySection deps={d} />);
    fireEvent.change(screen.getByLabelText(/选择.*ecdict/i), {
      target: { files: [makeFile(SAMPLE)] },
    });
    await waitFor(() => expect(screen.getByText(/将导入/)).toBeTruthy());
    expect(screen.getByText(/14,942/)).toBeTruthy();
  });

  it('默认标准档；切到完整档时重新预演', async () => {
    const d = deps({
      parseAndCount: vi.fn(async (_text: string, tier: string) => ({
        total: tier === 'full' ? 770611 : 14942,
        skippedBadRows: 0,
        standardTier: 14942,
      })),
    });
    render(<DictionarySection deps={d} />);
    fireEvent.change(screen.getByLabelText(/选择.*ecdict/i), {
      target: { files: [makeFile(SAMPLE)] },
    });
    await waitFor(() => expect(screen.getByText(/14,942/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/完整词库/));
    await waitFor(() => expect(screen.getByText(/770,611/)).toBeTruthy());
  });

  it('预演里显示坏行数（不静默）', async () => {
    const d = deps({
      parseAndCount: vi.fn(async () => ({ total: 10, skippedBadRows: 3, standardTier: 10 })),
    });
    render(<DictionarySection deps={d} />);
    fireEvent.change(screen.getByLabelText(/选择.*ecdict/i), {
      target: { files: [makeFile(SAMPLE)] },
    });
    await waitFor(() => expect(screen.getByText(/跳过 3 行/)).toBeTruthy());
  });
});

describe('C2 导入进度与取消', () => {
  it('导入完成后显示写入条数', async () => {
    const d = deps();
    render(<DictionarySection deps={d} />);
    fireEvent.change(screen.getByLabelText(/选择.*ecdict/i), {
      target: { files: [makeFile(SAMPLE)] },
    });
    await waitFor(() => screen.getByText(/将导入/));
    fireEvent.click(screen.getByRole('button', { name: /开始导入/ }));
    await waitFor(() => expect(screen.getByText(/已导入 14,942 条/)).toBeTruthy());
    expect(d.importFile).toHaveBeenCalled();
  });

  it('取消后显示已导入多少', async () => {
    const d = deps({
      importFile: vi.fn(async () => ({ written: 4000, cancelled: true })),
    });
    render(<DictionarySection deps={d} />);
    fireEvent.change(screen.getByLabelText(/选择.*ecdict/i), {
      target: { files: [makeFile(SAMPLE)] },
    });
    await waitFor(() => screen.getByText(/将导入/));
    fireEvent.click(screen.getByRole('button', { name: /开始导入/ }));
    await waitFor(() => expect(screen.getByText(/已取消/)).toBeTruthy());
    expect(screen.getByText(/4,000/)).toBeTruthy();
  });
});

describe('C3 表头不符', () => {
  it('报错且不进入预演', async () => {
    const d = deps({
      parseAndCount: vi.fn(async () => {
        throw new Error('表头第 1 列应为 word，实际为 w');
      }),
    });
    render(<DictionarySection deps={d} />);
    fireEvent.change(screen.getByLabelText(/选择.*ecdict/i), {
      target: { files: [makeFile('w,x\r\na,b')] },
    });
    await waitFor(() => expect(screen.getByText(/表头第 1 列/)).toBeTruthy());
    expect(screen.queryByText(/将导入/)).toBeNull();
  });
});

describe('C4 移除导入词库', () => {
  it('已导入时显示条数，移除需二次确认', async () => {
    const d = deps({ readImportedCount: vi.fn(async () => 14942) });
    render(<DictionarySection deps={d} />);
    await waitFor(() => expect(screen.getByText(/已导入 14,942 条/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /移除导入词库/ }));
    expect(screen.getByText(/只删导入来的词/)).toBeTruthy();
    expect(d.removeImported).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /确认移除/ }));
    await waitFor(() => expect(d.removeImported).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/已移除/)).toBeTruthy());
  });

  it('点「重建变形索引」调用 deps 并显示重建条数', async () => {
    const rebuildInflections = vi.fn(async () => ({ mappings: 56718 }));
    const d = deps({ readImportedCount: vi.fn(async () => 14942), rebuildInflections });
    render(<DictionarySection deps={d} />);
    await waitFor(() => expect(screen.getByText(/已导入 14,942 条/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /重建变形索引/ }));
    await waitFor(() => expect(rebuildInflections).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/已重建 56,718 条变形索引/)).toBeTruthy());
  });
});

describe('C5 未导入时的引导', () => {
  it('显示来源与文件名，不显示移除按钮', async () => {
    const d = deps({ readImportedCount: vi.fn(async () => 0) });
    const { container } = render(<DictionarySection deps={d} />);
    await waitFor(() => expect(container.textContent).toMatch(/skywind3000\/ECDICT/));
    expect(container.textContent).toMatch(/ecdict\.csv/);
    expect(screen.queryByRole('button', { name: /移除导入词库/ })).toBeNull();
  });
});
