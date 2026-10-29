/**
 * 管理台的样式。
 *
 * 用内联 `<style>` 而不是引 CSS 框架：§4.4 要求"词库外代码 < 3MB"，
 * 而管理台只需要一个列表页的样式，引框架的收益远小于成本。
 *
 * 主题跟随系统（PLAN.md OQ10）：用 `prefers-color-scheme`，
 * 不提供手动切换开关。
 */
export const styles = `
:root {
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #656d76;
  --border: #d0d7de;
  --hover: #f6f8fa;
  --accent: #0969da;
  --danger: #cf222e;
  --row-h: 40px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8b949e;
    --border: #30363d;
    --hover: #161b22;
    --accent: #58a6ff;
    --danger: #f85149;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
button, input, select {
  font: inherit;
  color: inherit;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
}
button { cursor: pointer; }
button:hover:not(:disabled) { background: var(--hover); }
button:disabled { opacity: .5; cursor: default; }
input, select { padding: 4px 6px; }

.app { padding: 16px 20px; max-width: 1400px; margin: 0 auto; }
.app h1 { font-size: 1.25rem; margin: 0 0 4px; }

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 12px 0; }
.tabs button {
  border: none; border-bottom: 2px solid transparent; border-radius: 0;
  padding: 8px 14px; background: none; color: var(--muted);
}
.tabs button[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }

.stats { display: flex; gap: 20px; flex-wrap: wrap; margin: 12px 0; }
.stat { min-width: 84px; }
.stat .n { font-size: 1.35rem; font-weight: 600; }
.stat .k { color: var(--muted); font-size: .8rem; }

.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
.toolbar .grow { flex: 1; min-width: 200px; }

.facets { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.facet { display: flex; flex-direction: column; gap: 4px; }
.facet > label { font-size: .78rem; color: var(--muted); }
.facet select[multiple] { min-width: 130px; height: 76px; }

.table-head, .row {
  display: grid;
  /* FR-F2：复选框 / 词 / 音标 / 释义 / 遇见 / 状态 / 例句数 / 时间（来源域名不进列表行） */
  grid-template-columns: 34px 1.4fr 1fr 2fr 64px 84px 64px 110px;
  gap: 8px; align-items: center;
}
.table-head {
  padding: 6px 8px; border-bottom: 1px solid var(--border);
  color: var(--muted); font-size: .8rem; position: sticky; top: 0; background: var(--bg); z-index: 2;
}
.sort-controls { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.sort-controls button { display: inline-flex; gap: 3px; align-items: center; }
.scroller { height: calc(100vh - 300px); min-height: 220px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.row { height: var(--row-h); padding: 0 8px; border-bottom: 1px solid var(--border); }
.row:nth-child(even) { background: var(--hover); }
.row:hover { background: var(--hover); }
.row .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .lemma { font-weight: 600; }
.row .ph { color: var(--muted); }
.row .muted { color: var(--muted); font-size: .82rem; }

.badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: .74rem; border: 1px solid var(--border); }
.badge[data-s="new"] { border-color: var(--accent); color: var(--accent); }
.badge[data-s="known"] { border-color: #1a7f37; color: #1a7f37; }
.badge[data-s="ignored"] { color: var(--muted); }

.empty { padding: 40px; text-align: center; color: var(--muted); }
.error { color: var(--danger); }

/* FR-E7 的二次确认框：视觉上要和普通按钮区分开，别让人顺手点下去 */
.danger {
  border: 1px solid var(--danger); border-radius: 6px; padding: 10px 12px;
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
.danger button { border-color: var(--danger); }

.drawer-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; justify-content: flex-end; z-index: 20;
}
.drawer {
  width: min(520px, 92vw); background: var(--bg); height: 100%; overflow: auto;
  padding: 18px 20px; box-shadow: -4px 0 16px rgba(0,0,0,.2);
}
.drawer h2 { margin: 0 0 2px; font-size: 1.2rem; }
.drawer section { margin-top: 16px; }
.drawer h3 { font-size: .85rem; color: var(--muted); margin: 0 0 6px; text-transform: uppercase; letter-spacing: .03em; }
.drawer ul { margin: 0; padding-left: 18px; }
.scene { border-left: 3px solid var(--border); padding: 4px 0 4px 10px; margin-bottom: 10px; }
.scene .src { font-size: .78rem; color: var(--muted); }
.scene mark { background: color-mix(in srgb, var(--accent) 22%, transparent); color: inherit; }

.settings-grid { display: grid; grid-template-columns: 200px 1fr; gap: 10px 14px; align-items: start; max-width: 720px; }
.settings-grid > label { padding-top: 4px; }
.hint { color: var(--muted); font-size: .8rem; margin-top: 2px; }
.field-error { color: var(--danger); font-size: .8rem; margin-top: 2px; }
textarea { width: 100%; min-height: 88px; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px; }
.saved { color: #1a7f37; font-size: .85rem; }
.confirm-bar {
  display: flex; gap: 10px; align-items: center; padding: 8px 10px;
  border: 1px solid var(--danger); border-radius: 6px; margin: 10px 0;
}

/* FR-L6 的备份提醒：在顶部，不能抢过正文的视觉重量，但要看得见 */
.banner {
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: 8px 12px; margin: 10px 0;
  border: 1px solid var(--accent); border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.banner span { flex: 1; min-width: 240px; }
`;
