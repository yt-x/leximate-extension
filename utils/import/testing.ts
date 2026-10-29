/**
 * 导入器单测的夹具：造两种格式的文件。
 *
 * 形状逐字对齐两处真实来源：
 * - `tools/metword-export/export.js`（M0 脚本的 `payload`）
 * - `PLAN.md` FR-G2 的 JSON 备份（本项目 M1-7 的导出）
 *
 * 与真实文件的差异只有规模（这里是 2~3 个词）：真实导出是 539 词 / 623 句
 * （`verification/M0-2.md`），解析与合并的逻辑与规模无关。
 */
import type { Scene, Word } from '../db/types';

export interface MetwordSceneInput {
  text: string;
  sourceUrl?: string;
  /** 真实文件里是链接 `title` 上的日期文本 */
  capturedAt?: string;
  highlightFrom?: number;
  highlightTo?: number;
}

export interface MetwordWordInput {
  word: string;
  status?: 'new' | 'known';
  meetCount?: number | null;
  phoneticUs?: string;
  defZh?: string[];
  firstSeenAt?: string;
  scenes?: MetwordSceneInput[];
}

/** M0 脚本的 JSON 形态（字段名逐字取自 `export.js`） */
export function metwordExport(words: readonly MetwordWordInput[]): Record<string, unknown> {
  return {
    meta: {
      source: 'https://app.metword.co',
      exportedAt: '2026-10-13T10:00:00.000Z',
      apiFormCount: 1290,
      scrapedWordCount: words.length,
      sceneCount: words.reduce((total, word) => total + (word.scenes?.length ?? 0), 0),
    },
    words: words.map((word) => ({
      word: word.word,
      phoneticUs: word.phoneticUs ?? '',
      phoneticUk: '',
      meetCountLabel: word.meetCount ?? 1,
      firstSeenAt: word.firstSeenAt ?? '2026-09-01',
      status: word.status ?? 'new',
      meetCount: word.meetCount ?? 1,
      ...(word.defZh ? { defZh: word.defZh } : {}),
      scenes: (word.scenes ?? []).map((scene) => ({
        text: scene.text,
        highlightFrom: scene.highlightFrom ?? 0,
        highlightTo: scene.highlightTo ?? 5,
        sourceUrl: scene.sourceUrl ?? 'https://example.com/article',
        capturedAt: scene.capturedAt ?? '2026-09-02',
        domain: 'example.com',
      })),
    })),
  };
}

/** 本项目的 JSON 备份形态（`utils/export/formats.ts` 的 `BackupPayload`） */
export function leximateBackup(input: {
  words: readonly Word[];
  scenes: readonly Scene[];
  appVersion?: string;
  dictVersion?: string;
}): Record<string, unknown> {
  return {
    app: 'leximate',
    schemaVersion: 1,
    exportedAt: '2026-10-16T00:00:00.000Z',
    appVersion: input.appVersion ?? '0.1.0',
    dictVersion: input.dictVersion ?? '0.1.0',
    counts: { words: input.words.length, scenes: input.scenes.length },
    words: input.words,
    scenes: input.scenes,
  };
}
