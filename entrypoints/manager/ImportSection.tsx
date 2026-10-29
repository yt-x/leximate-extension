/**
 * 设置页的导入区（PLAN.md FR-J4 ~ FR-J7）。
 *
 * 两步式，与 FR-E7 的"清空数据"同一手法：**先预演、再确认**，
 * 且确认框在界面内（不用 `window.confirm`，它会被扩展页拦截且无法测）。
 *
 * 本组件只做组装：解析、合并、统计、写入都在 `utils/import/` 的模块里，
 * 这里负责"选文件 → 预演 → 确认 → 结果"的状态流转与提示。
 * 词库探针与写入函数通过 `deps` 注入，因此可以在 jsdom 里用假词库验完整条链路。
 */
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { createPageDictLookup, warmDictForWords } from '@/utils/dict/browser';
import { createDataChangeNotifier } from '@/utils/manager/data-changed';
import { tx } from '@/utils/i18n';
import { notifyWordsChanged } from '@/utils/manager/words-bus';
import {
  applyImportPlan,
  loadExistingData,
  parseImport,
  planImport,
  type DictProbe,
  type ImportPlan,
  type ImportStats,
} from '@/utils/import';

export interface ImportDeps {
  /**
   * 载入词库并对这批词形预热，返回探针。
   *
   * ⚠️ 失败必须**抛错**：词库没载入时"查不到"与"未收录"无法区分，
   * 静默继续会把整份文件标成未收录（`CONSTRAINTS.md` 第 34 条）。
   */
  prepareProbe(rawWords: readonly string[]): Promise<DictProbe>;
  applyPlan(plan: ImportPlan): Promise<ImportStats>;
}

function browserDeps(): ImportDeps {
  return {
    async prepareProbe(rawWords) {
      // `dict/*` 是 web_accessible_resources 里的静态资源，读的是扩展自身、不出网。
      // WXT 生成的类型把 getURL 入参收窄到已知入口，这里绕开类型收窄（运行时行为一致）。
      const dictBase = (browser.runtime.getURL as (p: string) => string)('dict/');
      const dict = await createPageDictLookup(dictBase);
      await dict.warm();
      await warmDictForWords(dict, rawWords);

      return {
        lookup(surface) {
          const hit = dict.lookup(surface);
          if (!hit) return undefined;
          return {
            lemma: hit.entry.lemma,
            phoneticUs: hit.entry.phoneticUs,
            defZh: hit.entry.defZh,
            pos: hit.entry.pos,
          };
        },
      };
    },
    applyPlan: applyImportPlan,
  };
}

type Step = 'idle' | 'preview' | 'done';

