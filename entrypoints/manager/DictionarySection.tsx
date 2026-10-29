/**
 * 设置页的**词库导入区**（PLAN.md FR-B7，`changes/M1M2-closeout.md` 切片 3）。
 *
 * 与 `ImportSection.tsx`（生词迁移）是两件事：
 * - 这里导入的是**词典**（静态词条，没有例句、没有遇见次数）；
 * - 那边导入的是**用户数据**（生词 + 例句 + 状态）。
 *
 * 两步式与 `ImportSection` 一致：**先预演、再确认**，确认框在界面内
 * （`window.confirm` 会被扩展页拦截且无法测）。
 *
 * 数据不入包：ECDICT 由用户自备，界面只给官方仓库与文件名，不给镜像地址
 * （镜像会变，写进界面就成了腐化源）。
 */
import { useEffect, useRef, useState } from 'react';

import { tx } from '@/utils/i18n';

export type DictionaryTier = 'standard' | 'full';

export interface DictionaryPreview {
  /** 按档过滤后的条数 */
  total: number;
  /** 字段数异常被跳过的行数（不静默） */
  skippedBadRows: number;
  /** 标准档条数（用于在界面上说明两档差别） */
  standardTier: number;
}

export interface DictionaryDeps {
  /** 当前已导入的条数（0 = 没导入过） */
  readImportedCount(): Promise<number>;
  /** 解析文件并按档预演条数；表头不符时**抛错** */
  parseAndCount(text: string, tier: DictionaryTier): Promise<DictionaryPreview>;
  /** 执行导入；`isCancelled` 在每批之间被问一次 */
  importFile(
    text: string,
    tier: DictionaryTier,
    hooks: { isCancelled: () => boolean; onProgress: (written: number) => void },
  ): Promise<{ written: number; cancelled: boolean }>;
  /** 移除导入词库（只删导入词，保留内置词与生词本） */
  removeImported(): Promise<{ removed: number }>;
  /**
   * 从现有 dict 重建变形映射（修复「词典有数据、映射为空」的不一致状态）。
   * 返回重建出的映射条数。不重新导入词典。
   */
  rebuildInflections(): Promise<{ mappings: number }>;
}

type Step = 'idle' | 'preview' | 'importing' | 'done';

