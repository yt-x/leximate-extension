# Leximate / 词伴

一个 Chrome/Edge（Manifest V3）的网页阅读生词本：在任意页面选中一个英文单词，立即从内置离线词库拿到中文释义与音标，并把该词与遇见它的那句话一起存到本地 —— 不需要账号、不需要服务器，页面侧不发任何网络请求。

与 MetWord（遇见单词）或其他任何产品均无关联。

发布版本：**0.2.0**。本分支只包含功能源码与面向使用者的文档；内部规格、变更记录与验证证据不在本分支发布。

## 当前状态

M0（不依赖插件代码的存量导出脚本）、M1（划词到生词本的完整链路）与 M2（例句采集、MetWord/JSON 导入、诊断页、备份健康）已实现。词表 3004 条，高频词打成常驻分片、进程内查询。M3 的代码已落地 —— WebDAV 同步（`utils/sync`）与翻译管道（`utils/translate`）—— 尚待在真实 WebDAV 账号与真实翻译服务上验证。

## 开发

需要 **Node 22.18+** 与 pnpm 11+（构建脚本是 TypeScript，靠 Node 原生类型剥离直接执行；该版本起默认开启）。本机开发使用 Node 26，CI 用 Node 22 验证实际下限。

```bash
pnpm install
pnpm dev          # 启动带扩展的 Chrome，支持热重载
pnpm build        # 生产构建，产物在 .output/chrome-mv3
pnpm compile      # 只做类型检查
pnpm test         # 单元测试
pnpm verify       # 三道漂移门禁 + 内容脚本边界门禁
pnpm dict         # 重新生成音标、分片与屈折索引
pnpm dict:pron    # 从钉版的 CMUdict 重新生成音标列
pnpm dict:check   # TSV 或产物与来源不一致就失败
pnpm zip          # 打包成可提交商店的 zip
```

词表的唯一事实源是 [data/core-words.tsv](data/core-words.tsv)。其中 `pos` 与 `defZh` 两列人工撰写，**音标列是生成列** —— 由 `data/pronunciation/` 下钉版的 CMUdict，经本项目自写的 ARPAbet→IPA 映射表算出，因此可离线重算、可审计。`public/dict/` 由 TSV 生成。两者都提交进仓库，CI 用 `pnpm dict:check` 挡漂移。

音标数据来自 CMU Pronouncing Dictionary（BSD-2 等价，明确允许商用），署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。中文释义由本项目自行撰写，不取自任何第三方词典。

手工加载构建产物：打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择 `.output/chrome-mv3`。

## 数据只存在这台机器上

词、例句、设置与词典分片全部在本地（扩展自己的 IndexedDB 与随包文件），没有账号，也没有服务端副本。

**卸载本扩展、或清理它的浏览器数据，会把这些内容一起删除且无法恢复。** 卸载或换机之前，先在「生词」页的工具栏导出一次 JSON 备份。

首次使用的引导里会再提示一遍，设置页也有同样的说明。

## 发布文档

| 主题 | 覆盖什么 | 链接 |
|---|---|---|
| 隐私政策 | 本地数据与可选外发路径 | [PRIVACY.md](PRIVACY.md) |
| 版本历史 | 版本改动与验证证据 | [CHANGELOG.md](CHANGELOG.md) |
| 贡献指南 | 环境、检查与变更流程 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 许可证 | 项目许可证 | [LICENSE](LICENSE) |

英文版见 [README.md](README.md)。