export function ImportSection({ deps = browserDeps() }: { deps?: ImportDeps } = {}) {
  const [step, setStep] = useState<Step>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<ImportStats | null>(null);

  const notifyDataChanged = createDataChangeNotifier({
    sendToBackground: (message) => browser.runtime.sendMessage(message),
  });

  const pickFile = async (file: File) => {
    setError(null);
    setResult(null);
    setPlan(null);
    setBusy(true);

    try {
      const bundle = parseImport(await file.text());
      const probe = await deps.prepareProbe(bundle.words.map((word) => word.raw));
      const existing = await loadExistingData();

      setPlan(planImport(bundle, existing, { probe }));
      setFileName(file.name);
      setStep('preview');
    } catch (e) {
      setStep('idle');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!plan) return;
    setError(null);
    setBusy(true);

    try {
      const stats = await deps.applyPlan(plan);
      setResult(stats);
      setPlan(null);
      setStep('done');
      // 角标是全局的、词库变了要重算（跨上下文）；列表是同一上下文，走总线
      void notifyDataChanged();
      notifyWordsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const showStats = result ?? plan?.stats ?? null;

  return (
    <section style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: '.85rem', color: 'var(--muted)' }}>{tx('导入')}</h3>

      <div style={{ marginTop: 8 }}>
        <input
          type="file"
          accept=".json,application/json"
          aria-label={tx('选择导入文件')}
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // 允许连续选同一个文件（第二次导入同一份文件是常态，要验幂等得能再选一次）
            e.target.value = '';
            if (file) void pickFile(file);
          }}
        />
        <div className="hint">
          {tx('支持 MetWord 导出脚本产出的 JSON（存量迁移）与本项目导出的 JSON 备份（换机）。')}
          {tx('导入是合并：不覆盖已有的释义与音标，重复导入同一份文件不会产生重复数据。')}
        </div>
      </div>

      {busy && <p className="muted">{tx('处理中…')}</p>}

      {error && (
        <p className="error" role="alert" style={{ marginTop: 8 }}>
          {tx('导入失败：{error}', { error })}
        </p>
      )}

      {/* FR-J7：导入前预演——"将导入 N 词 / M 句，其中 K 词词库未收录" */}
      {step === 'preview' && plan && (
        <div className="danger" role="alertdialog" aria-label={tx('确认导入')} style={{ marginTop: 10 }}>
          <p style={{ margin: '0 0 6px' }}>
            {tx('将导入 {words} 词 / {scenes} 例句，其中 {unlisted} 词词库未收录。', {
              words: plan.stats.words,
              scenes: plan.stats.scenes,
              unlisted: plan.stats.unlistedWords,
            })}
          </p>
          <p className="hint" style={{ margin: '0 0 8px' }}>
            {tx('文件：{name} · 新增 {added} 词、合并 {merged} 词；新增 {scenes} 条例句，已存在 {dup} 条（不会重复写入）。', {
              name: fileName,
              added: plan.stats.newWords,
              merged: plan.stats.mergedWords,
              scenes: plan.stats.newScenes,
              dup: plan.stats.duplicateScenes,
            })}
            {plan.samples.length > 0 &&
              ` ${tx('例如：{samples}', { samples: plan.samples.map((s) => s.lemma).join('、') })}${plan.stats.words > plan.samples.length ? ' …' : ''}`}
          </p>
          {(plan.stats.skippedWords > 0 ||
            plan.stats.skippedScenes > 0 ||
            plan.stats.unparsedTimes > 0) && (
            <p className="hint" style={{ margin: '0 0 8px' }}>
              {plan.stats.skippedWords > 0 && tx('跳过 {n} 条坏词记录；', { n: plan.stats.skippedWords })}
              {plan.stats.skippedScenes > 0 && tx('跳过 {n} 条坏例句；', { n: plan.stats.skippedScenes })}
              {plan.stats.unparsedTimes > 0 &&
                tx('{n} 条时间无法解析，按导入时间处理。', { n: plan.stats.unparsedTimes })}
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={() => void confirm()} disabled={busy}>
              {busy ? tx('导入中…') : tx('确认导入')}
            </button>
            <button
              onClick={() => {
                setPlan(null);
                setStep('idle');
              }}
              disabled={busy}
            >
              {tx('取消')}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div role="status" style={{ marginTop: 10 }}>
          <p className="saved" style={{ margin: 0 }}>
            {tx('已导入 {words} 词 / {scenes} 条例句（文件里共 {file} 条，其余已存在）。', {
              words: result.words,
              scenes: result.newScenes,
              file: result.fileScenes,
            })}
          </p>
          <p className="hint" style={{ margin: 0 }}>
            {result.unlistedWords > 0 &&
              tx('{n} 词词库未收录，原平台释义已作为兜底保留。', { n: result.unlistedWords })}
            {result.statusChanged > 0 &&
              ` ${tx('{n} 词的状态按导入值更新。', { n: result.statusChanged })}`}
            {result.meetCountRaised > 0 &&
              ` ${tx('{n} 词的遇见次数取了两者较大值。', { n: result.meetCountRaised })}`}
          </p>
        </div>
      )}

      {showStats === null && !busy && !error && step === 'idle' && (
        <p className="hint">{tx('选一个文件后会先显示预演结果，确认后才写库。')}</p>
      )}
    </section>
  );
}
