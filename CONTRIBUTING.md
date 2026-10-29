# Contributing to Leximate

## 开发环境

- Node 22.18+、pnpm 11+
- Chrome 或 Edge（Manifest V3）
- 不复制 `kidlj/metword.extension` 的代码；不引入 MetWord 接口、账号或域名耦合。

```powershell
pnpm install
pnpm dev
```

## 常用检查

```powershell
pnpm compile
pnpm test
pnpm verify
pnpm build
```

`pnpm verify` 会检查发音、词表、变形产物是否漂移，并验证内容脚本边界。

## 改动规则

1. 本发布分支只包含功能源码与面向使用者的文档；内部规格、变更记录和验证证据不在本分支维护。
2. bug 修复先补能复现的测试并确认失败，再做最小修复；新能力先明确验收行为，再写实现。
3. 内容脚本不得直接访问 Web 存储或发外部网络请求；跨上下文数据通过白名单消息传递，秘密不得进入内容脚本。
4. 词典（`dict`）与生词本（`words`）分表，不把导入词典混进生词本。
5. 不自动新增依赖或修改锁文件；确有需要先说明理由、许可与构建影响。
6. 提交信息使用 Conventional Commits，说明改动、原因和真实验证命令；一次提交一个关注点。

## 提交与发布

发布前必须通过 `pnpm compile`、`pnpm test`、`pnpm verify` 和 `pnpm build`。商店发布还需核对隐私政策、图标/截图素材、权限提示与商标措辞。
