/**
 * 生词列表（PLAN.md FR-F2 ~ FR-F6）。
 *
 * 本组件只做**组装与渲染**：筛选、排序、切片、统计、选中集运算全在
 * `utils/manager/` 的纯函数里（都有单测）。这样界面改样式不会影响那些判定。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { WordStatus } from '@/utils/db/types';
import { softDeleteWord, updateWordStatus } from '@/utils/db/words';
import { createDataChangeNotifier } from '@/utils/manager/data-changed';
import { onWordsChanged } from '@/utils/manager/words-bus';
import {
  availableFacets,
  DEFAULT_SORT,
  selectRows,
  type FilterCriteria,
  type ListRow,
  type SortKey,
  type SortSpec,
} from '@/utils/manager/filter';
import { computeStats } from '@/utils/manager/stats';
import { loadRows } from '@/utils/manager/load';
import { computeWindow } from '@/utils/manager/virtual';
import {
  BULK_STATUSES,
  clearSelection,
  deleteConfirmText,
  idsOf,
  isAllSelected,
  liveIds,
  selectAll,
  deselectAll,
  toggleOne,
} from '@/utils/manager/selection';
import { WordDrawer } from './WordDrawer';
import { ExportPanel } from './ExportPanel';
import { tx } from '@/utils/i18n';
import type { ExportScope } from '@/utils/export';

/** FR-F2 的行高，与 `styles.ts` 的 `--row-h` 保持一致 */
const ROW_HEIGHT = 40;
/** FR-F3：输入去抖 150ms（PLAN.md §1.F 的实现口径） */
const SEARCH_DEBOUNCE_MS = 150;


/** 排序键的展示顺序（标签在渲染期由 sortLabel() 取，不能做成模块常量） */
const SORT_ORDER: readonly SortKey[] = ['createdAt', 'meetCount', 'freqBnc', 'lemma'];
/** 状态的多选顺序（`Object.keys` 不再依赖标签表：标签要按当前语言取） */
const STATUS_ORDER: readonly WordStatus[] = ['new', 'known', 'ignored'];

/** FR-L1：标签必须**渲染期**取，不能做成模块级常量（语言切换后要跟着变） */
function statusLabel(status: WordStatus): string {
  return tx(status === 'new' ? '生词' : status === 'known' ? '已掌握' : '忽略');
}

function sortLabel(key: SortKey): string {
  // 中文原文本身是 `tx()` 的查找键，必须与覆盖层一致；写在同一个表达式里也是为了
  // 让"未包裹中文"的门禁能一眼看出这一行已经走过 tx()。
  return tx(key === 'createdAt' ? '时间' : key === 'meetCount' ? '遇见' : key === 'freqBnc' ? '词频' : '字母');
}

