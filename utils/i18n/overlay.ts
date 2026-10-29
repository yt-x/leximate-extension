/**
 * 英文覆盖层：**以中文原文为 key**（`utils/i18n` 的 `tx()` 用它）。
 *
 * 为什么用"中文原文当 key"而不是 `wordlist.stats.total` 这种点号键：
 * - 中文渲染结果**逐字节不变**（`tx('总词数')` 在中文下就返回 `总词数`），
 *   既有的界面用例全部断言中文，因此一条都不用改；
 * - 逐页搬文案时只需维护这一张表，不用同时改组件和两份文案表；
 * - 漏翻的条目会**可见地退回中文**（不白屏），而不是显示 `wordlist.stats.total`。
 *
 * 约定：
 * - key 就是中文原文，**含占位符**（`已选 {count}`）；占位符两侧的花括号与变量名要对齐 `tx()` 的调用；
 * - 只放"用户可见文案"，不放注释与日志；
 * - 英文里不要出现全角标点（`：`→`: `、`（）`→`()`）。
 */
export const EN_OVERLAY: Record<string, string> = {
  // 生词列表：状态与排序
  词: 'Word',
  排序: 'Sort',
  生词: 'New',
  已掌握: 'Known',
  忽略: 'Ignored',
  时间: 'Date',
  遇见: 'Seen',
  词频: 'Frequency',
  字母: 'A–Z',
  例句数: 'Examples',

  // 统计
  总词数: 'Total words',
  今日新增: 'Added today',
  例句总数: 'Example sentences',
  '来源域名 Top {count}': 'Top {count} domains',

  // 搜索与筛选
  '搜索词形（子串匹配，大小写不敏感）': 'Search lemmas (substring, case-insensitive)',
  '全部（有无例句）': 'Any (has examples or not)',
  仅有序例句: 'Has examples',
  仅无例句: 'No examples',
  清除筛选: 'Clear filters',
  '导出…': 'Export…',
  '已选 {count}': ' · {count} selected',
  '状态（可多选）': 'Status (multi)',
  '来源域名（可多选）': 'Source domain (multi)',
  '考试标签（可多选）': 'Exam tag (multi)',
  遇见次数区间: 'Seen count range',
  从: 'From',
  到: 'To',
  遇见次数上限: 'Seen count upper bound',
  '词频区间（BNC 排名）': 'Word frequency range (BNC rank)',
  词频下限: 'Frequency lower bound',
  词频上限: 'Frequency upper bound',
  导入完整词库后可用: 'Available after importing the full dictionary',

  // 词库导入（FR-B7）
  词库: 'Dictionary',
  '内置核心词表覆盖常用词；低频词需要你自己下载 ECDICT 数据文件后导入，数据不进扩展包。':
    'The built-in word list covers common words; for rare words, download the ECDICT data file yourself and import it — no dictionary data ships with the extension.',
  '导入的是查词用的词典，不会把这些词加进生词本。':
    'What you import is a lookup dictionary — it does not add these words to your notebook.',
  '约 62 MB（完整）/ 3.5 MB（标准档）': 'about 62 MB (full) / 3.5 MB (standard)',
  '选择 ecdict.csv 文件': 'Choose an ecdict.csv file',
  导入范围: 'Import scope',
  '标准档（考试词，导入快）': 'Standard (exam words, fast)',
  '完整词库（约 77 万条，需要几分钟）': 'Full dictionary (~770k entries, takes minutes)',
  开始导入: 'Start import',
  '正在导入…已写入 {n} 条': 'Importing… {n} written',
  确认移除: 'Confirm removal',
  '只删导入来的词，内置词表与你的生词本不受影响。确定移除？':
    'Only imported words are removed; the built-in list and your notebook are untouched. Remove?',
  移除导入词库: 'Remove imported dictionary',
  '已导入 {n} 条': '{n} entries imported',
  '将导入 {n} 条': 'Will import {n} entries',
  '跳过 {n} 行（字段数异常）': '{n} rows skipped (wrong field count)',
  '已取消 · 已导入 {n} 条': 'Cancelled · {n} entries imported',
  '已移除 {n} 条导入词': '{n} imported entries removed',

  // 批量操作
  '批量：': 'Batch: ',
  '改为{status}': 'Mark as {status}',
  删除: 'Delete',
  导出选中: 'Export selected',
  取消选择: 'Clear selection',
  确认删除: 'Confirm delete',
  取消: 'Cancel',

  // 表格与空态
  '加载失败：{error}': 'Failed to load: {error}',
  全选: 'Select all',
  '加载中…': 'Loading…',
  '还没有生词。在网页上划词即可收藏。': 'No words yet. Select a word on any page to collect it.',
  '没有符合当前筛选条件的词。': 'No words match the current filters.',
  '选择 {lemma}': 'Select {lemma}',
  未收录: 'Not in dictionary',

  // 诊断页（FR-L4 / FR-L3）
  '日志只含本机事件，可直接贴进 issue。': 'Logs contain local events only; safe to paste into an issue.',
  '诊断': 'Diagnostics',
  '日志只保存在本机，不会上传到任何服务器；导出的是当前筛选后的内容。':
    'Logs stay on this machine and are never uploaded; export includes the current filter only.',
  '日志级别': 'Log level',
  '全部级别': 'All levels',
  '日志来源': 'Log source',
  '全部来源': 'All sources',
  '搜索日志内容': 'Search log messages',
  '刷新': 'Refresh',
  '导出日志': 'Export logs',
  '清空日志': 'Clear logs',
  '确认清空日志': 'Confirm clearing logs',
  '确认清空全部 {total} 条日志？清掉之后就没有排查线索了（建议先导出）。':
    'Clear all {total} log entries? You would lose your only troubleshooting trail (export first).',
  '确认清空': 'Confirm clear',
  '读取日志失败：{error}': 'Failed to read logs: {error}',
  '已导出 {exported}': 'Exported {exported}',
  '还没有日志。': 'No logs yet.',
  '没有符合筛选条件的日志。': 'No logs match the current filters.',
  '来源：install（安装/更新）、background（后台启动）、dict（词库初始化）、content（网页上的动作）、badge（角标失败）。翻译与同步的失败日志随 M3 的相应节点接入。':
    'Scopes: install (install/update), background (service worker start), dict (dictionary init), content (in-page actions), badge (badge failures). Translation and sync failures arrive with their M3 nodes.',

  // 单词抽屉（FR-F7）
  '{surface} 详情': '{surface} details',
  '原形：{lemma}': 'Lemma: {lemma}',
  '关闭': 'Close',
  '音标': 'Phonetics',
  '美 /{ipa}/': 'US /{ipa}/',
  '来源：{src}': 'Source: {src}',
  '未标注': 'unmarked',
  '无音标': 'No phonetic',
  '朗读 {lemma}': 'Pronounce {lemma}',
  '发音': 'Pronounce',
  '释义': 'Definitions',
  '以上为导入时保留的原平台释义': 'Original definitions kept from the import',
  '词库未收录': 'Not in dictionary',
  '暂无释义': 'No definitions',
  ' · 词性：{pos}': ' · POS: {pos}',
  '状态': 'Status',
  '遇见 {count} 次': 'Seen {count}×',
  '例句（{count}）': 'Examples ({count})',
  '还没有例句': 'No examples yet',
  '未知来源': 'Unknown source',
  '原页面': 'Original page',
  '详情': 'details',
  // 导出面板（FR-G1 ~ FR-G9）
  '导出': 'Export',
  '关闭导出面板': 'Close export panel',
  '范围': 'Range',
  '先在列表里勾选要导出的词。': 'Select some words in the list first.',
  '这个范围里没有词。': 'No words in this range.',
  '格式': 'Format',
  '导出格式': 'Export format',
  '列（{n}）': 'Columns ({n})',
  '列 {header}': 'Column {header}',
  '章节名（可选）': 'Chapter name (optional)',
  '章节名': 'Chapter name',
  '例如 考研核心': 'e.g. Core vocabulary',
  '留空则只输出单词表；填了就写成一行 `#章节名`（半角 #）。':
    'Leave empty for a plain word list; if set, one line of `#chapter` (half-width #) is written.',
  '包含例句翻译（OQ8）': 'Include example translations (OQ8)',
  '备份只含词与例句，不含设置与任何凭据。':
    'The backup contains words and example sentences only — no settings, no credentials.',
  '导出失败：{error}': 'Export failed: {error}',
  '已导出 {filename}（{words} 词 / {scenes} 例句）': 'Exported {filename} ({words} words / {scenes} examples)',
  '导出中…': 'Exporting…',
  '导出不会修改或删除任何本地数据（FR-G8）；导出的列结构见 PLAN.md §3.1。':
    'Exporting never modifies or deletes local data (FR-G8); column layout is specified in PLAN.md §3.1.',
  '当前选了 {n} 列。': '{n} column(s) selected.',
  '还没有勾选任何词': 'Nothing selected yet',
  '没有可导出的词': 'No words to export',
  '至少要勾选一列': 'Pick at least one column',

  // 导出格式的标签（来自 utils/export/formats.ts，渲染时经 tx() 取）
  'Anki（TSV，含例句与释义）': 'Anki (TSV, with examples and definitions)',
  '通用 CSV（含例句与释义，列可勾选）': 'Generic CSV (with examples and definitions, pick columns)',
  '不背单词（TXT，纯单词表）': 'bbdc.cn (TXT, word list only)',
  '墨墨背单词（TXT，纯单词表 / 可选章节）': 'Maimemo (TXT, word list / optional chapter)',
  'JSON 备份（全量，可回灌）': 'JSON backup (everything, re-importable)',
  '带 BOM 的 UTF-8，Excel 直接双击打开不乱码；也可被其它工具当标准 CSV 读。':
    'UTF-8 with BOM: opens cleanly in Excel by double-click, and readable as standard CSV by other tools.',
  '原始数据备份，供换机与回灌使用；不含任何凭据。':
    'Raw data backup for moving machines or restoring; contains no credentials.',

  // 导入区（FR-J4 ~ FR-J7）
  '导入': 'Import',
  '选择导入文件': 'Choose import file',
  '支持 MetWord 导出脚本产出的 JSON（存量迁移）与本项目导出的 JSON 备份（换机）。':
    'Accepts the JSON produced by the MetWord export script (migration) and this project\'s JSON backup (moving machines).',
  '导入是合并：不覆盖已有的释义与音标，重复导入同一份文件不会产生重复数据。':
    'Import merges: existing definitions and phonetics are kept, and importing the same file twice creates no duplicates.',
  '处理中…': 'Working…',
  '导入失败：{error}': 'Import failed: {error}',
  '确认导入': 'Confirm import',
  '将导入 {words} 词 / {scenes} 例句，其中 {unlisted} 词词库未收录。':
    'Will import {words} words / {scenes} example sentences; {unlisted} word(s) are not in the dictionary.',
  '文件：{name} · 新增 {added} 词、合并 {merged} 词；新增 {scenes} 条例句，已存在 {dup} 条（不会重复写入）。':
    'File: {name} · {added} new, {merged} merged; {scenes} new example sentences, {dup} already present (not written twice).',
  '例如：{samples}': 'e.g. {samples}',
  '跳过 {n} 条坏词记录；': 'skipped {n} malformed word rows; ',
  '跳过 {n} 条坏例句；': 'skipped {n} malformed example rows; ',
  '{n} 条时间无法解析，按导入时间处理。': '{n} timestamps could not be parsed; import time was used.',
  '导入中…': 'Importing…',
  '已导入 {words} 词 / {scenes} 条例句（文件里共 {file} 条，其余已存在）。':
    'Imported {words} words / {scenes} example sentences ({file} in the file, the rest already present).',
  '{n} 词词库未收录，原平台释义已作为兜底保留。':
    '{n} word(s) are not in the dictionary; the original definitions were kept as fallback.',
  '{n} 词的状态按导入值更新。': '{n} status value(s) updated from the file.',
  '{n} 词的遇见次数取了两者较大值。': '{n} word(s) took the larger seen-count.',
  '选一个文件后会先显示预演结果，确认后才写库。':
    'Pick a file to see a dry run first; nothing is written until you confirm.',

  // 设置页（FR-F9）
  '设置': 'Settings',
  '全局开关': 'Global switch',
  '关闭后不注入、不标注，角标显示 OFF': 'When off: no injection, no highlighting, badge shows OFF',
  '下划线样式': 'Underline style',
  '点线': 'Dotted',
  '实线': 'Solid',
  '波浪': 'Wavy',
  '无下划线': 'None',
  '样式类改动需重载页面生效（CSS 在注入时注册）':
    'Style changes take effect after reloading the page (CSS is registered on injection)',
  '下划线颜色': 'Underline color',
  '线宽（px）': 'Thickness (px)',
  '按遇见次数变化': 'Vary by seen count',
  '遇见越多，线条越粗（分 5 档）': 'The more often seen, the thicker the line (5 steps)',
  '最短词长': 'Minimum word length',
  '短于该长度的选中词不处理': 'Selections shorter than this are ignored',
  '选中即入库': 'Add to notebook on select',
  '界面语言': 'Interface language',
  '跟随浏览器': 'Follow browser',
  '中文': '中文',
  '只影响管理台界面；划词弹窗不随此项变化。保存后生效。':
    'Affects the manager UI only; the in-page popup does not change. Applies after saving.',
  '发音语速': 'Speech rate',
  '站点黑名单': 'Site blocklist',
  '这些域名下不注入、不标注。填裸域名，不要带 https:// 或路径':
    'No injection or highlighting on these domains. Use bare domains, without https:// or a path',
  '翻译引擎': 'Translation engine',
  '浏览器内置（无需配置）': 'Browser built-in (no setup)',
  'LLM（需填接口与 Key）': 'LLM (endpoint + key required)',
  '自建接口': 'Custom API',
  '接口地址，如 https://api.example.com/v1': 'Endpoint, e.g. https://api.example.com/v1',
  '模型名（可选）': 'Model name (optional)',
  '自建接口地址': 'Custom API endpoint',
  '目标语言': 'Target language',
  '保存设置': 'Save settings',
  '已保存': 'Saved',
  '数据': 'Data',
  '清空所有数据': 'Clear all data',
  '确认清空所有数据': 'Confirm clearing all data',
  '设置会保留': 'Settings are kept',
  '体积自检': 'Storage check',
  '浏览器没有提供配额信息，因此占用大小未知（不代表数据小）。':
    'The browser exposes no quota information, so the size is unknown (which does not mean it is small).',
  '尚未启用的设置': 'Settings not enabled yet',
  '触发方式': 'Trigger mode',
  '主题 / 每页条数': 'Theme / rows per page',
  '划词的入库口径': 'How selections get collected',
  // 设置页：整段说明（跨行合并后的整句）
  '默认关闭：划词只弹卡片，由你点「加入生词本」才收藏。打开后划词即入库（会被频繁的误选触发，因此不推荐）':
    'Off by default: a selection only shows a card; click "Add to notebook" to keep it. When on, every selection is collected (easy to trigger by accident, so not recommended)',
  '（FR-I2）；机器上没有可用的本地英文语音时不显示发音按钮（FR-I3）':
    '(FR-I2); the pronounce button is hidden when no local English voice is available (FR-I3)',
  'Chrome 内置翻译仅在部分版本可用；不可用时自动降级（§4.5 的三级兜底）':
    "Chrome's built-in translation is available in some versions only; when unavailable it falls back automatically (§4.5 three-level chain)",
  '已清空。设置保留；角标也已同步。':
    'Cleared. Settings are kept and the badge is in sync.',
  '清空的是词条、例句、翻译缓存、待翻译队列与本地诊断日志；设置与词库不变。':
    'Clears words, example sentences, the translation cache, the pending-translation queue and local diagnostic logs; settings and the dictionary stay untouched.',
  '上次导出：': 'Last export: ',
  '卸载本扩展或清理浏览器数据，会连同本地生词与例句一起清除；扩展不保留云端副本，删除后无法恢复。建议定期导出 JSON 备份。':
    'Uninstalling this extension or clearing its browser data deletes your words and example sentences; there is no server-side copy and it cannot be recovered. Export a JSON backup regularly.',
  '建议先导出一次备份：数据只在本机，卸载或清理浏览器数据都会丢掉。':
    'Export a backup first: data lives only on this machine, and uninstalling or clearing browser data loses it.',
  '导出（Anki TSV / 通用 CSV / 不背单词 / 墨墨背单词 / JSON 备份）在「生词」页的工具栏里。':
    'Export (Anki TSV / generic CSV / bbdc.cn / Maimemo / JSON backup) lives in the Words page toolbar.',
  'WebDAV 同步（M3）、词库管理（M1-9）尚未实现，因此这里不提供入口，也不放不可用的假开关。':
    'WebDAV sync (M3) and dictionary management (M1-9) are not implemented, so there is no entry here and no non-functional switch.',
  // 设置页：剩余提示与按钮
  '读取设置失败：{error}': 'Failed to read settings: {error}',
  '{min} ~ {max}，1 为正常语速。改完下一次发音即生效，不需要重载页面':
    '{min} ~ {max}; 1 is normal speed. The next pronunciation uses it immediately, no reload needed',
  '每行一个域名后缀，例如：\\nexample.com\\nmail.google.com':
    'One domain suffix per line, e.g.:\\nexample.com\\nmail.google.com',
  '有 {n} 项需要修正': '{n} field(s) need fixing',
  '确认清空？将删除 {words} 个词、{scenes} 条例句。':
    'Clear everything? This deletes {words} words and {scenes} example sentences.',
  '确认清空？正在统计将要删除的条数…': 'Clear everything? Counting rows to delete…',
  '清空中…': 'Clearing…',
  '清空失败：{error}': 'Clearing failed: {error}',
  '占用 {size}': 'Using {size}',
  '/ 配额 {size}': '/ quota {size}',
  '；词 ': '; words ',
  '{words} 条 / 例句 {scenes} 条': '{words} / {scenes} example sentences',
  '（已受持久化保护）': '(persistently stored)',
  '从未导出': 'never exported',
  '占用已超过阈值（{reason}），': 'Storage is over the threshold ({reason}),',
  '接近浏览器给的配额': 'close to the browser quota',
  '数据量较大': 'large data set',
  // 设置页：最后四段（整段参数化）
  '触发方式（划词 / 点击单词 / 两者都要）：目前只提供「划词」触发（FR-A1）。按 decisions/0026 的澄清，「点击单词查词」就是划词查词，不构成独立能力；字段留在数据模型里，界面不提供切换入口。':
    'Trigger mode (selection / click / both): only selection is supported today (FR-A1). Per decisions/0026, "click a word" is the same thing as selecting it, so it is not a separate capability; the field stays in the data model and the UI offers no switch.',
  '主题 / 每页条数：这两个字段没有消费者——主题不在 FR 表里，列表是虚拟滚动、不分页，所以「每页条数」没有意义。因此不提供入口；要启用先让它们真的被读。界面语言已经有消费者（App.tsx 经 utils/i18n 取文案），入口就在上方。':
    'Theme / rows per page: neither has a consumer — theme is not in the FR table, and the list is virtualized (no paging), so "rows per page" is meaningless. No entry is offered; make them actually read before enabling. Interface language already has a consumer (App.tsx via utils/i18n) and its control is above.',
  '划词的入库口径：默认不自动入库（见上方「选中即入库」）——划词只弹卡片，点「加入生词本」才收藏；且只有完整覆盖整个词的选区才会弹卡片（在 proof 里只拖到 proo 不算选中一个词）。遇见次数只在已收藏的词被再次划到时 +1，因此误选不会污染生词本。':
    'How selections get collected: nothing is collected automatically by default (see "Add to notebook on select" above) — a selection only shows a card, and you click "Add to notebook" to keep it. Only a selection that fully covers a word shows the card (dragging over part of proof does not count). The seen count only increases for words already in your notebook, so accidental selections never pollute it.',
  '状态说明：{statuses}。被「忽略」的词不再采集例句（PLAN.md OQ14）。':
    'Statuses: {statuses}. Words marked "ignored" stop collecting example sentences (PLAN.md OQ14).',


  // 备份提醒（FR-L6）与"文案产出模块"
  '未知': 'unknown',
  '还没有导出过备份：数据只在本机，卸载扩展或清理浏览器数据都会丢掉。到「生词」页点「导出…」备份一次。':
    'No backup exported yet: data lives only on this machine, and uninstalling or clearing browser data loses it. Export once from the Words page toolbar.',
  '距上次导出已 {days} 天，这期间数据有变化。再导出一次，换机或重装时才不会丢。':
    'Last export was {days} days ago and data has changed since. Export again so a new machine or reinstall loses nothing.',
  '颜色需为 #rgb 或 #rrggbb 形式': 'Color must be #rgb or #rrggbb',
  '下划线样式取值非法': 'Invalid underline style',
  '触发方式取值非法': 'Invalid trigger mode',
  '翻译引擎取值非法': 'Invalid translation engine',
  '界面语言取值非法': 'Invalid interface language',
  '主题取值非法': 'Invalid theme',
  '以下条目不合法（应为域名后缀，如 example.com）：{list}':
    'Invalid entries (expected domain suffixes such as example.com): {list}',
  '启用 LLM 翻译时必须填写接口地址': 'An endpoint is required when LLM translation is enabled',
  '接口地址需为 http(s) URL': 'Endpoint must be an http(s) URL',
  '启用 LLM 翻译时必须填写 API Key': 'An API key is required when LLM translation is enabled',
  '启用自建接口时必须填写合法的 http(s) 地址': 'A valid http(s) URL is required for a custom API',
  '目标语言不能为空': 'Target language cannot be empty',
  '调试': 'Debug',
  '信息': 'Info',
  '警告': 'Warn',
  '错误': 'Error',
  '浏览器没有接受这次下载': 'The browser did not accept this download',
  '全部生词': 'All words',
  '当前筛选结果': 'Current filter',
  '选中项': 'Selected',
  '线宽需在 {min} ~ {max} 之间': 'Thickness must be between {min} and {max}',
  '最短词长需为 {min} ~ {max} 的整数': 'Minimum word length must be an integer between {min} and {max}',
  '每页条数需为 {min} ~ {max} 的整数': 'Rows per page must be an integer between {min} and {max}',
  '发音语速需在 {min} ~ {max} 之间': 'Speech rate must be between {min} and {max}',  '文件是空的': 'The file is empty',
  '这不是一个合法的 JSON 文件': 'This is not valid JSON',
  '认不出这个文件的格式：需要 MetWord 导出（meta + words）或本项目的 JSON 备份（app: leximate）':
    'Unrecognised file format: expected a MetWord export (meta + words) or this project\'s JSON backup (app: leximate)',
  '文件里没有可导入的词条': 'The file contains no importable words',
  // 管理台外壳：备份提醒横幅（FR-L6）
  '备份提醒': 'Backup reminder',
  '去「生词」页': 'Go to Words',
  '知道了': 'Got it',

  // 翻译成本控制（FR-D5）
  '翻译批量与上限': 'Translation batch and limits',
  '单批条数': 'Batch size',
  '并发数': 'Concurrency',
  '每日上限': 'Daily cap',
  '超过每日上限时排队等待，不会丢；填 0 表示暂停翻译。':
    'Over the daily cap the queue waits instead of dropping work; 0 pauses translation.',
  '{label}需为 {min} ~ {max} 的整数': '{label} must be an integer between {min} and {max}',
  // 翻译待办与告知（FR-D6 / FR-D7）
  '句子翻译': 'Sentence translation',
  '翻译隐私告知': 'Translation privacy notice',
  '开启翻译后，只有你划选的那一句会离开浏览器，发给你配置的翻译服务；词的释义、例句与凭据都不会上传。未开启时不会发出任何请求。':
    'Once enabled, only the sentence you selected leaves the browser, sent to the translation service you configured; definitions, other examples and credentials are never uploaded. Nothing is sent while it is off.',
  '我知道了，开启翻译': 'Got it, enable translation',
  '待翻译 {n} 条。': '{n} sentence(s) waiting to be translated.',
  '没有待翻译的句子。': 'Nothing waiting to be translated.',
  '其中 {n} 条已连续失败 {max} 次，已停止自动重试。':
    'Of those, {n} failed {max} times in a row and stopped retrying automatically.',
  '全部重试': 'Retry all',  // 同步（FR-H1 / FR-H6）
  'WebDAV 服务器': 'WebDAV server',
  '如 https://dav.jianguoyun.com/dav/': 'e.g. https://dav.jianguoyun.com/dav/',
  '用户名': 'Username',
  '应用密码（不是登录密码）': 'App password (not your login password)',
  '远端路径，如 /leximate/sync.json': 'Remote path, e.g. /leximate/sync.json',
  '凭据只存在本机，不进导出文件、也不随同步文件上传。坚果云需在「安全选项」里生成应用密码。':
    'Credentials stay on this machine: never exported, never uploaded with the sync file. On Jianguoyun, generate an app password under Security options.',
  '同步状态': 'Sync status',
  '正在读取同步状态…': 'Reading sync status…',
  '还没有成功同步过。': 'No successful sync yet.',
  '上次成功同步：{time}': 'Last successful sync: {time}',
  '立即同步': 'Sync now',
  '同步中…': 'Syncing…',
  '同步完成。': 'Sync complete.',
  '同步失败：{error}': 'Sync failed: {error}',
  '同步未完成': 'Sync did not complete',
  // 同步口令（FR-H5）
  '同步口令（可选，填了就加密远端）': 'Sync passphrase (optional; fills in to encrypt the remote file)',
  '未填同步口令：远端文件是明文，任何能访问这个 WebDAV 的人都能读到你的生词与例句。口令只存在本机，忘掉就无法解密已上传的内容。':
    'No sync passphrase: the remote file is plain text, so anyone with access to this WebDAV can read your words and examples. The passphrase stays on this machine; if you forget it, uploaded content cannot be decrypted.',
};
