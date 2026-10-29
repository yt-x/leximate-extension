/**
 * 导出面板（PLAN.md FR-G1 ~ FR-G7）。
 *
 * 位置在**生词页**而不是设置页：三个范围里有两个（当前筛选结果、选中项）
 * 只有在列表上下文里才说得清。设置页的「数据」区只留一句指向这里。
 *
 * 本组件只做组装：范围选择、列取值、格式序列化、文件名全在 `utils/export/` 的纯函数里，
 * 因此"导出的文件对不对"由那一层断言，这里只证明**接得对**
 * （选了 CSV 就一定按 CSV 走、点了导出就一定调到 `downloads`）。
 */
import { useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { getMeta, setMeta } from '@/utils/db/kv';
import type { ListRow } from '@/utils/manager/filter';
import { tx } from '@/utils/i18n';
import type { Selection } from '@/utils/manager/selection';
import {
  buildBackupPayload,
  buildExportFile,
  buildRecords,
  collectBackupData,
  columnsFromKeys,
  downloadExportFile,
  EXPORT_COLUMNS,
  EXPORT_SCOPES,
  EXPORT_TARGETS,
  loadScenesByWord,
  pickRows,
  scopeCounts,
  targetMeta,
  toRecordInputs,
  type BackupPayload,
  type ExportColumnKey,
  type ExportScope,
  type ExportTarget,
} from '@/utils/export';

export interface ExportPanelProps {
  rows: readonly ListRow[];
  filtered: readonly ListRow[];
  selection: Selection;
  /** 打开时的默认范围：从"批量 → 导出选中"进来时是 `selected` */
  initialScope?: ExportScope;
  onClose: () => void;
}

interface ExportResult {
  filename: string;
  words: number;
  scenes: number;
  hint: string;
}

export function ExportPanel({
  rows,
  filtered,
  selection,
  initialScope = 'all',
  onClose,
}: ExportPanelProps) {
  const [scope, setScope] = useState<ExportScope>(initialScope);
  const [target, setTarget] = useState<ExportTarget>('anki');
  const [csvColumns, setCsvColumns] = useState<ExportColumnKey[]>(
    EXPORT_COLUMNS.filter((column) => column.csvDefault).map((column) => column.key),
  );
  const [chapter, setChapter] = useState('');
  const [includeTranslations, setIncludeTranslations] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  const counts = useMemo(
    () => scopeCounts({ rows, filtered, selection }),
    [rows, filtered, selection],
  );
  const empty = counts[scope] === 0;

  const toggleColumn = (key: ExportColumnKey) => {
    setCsvColumns((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  const run = async () => {
    setError(null);
    setResult(null);
    setRunning(true);

    try {
      const picked = pickRows({ rows, filtered, scope, selection });
      if (picked.length === 0) {
        throw new Error(scope === 'selected' ? tx('还没有勾选任何词') : tx('没有可导出的词'));
      }
      if (target === 'csv' && csvColumns.length === 0) throw new Error(tx('至少要勾选一列'));

      // FR-G8：这里的三个读取全是只读事务，导出不改库
      const scenesByWord = await loadScenesByWord();
      const records = buildRecords(toRecordInputs(picked, scenesByWord));

      let backup: BackupPayload | undefined;
      if (target === 'json') {
        const { words, scenes } = collectBackupData(picked, scenesByWord);
        const meta = await getMeta();
        backup = buildBackupPayload({
          words,
          scenes,
          appVersion: browser.runtime.getManifest().version,
          dictVersion: meta.dictVersion,
          includeTranslations,
          at: new Date(),
        });
      }

      const file = buildExportFile({ target, records, csvColumns, chapter, backup });
      await downloadExportFile(file);

      // FR-L6 的输入：只写这一条元数据，不动词与例句
      await setMeta({ lastExportAt: Date.now() });

      const sceneCount = picked.reduce(
        (total, row) => total + (scenesByWord.get(row.word.id)?.length ?? 0),
        0,
      );
      setResult({
        filename: file.filename,
        words: picked.length,
        scenes: sceneCount,
        hint: file.hint,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <div
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={tx('导出')}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <h2 style={{ margin: 0 }}>{tx('导出')}</h2>
          <button onClick={onClose} aria-label={tx('关闭导出面板')}>
            {tx('关闭')}
          </button>
        </div>

        <section>
          <h3>{tx('范围')}</h3>
          {EXPORT_SCOPES.map((item) => (
            <label key={item.value} style={{ display: 'block', marginBottom: 2 }}>
              <input
                type="radio"
                name="export-scope"
                value={item.value}
                checked={scope === item.value}
                onChange={() => setScope(item.value)}
              />
              {tx(item.label)}（{counts[item.value]}）
            </label>
          ))}
          {empty && (
            <p className="hint">
              {scope === 'selected' ? tx('先在列表里勾选要导出的词。') : tx('这个范围里没有词。')}
            </p>
          )}
        </section>

        <section>
          <h3>{tx('格式')}</h3>
          <select
            aria-label={tx('导出格式')}
            value={target}
            onChange={(e) => setTarget(e.target.value as ExportTarget)}
            style={{ width: '100%' }}
          >
            {EXPORT_TARGETS.map((item) => (
              <option key={item.value} value={item.value}>
                {tx(item.label)}
              </option>
            ))}
          </select>
          <p className="hint">{tx(targetMeta(target).hint)}</p>
        </section>

        {/* FR-G3：通用 CSV 允许勾选要哪些列 */}
        {target === 'csv' && (
          <section>
            <h3>{tx('列（{n}）', { n: csvColumns.length })}</h3>
            {EXPORT_COLUMNS.map((column) => (
              <label key={column.key} style={{ display: 'inline-block', marginRight: 12 }}>
                <input
                  type="checkbox"
                  aria-label={tx('列 {header}', { header: column.csvHeader })}
                  checked={csvColumns.includes(column.key)}
                  onChange={() => toggleColumn(column.key)}
                />
                {column.csvHeader}
              </label>
            ))}
          </section>
        )}

        {/* §3.2.4：墨墨的章节模式，可选 */}
        {target === 'maimemo' && (
          <section>
            <h3>{tx('章节名（可选）')}</h3>
            <input
              aria-label={tx('章节名')}
              value={chapter}
              placeholder={tx('例如 考研核心')}
              onChange={(e) => setChapter(e.target.value)}
              style={{ width: '100%' }}
            />
            <p className="hint">{tx('留空则只输出单词表；填了就写成一行 `#章节名`（半角 #）。')}</p>
          </section>
        )}

        {/* OQ8：JSON 是否带翻译 */}
        {target === 'json' && (
          <section>
            <label>
              <input
                type="checkbox"
                checked={includeTranslations}
                onChange={(e) => setIncludeTranslations(e.target.checked)}
              />
              {tx('包含例句翻译（OQ8）')}
            </label>
            <p className="hint">{tx('备份只含词与例句，不含设置与任何凭据。')}</p>
          </section>
        )}

        {error && (
          <p className="error" role="alert" style={{ marginTop: 12 }}>
            {tx('导出失败：{error}', { error })}
          </p>
        )}

        {result && (
          <div role="status" style={{ marginTop: 12 }}>
            <p className="saved" style={{ margin: 0 }}>
              {tx('已导出 {filename}（{words} 词 / {scenes} 例句）', {
                filename: result.filename,
                words: result.words,
                scenes: result.scenes,
              })}
            </p>
            {/* 后继操作必须当场说清：不背单词与墨墨的文件里只有单词，
                用户会以为导出坏了 */}
            <p className="hint">{tx(result.hint)}</p>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={() => void run()} disabled={running || empty}>
            {running ? tx('导出中…') : tx('导出')}
          </button>
          <button onClick={onClose} disabled={running}>
            {tx('取消')}
          </button>
        </div>

        <p className="hint">
          {tx('导出不会修改或删除任何本地数据（FR-G8）；导出的列结构见 PLAN.md §3.1。')}
          {target === 'csv' ? tx('当前选了 {n} 列。', { n: columnsFromKeys(csvColumns).length }) : ''}
        </p>
      </div>
    </div>
  );
}
