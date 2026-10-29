# Leximate 隐私政策 / Privacy Policy

更新日期 / Last updated: 2026-10-28

## 中文

### 数据保存在哪里

Leximate（词伴）把生词、例句、设置、导入词典与本地诊断日志保存在本机扩展源的 IndexedDB 中；内置词表保存在扩展包文件中。扩展没有账号体系，没有我们的服务器，没有分析或广告 SDK，也不会远程上报诊断日志。

卸载扩展或清除它的浏览器数据会删除这些本地数据且无法恢复。卸载或换机前，请在管理台导出 JSON 备份。

### 默认网络行为

默认不启用翻译或同步。内容脚本不向外部服务器发网络请求；内置词表只读扩展包资源。单词释义、音标、下划线和生词本管理均可离线使用。

### 用户主动启用的外发路径

1. **LLM 未收录词释义**：只有用户点击「LLM 释义」后，该单词才会发送到用户配置的 OpenAI 兼容服务。API key 只保存在扩展源，不发送给内容脚本。
2. **例句翻译**：只有用户配置并确认外发告知后，被收藏时捕获的那一句才可能发送到用户配置的 LLM 或翻译 API；也可选择浏览器本机 Translator（若可用）。每日上限与降级链按实际请求执行。
3. **WebDAV 同步**：只有用户配置 WebDAV 后，生词、例句与删除墓碑才会同步到用户指定的服务器。可设置口令在上传前加密；明文同步的风险在设置页明示。

WebDAV 用户名、应用密码、同步口令、LLM key 与自定义 API headers 只保存在扩展源，不进入导出 JSON、同步载荷或内容脚本。选择 HTTP 而不是 HTTPS 时，网络传输可能明文暴露，用户需自行确认网络环境。

### MetWord 存量迁移

一次性迁移脚本由用户在自己已登录的浏览器控制台执行，产物保存在用户选择的位置。扩展本体不调用 MetWord 接口、账号或域名。

### 联系与变更

项目无远程数据控制端。隐私政策变更随仓库版本发布；历史版本可从 Git 提交与 Release 记录核对。

## English

Leximate stores words, example sentences, settings, imported dictionaries, and local diagnostics in the extension-origin IndexedDB on this device. The bundled dictionary ships inside the extension package. There is no account system, no Leximate-operated server, no analytics or advertising SDK, and no remote diagnostic reporting.

Uninstalling the extension or clearing its browser data permanently deletes local data. Export a JSON backup before uninstalling or moving devices.

By default, translation and sync are disabled. Content scripts make no external network requests. LLM definitions for unlisted words are sent only after the user clicks “LLM 释义”. Sentence translation requires explicit configuration and acknowledgement; only the captured sentence is sent to the user-configured service, or to the browser's local translator when available. WebDAV sync uploads words, scenes, and tombstones only to the user-selected server, with optional passphrase encryption.

Credentials remain in extension-origin storage and are never included in backups, sync payloads, or content-script messages. HTTP endpoints may expose traffic in plaintext; HTTPS is recommended. The one-time MetWord migration script runs only in the user's own logged-in browser console and does not create any runtime coupling with MetWord.
