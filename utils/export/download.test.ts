/**
 * 下载层（PLAN.md FR-G7 / FR-G4）的测试。
 *
 * 这里的两个断言点是**字节与调用参数**，不是"看起来对"：
 * BOM 到底有没有写进 Blob 的开头、交给 `chrome.downloads` 的文件名与冲突策略是什么。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  downloadExportFile,
  fileBlob,
  REVOKE_DELAY_MS,
  type DownloadDeps,
  type DownloadRequest,
} from './download';
import type { ExportFile } from './formats';

function makeFile(over: Partial<ExportFile> = {}): ExportFile {
  return {
    filename: 'leximate-csv-20261016-1503.csv',
    text: 'word,meetCount\r\nrun,3',
    mime: 'text/csv',
    bom: true,
    hint: '',
    ...over,
  };
}

function makeDeps(over: Partial<DownloadDeps> = {}) {
  const calls: DownloadRequest[] = [];
  const revoked: string[] = [];
  const scheduled: Array<() => void> = [];

  const deps: DownloadDeps = {
    createObjectURL: () => 'blob:test-url',
    revokeObjectURL: (url) => revoked.push(url),
    download: async (request) => {
      calls.push(request);
      return 42;
    },
    scheduleRevoke: (task) => scheduled.push(task),
    ...over,
  };

  return { deps, calls, revoked, scheduled };
}

describe('fileBlob：BOM 是字节层的事', () => {
  it('带 BOM 时开头是 EF BB BF 三个字节（必须断言字节：Blob.text() 会吃掉 BOM）', async () => {
    const blob = fileBlob(makeFile());
    expect(blob.type).toBe('text/csv;charset=utf-8');

    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    // ⚠️ 这条不是多余的：Blob.text() 走的是编码规范的 "UTF-8 decode"，
    // 它会**去掉**开头的 BOM。因此"文本里有 \uFEFF"这种断言根本测不到 BOM，
    // FR-G4（Excel 双击不乱码）只能靠上面的字节断言。
    const text = await blob.text();
    expect(text).toBe('word,meetCount\r\nrun,3');
    expect(text.startsWith('\uFEFF')).toBe(false);
  });

  it('不带 BOM 的格式一个多余字节都不加', async () => {
    const blob = fileBlob(makeFile({ bom: false, text: '#separator:tab' }));
    expect(await blob.text()).toBe('#separator:tab');
  });
});

describe('downloadExportFile', () => {
  it('把对象 URL 与文件名交给 downloads，同名不覆盖，并返回下载 id', async () => {
    const { deps, calls } = makeDeps();
    const id = await downloadExportFile(makeFile(), deps);

    expect(id).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('blob:test-url');
    expect(calls[0]?.filename).toBe('leximate-csv-20261016-1503.csv');
    expect(calls[0]?.conflictAction).toBe('uniquify');
    expect(calls[0]?.saveAs).toBe(false);
  });

  it('对象 URL 延迟回收：立刻 revoke 有让下载中断的报告', async () => {
    const { deps, revoked, scheduled } = makeDeps();
    await downloadExportFile(makeFile(), deps);

    expect(revoked).toEqual([]);
    expect(scheduled).toHaveLength(1);
    // 调度器拿到的延迟就是常量本身（真机上等 60 秒）
    scheduled.forEach((task) => task());
    expect(revoked).toEqual(['blob:test-url']);
  });

  it('调度器收到的延迟是 REVOKE_DELAY_MS', async () => {
    const scheduleRevoke = vi.fn();
    const { deps } = makeDeps({ scheduleRevoke });
    await downloadExportFile(makeFile(), deps);
    expect(scheduleRevoke).toHaveBeenCalledWith(expect.any(Function), REVOKE_DELAY_MS);
  });

  it('下载失败也要回收 URL（否则失败的每次导出都漏一个对象 URL）', async () => {
    const { deps, revoked, scheduled } = makeDeps({
      download: async () => {
        throw new Error('浏览器拒绝了下载');
      },
    });

    await expect(downloadExportFile(makeFile(), deps)).rejects.toThrow(/拒绝了下载/);
    scheduled.forEach((task) => task());
    expect(revoked).toEqual(['blob:test-url']);
  });
});