export function WordList() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 搜索输入与"已生效的搜索词"分开：前者随每次按键变，后者去抖后才跟上。
  // 直接用输入值过滤会让每个字符都触发一次全量重算 + 重渲染。
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [criteria, setCriteria] = useState<FilterCriteria>({});
  const [sort, setSort] = useState<SortSpec>(DEFAULT_SORT);
  const [selection, setSelection] = useState(clearSelection);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [openWordId, setOpenWordId] = useState<string | null>(null);
  /** FR-G1：导出面板是否打开，以及打开时的默认范围 */
  const [exportScope, setExportScope] = useState<ExportScope | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);

  // FR-F3 去抖：停顿 150ms 才真正过滤
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 只读**活着的**词（默认口径排除墓碑）：
      // 墓碑是给同步用的删除标记（§2），既不该出现在行里（筛选层也会丢掉它们），
      // 也不该出现在计数分母里（否则删光了还显示 `0 / 67`）。
      // `applyStatus` 的 `liveIds` 也依赖这一点——"作用于当前仍存在的词"。
      setRows(await loadRows());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * FR-E7：别的页面（设置页）清空数据后要重新读库。
   *
   * 本组件在 `App.tsx` 里是**一直挂着的**（用 `hidden` 切换，为的是保住滚动位置
   * 与筛选，见 FR-F7），所以它不会重新挂载，也就不会自己去重读库——
   * 没有这条订阅，清空后切回来看到的还是旧行。
   */
  useEffect(() => onWordsChanged(() => void reload()), [reload]);

  // 视口高度变化要重新切片；否则窗口大小变了会露白
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const effectiveCriteria = useMemo<FilterCriteria>(
    () => ({ ...criteria, search }),
    [criteria, search],
  );

  const filtered = useMemo(
    () => selectRows(rows, effectiveCriteria, sort),
    [rows, effectiveCriteria, sort],
  );

  const stats = useMemo(() => computeStats(rows, Date.now()), [rows]);
  const facets = useMemo(() => availableFacets(rows), [rows]);

  const win = useMemo(
    () => computeWindow(filtered, scrollTop, viewportHeight, ROW_HEIGHT),
    [filtered, scrollTop, viewportHeight],
  );

  const allIds = useMemo(() => idsOf(filtered), [filtered]);
  const selectedLive = liveIds(selection, allIds);

  /** 改完库之后通知后台重算角标（FR-A14）；后台被回收时静默失败即可 */
  const notifyDataChanged = useMemo(
    () =>
      createDataChangeNotifier({
        sendToBackground: (message) => browser.runtime.sendMessage(message),
      }),
    [],
  );

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'lemma' ? 'asc' : 'desc' },
    );
  };

  const applyStatus = async (status: WordStatus) => {
    // 作用于**当前仍存在**的选中项：选中集可能包含已在别处删掉的词，
    // 拿旧 id 去改状态会静默少几条（见 selection.ts 的 liveIds 说明）
    const ids = liveIds(selection, idsOf(rows));
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => updateWordStatus(id, status)));
    // FR-A14：词数/状态变了要通知后台重算角标（管理台与后台是两个页面）
    void notifyDataChanged();
    setSelection(clearSelection());
    await reload();
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    // 软删除：FR-G8 要求导出无损，删除也只置墓碑，不物理抹掉
    await Promise.all(pendingDelete.map((id) => softDeleteWord(id)));
    // FR-A14：墓碑不再计入角标（`countWords` 排除 `deletedAt`），
    // 但后台不会自己知道这次写入，必须显式通知
    void notifyDataChanged();
    setPendingDelete(null);
    setSelection(clearSelection());
    await reload();
  };

  const openWord = openWordId ? rows.find((r) => r.word.id === openWordId) : undefined;

  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="n">{stats.totalWords}</div>
          <div className="k">{tx('总词数')}</div>
        </div>
        <div className="stat">
          <div className="n">{stats.newToday}</div>
          <div className="k">{tx('今日新增')}</div>
        </div>
        <div className="stat">
          <div className="n">{stats.knownCount}</div>
          <div className="k">{tx('已掌握')}</div>
        </div>
        <div className="stat">
          <div className="n">{stats.totalScenes}</div>
          <div className="k">{tx('例句总数')}</div>
        </div>
        {stats.topDomains.length > 0 && (
          <div className="stat" style={{ minWidth: 180 }}>
            <div className="k">{tx('来源域名 Top {count}', { count: stats.topDomains.length })}</div>
            <div className="muted" style={{ fontSize: '.82rem' }}>
              {stats.topDomains.map((d) => `${d.domain} (${d.count})`).join('、')}
            </div>
          </div>
        )}
      </div>

      <div className="toolbar">
        <input
          className="grow"
          type="search"
          placeholder={tx('搜索词形（子串匹配，大小写不敏感）')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select
          value={criteria.hasScenes === undefined ? '' : String(criteria.hasScenes)}
          onChange={(e) => {
            const v = e.target.value;
            setCriteria((c) => ({
              ...c,
              hasScenes: v === '' ? undefined : v === 'true',
            }));
          }}
        >
          <option value="">{tx('全部（有无例句）')}</option>
          <option value="true">{tx('仅有序例句')}</option>
          <option value="false">{tx('仅无例句')}</option>
        </select>
        <button
          onClick={() => {
            setCriteria({});
            setSearchInput('');
            setSearch('');
          }}
        >
          {tx('清除筛选')}
        </button>
        {/* FR-G1：有筛选条件时默认导出"当前筛选结果"——用户筛完再点导出，
            想要的几乎总是筛出来的那批；没筛选时才默认"全部"。 */}
        <button onClick={() => setExportScope(filtered.length < rows.length ? 'filtered' : 'all')}>
          {tx('导出…')}
        </button>
        {/* 计数口径：分子是**筛选后可见**的行数，分母是**当前库里活着的词数**
            （不含墓碑）。墓碑不该出现在这里——它是给同步用的删除标记，
            把它算进分母会让"删光了"的库显示成 `0 / 67`。 */}
        <span className="muted count">
          {filtered.length} / {rows.length}
          {selectedLive.length > 0 ? tx('已选 {count}', { count: selectedLive.length }) : ''}
        </span>
      </div>

      <div className="facets">
        <div className="facet">
          <label htmlFor="f-status">{tx('状态（可多选）')}</label>
          <select
            id="f-status"
            multiple
            value={criteria.statuses ?? []}
            onChange={(e) =>
              setCriteria((c) => ({
                ...c,
                statuses: [...e.target.selectedOptions].map((o) => o.value as WordStatus),
              }))
            }
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {tx(s === 'new' ? '生词' : s === 'known' ? '已掌握' : '忽略')}
              </option>
            ))}
          </select>
        </div>

        <div className="facet">
          <label htmlFor="f-domain">{tx('来源域名（可多选）')}</label>
          <select
            id="f-domain"
            multiple
            value={criteria.domains ?? []}
            onChange={(e) =>
              setCriteria((c) => ({
                ...c,
                domains: [...e.target.selectedOptions].map((o) => o.value),
              }))
            }
          >
            {facets.domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>

        <div className="facet">
          <label htmlFor="f-tag">{tx('考试标签（可多选）')}</label>
          {/* FR-F4：考试标签只有导入完整词库（FR-B7）后才有数据 */}
          <select
            id="f-tag"
            multiple
            disabled={facets.examTags.length === 0}
            value={criteria.examTags ?? []}
            onChange={(e) =>
              setCriteria((c) => ({
                ...c,
                examTags: [...e.target.selectedOptions].map((o) => o.value),
              }))
            }
          >
            {facets.examTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {facets.examTags.length === 0 ? (
            <small>{tx('导入完整词库后可用')}</small>
          ) : null}
        </div>

        <div className="facet">
          <label htmlFor="f-from">{tx('词频区间（BNC 排名）')}</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="f-from"
              type="number"
              min={0}
              style={{ width: 70 }}
              placeholder={tx('从')}
              aria-label={tx('词频下限')}
              value={criteria.freqFrom ?? ''}
              disabled={facets.examTags.length === 0}
              onChange={(e) =>
                setCriteria((c) => ({
                  ...c,
                  freqFrom: e.target.value === '' ? null : Number(e.target.value),
                }))
              }
            />
            <input
              type="number"
              min={0}
              style={{ width: 70 }}
              placeholder={tx('到')}
              aria-label={tx('词频上限')}
              value={criteria.freqTo ?? ''}
              disabled={facets.examTags.length === 0}
              onChange={(e) =>
                setCriteria((c) => ({
                  ...c,
                  freqTo: e.target.value === '' ? null : Number(e.target.value),
                }))
              }
            />
          </div>
          {facets.examTags.length === 0 ? (
            <small>{tx('导入完整词库后可用')}</small>
          ) : null}
        </div>
      </div>

      {selectedLive.length > 0 && (
        <div className="toolbar">
          <span>{tx('批量：')}</span>
          {BULK_STATUSES.map((s) => (
            <button key={s} onClick={() => void applyStatus(s)}>
              {tx('改为{status}', { status: statusLabel(s) })}
            </button>
          ))}
          <button
            onClick={() =>
              setPendingDelete(liveIds(selection, idsOf(rows)))
            }
          >
            {tx('删除')}
          </button>
          {/* FR-F6 的"仅导出选中项"：直接以 selected 范围打开同一个面板 */}
          <button onClick={() => setExportScope('selected')}>{tx('导出选中')}</button>
          <button onClick={() => setSelection(clearSelection())}>{tx('取消选择')}</button>
        </div>
      )}

      {pendingDelete && (
        <div className="confirm-bar">
          <span className="error">{deleteConfirmText(pendingDelete.length)}</span>
          <button onClick={() => void confirmDelete()}>{tx('确认删除')}</button>
          <button onClick={() => setPendingDelete(null)}>{tx('取消')}</button>
        </div>
      )}

      {error && <p className="error">{tx('加载失败：{error}', { error })}</p>}

      {pendingDelete === null && (
        <>
          <div className="sort-controls" aria-label={tx('排序')}>
            {SORT_ORDER.map((key) => (
              <button key={key} onClick={() => toggleSort(key)}>
                {sortLabel(key)}
                {sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
              </button>
            ))}
          </div>
          <div
            className="scroller"
          ref={scrollerRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div className="table-head">
            <input
              type="checkbox"
              aria-label={tx('全选')}
              checked={isAllSelected(selection, allIds)}
              onChange={(e) =>
                setSelection((sel) =>
                  e.target.checked ? selectAll(sel, allIds) : deselectAll(sel, allIds),
                )
              }
            />
            <span>{tx('词')}</span>
            <span>{tx('音标')}</span>
            <span>{tx('释义')}</span>
            <span>{tx('遇见')}</span>
            <span>{tx('状态')}</span>
            <span>{tx('例句数')}</span>
            <span>{tx('时间')}</span>
          </div>

          {loading ? (
            <div className="empty">{tx('加载中…')}</div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              {rows.length === 0
                ? tx('还没有生词。在网页上划词即可收藏。')
                : tx('没有符合当前筛选条件的词。')}
            </div>
          ) : (
            <>
              <div style={{ height: win.paddingTop }} />
              {win.rows.map((row) => (
                <div
                  className="row"
                  key={row.word.id}
                  onClick={() => setOpenWordId(row.word.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    aria-label={tx('选择 {lemma}', { lemma: row.word.lemma })}
                    checked={selection.has(row.word.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => setSelection((sel) => toggleOne(sel, row.word.id))}
                  />
                  <span className="lemma ellipsis">{row.word.surface}</span>
                  <span className="ph ellipsis">
                    {row.word.phoneticUs ? `/${row.word.phoneticUs}/` : '—'}
                  </span>
                  <span className="ellipsis" title={row.word.defZh.join('；')}>
                    {row.word.defZh.join('；') || (row.word.isUnlisted ? tx('未收录') : '—')}
                  </span>
                  <span>{row.word.meetCount}</span>
                  <span>
                    <span className="badge" data-s={row.word.status}>
                      {statusLabel(row.word.status)}
                    </span>
                  </span>
                  <span>{row.sceneCount}</span>
                  <span className="muted">
                    {new Date(row.word.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
              <div style={{ height: win.paddingBottom }} />
            </>
          )}
          </div>
        </>
      )}

      {openWord && (
        <WordDrawer
          row={openWord}
          onClose={() => setOpenWordId(null)}
          onChanged={() => void reload()}
        />
      )}

      {exportScope && (
        <ExportPanel
          rows={rows}
          filtered={filtered}
          selection={selection}
          initialScope={exportScope}
          onClose={() => setExportScope(null)}
        />
      )}
    </>
  );
}
