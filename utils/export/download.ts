/**
 * 下载（PLAN.md FR-G7：通过 `chrome.downloads` 下载）。
 *
 * 这是 `utils/export/` 里唯一碰浏览器 API 的部分，依赖通过 `DownloadDeps` 注入，
 * 因此"文件名对不对、BOM 有没有写上、URL 有没有回收"可以在 node 环境里断言，
 * 不必起浏览器。
 *
 * ⚠️ **对象 URL 延迟回收**：`downloads.download` 的回调表示"下载已开始"，
 * 不表示"内容已被读走"。对 blob URL 立刻 `revokeObjectURL` 有让下载中断的报告，
 * 而多留一会儿的代价只是几十毫秒的几 MB 内存。这里等 60 秒再回收。
 * （该平台行为**未在本仓库真机复核**，见 `verification/M1-7.md` 的未覆盖项。）
 */
import { browser } from 'wxt/browser';
import { tx } from '../i18n';
import type { ExportFile } from './formats';

export interface DownloadRequest {
  url: string;
  filename: string;
  saveAs?: boolean;
  conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
}

export interface DownloadDeps {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  download(request: DownloadRequest): Promise<number>;
  /** 延迟回收的调度器；测试注入同步实现即可断言"确实回收了" */
  scheduleRevoke(task: () => void, delayMs: number): void;
}

/** 对象 URL 的回收延迟，见文件头的说明 */
export const REVOKE_DELAY_MS = 60_000;

export function browserDownloadDeps(): DownloadDeps {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    download: async (request) => {
      const id = await browser.downloads.download(request);
      if (typeof id !== 'number' || id < 0) throw new Error(tx('浏览器没有接受这次下载'));
      return id;
    },
    scheduleRevoke: (task, delayMs) => {
      setTimeout(task, delayMs);
    },
  };
}

/**
 * 文件字节（FR-G4）。
 *
 * **BOM 在这里拼**（`\uFEFF` 作为第一个 Blob part），不在文本里：
 * 让 `toCsv` 保持"逐字符可断言"，而"文件开头到底有没有那三个字节"
 * 由这一层的测试去断言。
 */
export function fileBlob(file: ExportFile): Blob {
  const parts = file.bom ? ['\uFEFF', file.text] : [file.text];
  return new Blob(parts, { type: `${file.mime};charset=utf-8` });
}

/** 触发一次下载，返回 `chrome.downloads` 给的下载 id */
export async function downloadExportFile(
  file: ExportFile,
  deps: DownloadDeps = browserDownloadDeps(),
): Promise<number> {
  const url = deps.createObjectURL(fileBlob(file));

  try {
    return await deps.download({
      url,
      filename: file.filename,
      saveAs: false,
      // 同名文件不覆盖：同一分钟连导两次时不该把上一份吃掉
      conflictAction: 'uniquify',
    });
  } finally {
    deps.scheduleRevoke(() => deps.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