export function DictionarySection({ deps }: { deps: DictionaryDeps }) {
  const [step, setStep] = useState<Step>('idle');
  const [tier, setTier] = useState<DictionaryTier>('standard');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<DictionaryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<{ written: number; cancelled: boolean } | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removed, setRemoved] = useState<number | null>(null);
  const [rebuilt, setRebuilt] = useState<number | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void deps
      .readImportedCount()
      .then((n) => {
        if (alive) setImportedCount(n);
      })
      .catch(() => {
        if (alive) setImportedCount(0);
      });
    return () => {
      alive = false;
    };
  }, [deps]);

  const previewWith = async (content: string, nextTier: DictionaryTier) => {
    setError(null);
    setOutcome(null);
    setRemoved(null);
    try {
      const result = await deps.parseAndCount(content, nextTier);
      setPreview(result);
      setStep('preview');
    } catch (e) {
      setPreview(null);
      setStep('idle');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickFile = async (file: File) => {
    const content = await file.text();
    setText(content);
    setFileName(file.name);
    setTier('standard');
    await previewWith(content, 'standard');
  };

  const changeTier = async (next: DictionaryTier) => {
    setTier(next);
    if (text) await previewWith(text, next);
  };

  const start = async () => {
    if (!text) return;
    cancelRef.current = false;
    setStep('importing');
    setProgress(0);
    setError(null);
    try {
      const result = await deps.importFile(text, tier, {
        isCancelled: () => cancelRef.current,
        onProgress: (written) => setProgress(written),
      });
      setOutcome(result);
      setStep('done');
      const n = await deps.readImportedCount();
      setImportedCount(n);
    } catch (e) {
      setStep('idle');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doRemove = async () => {
    setConfirmRemove(false);
    try {
      const result = await deps.removeImported();
      setRemoved(result.removed);
      setImportedCount(0);
      setOutcome(null);
      setStep('idle');
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doRebuild = async () => {
    setRebuilt(null);
    setError(null);
    try {
      const result = await deps.rebuildInflections();
      setRebuilt(result.mappings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const nf = (n: number) => n.toLocaleString('en-US');

  return (
    <section aria-label={tx('词库')}>
      <h3>{tx('词库')}</h3>

      <p>
        {tx('内置核心词表覆盖常用词；低频词需要你自己下载 ECDICT 数据文件后导入，数据不进扩展包。')}
      </p>
      <p>{tx('导入的是查词用的词典，不会把这些词加进生词本。')}</p>
      <p>
        <code>skywind3000/ECDICT</code> · <code>ecdict.csv</code> ·{' '}
        {tx('约 62 MB（完整）/ 3.5 MB（标准档）')}
      </p>

      {importedCount !== null && importedCount > 0 ? (
        <p>{tx('已导入 {n} 条', { n: nf(importedCount) })}</p>
      ) : null}

      <label>
        {tx('选择 ecdict.csv 文件')}
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label={tx('选择 ecdict.csv 文件')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pickFile(file);
          }}
        />
      </label>

      <fieldset>
        <legend>{tx('导入范围')}</legend>
        <label>
          <input
            type="radio"
            name="dict-tier"
            checked={tier === 'standard'}
            onChange={() => void changeTier('standard')}
          />
          {tx('标准档（考试词，导入快）')}
        </label>
        <label>
          <input
            type="radio"
            name="dict-tier"
            checked={tier === 'full'}
            onChange={() => void changeTier('full')}
          />
          {tx('完整词库（约 77 万条，需要几分钟）')}
        </label>
      </fieldset>

      {error ? <p role="alert">{error}</p> : null}

      {step === 'preview' && preview ? (
        <div>
          <p>
            {tx('将导入 {n} 条', { n: nf(preview.total) })}
            {preview.skippedBadRows > 0
              ? ` · ${tx('跳过 {n} 行（字段数异常）', { n: nf(preview.skippedBadRows) })}`
              : ''}
            {fileName ? ` · ${fileName}` : ''}
          </p>
          <button type="button" onClick={() => void start()}>
            {tx('开始导入')}
          </button>
        </div>
      ) : null}

      {step === 'importing' ? (
        <div>
          <p>
            {tx('正在导入…已写入 {n} 条', { n: nf(progress) })}
          </p>
          <button
            type="button"
            onClick={() => {
              cancelRef.current = true;
            }}
          >
            {tx('取消')}
          </button>
        </div>
      ) : null}

      {step === 'done' && outcome ? (
        <p>
          {outcome.cancelled
            ? tx('已取消 · 已导入 {n} 条', { n: nf(outcome.written) })
            : tx('已导入 {n} 条', { n: nf(outcome.written) })}
        </p>
      ) : null}

      {removed !== null ? <p>{tx('已移除 {n} 条导入词', { n: nf(removed) })}</p> : null}

      {rebuilt !== null ? <p>{tx('已重建 {n} 条变形索引', { n: nf(rebuilt) })}</p> : null}

      {importedCount !== null && importedCount > 0 ? (
        <div>
          {confirmRemove ? (
            <div>
              <p>{tx('只删导入来的词，内置词表与你的生词本不受影响。确定移除？')}</p>
              <button type="button" onClick={() => void doRemove()}>
                {tx('确认移除')}
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)}>
                {tx('取消')}
              </button>
            </div>
          ) : (
            <div>
              <button type="button" onClick={() => void doRebuild()}>
                {tx('重建变形索引')}
              </button>
              <button type="button" onClick={() => setConfirmRemove(true)}>
                {tx('移除导入词库')}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
