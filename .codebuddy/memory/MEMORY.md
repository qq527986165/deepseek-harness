# 长期记忆

## 仓库协作关系
- 本地仓库 `e:/work/ProjectSet/deepseek-harness` 是 deepseek-harness 的 fork。
- `origin` = `https://github.com/qq527986165/deepseek-harness.git`（个人 fork）；`upstream` = `https://github.com/deepseek-ai/deepseek-harness.git`（官方）。
- 同步上游：`git fetch upstream` 后 `git merge upstream/master`（ort 策略，已基本无冲突）。本地 master 仅保留少量 Win32 选择器/文档类自有提交，其余追随上游。
- 部署分支 `memory-plugin`（本地自定义记忆插件开发）。
- 上游 rc.8（2026-08-19, 提交 141eb6f）包含：多模态（原生图片、/goal /plan 图文、@引用）、子代理按需安装、Windows 持久 PowerShell PTY、SQLite 持久化布局优化（格式不兼容）、品牌文案/构建产物校验等。

## 分支拓扑（2026-08-21）
- `memory-plugin` 从较老 master 点分叉：领先 master 11 个自有提交（`packages/memory/*` 整套 memory 包 + PRD/笔记/覆盖率 HTML），master 领先它 537 个（rc.8 全部上游提交）。
- 远端无 `memory-plugin`（仅本地）。
- 已知合并冲突高风险区：memory-plugin 改过 `tsconfig.base.json`/`tsconfig.client.json`/`tsconfig.host.json`、`pnpm-lock.yaml`、`scripts/{gen-cordis-catalog,gen-doc-graphs,gen-tool-catalog,verify-package-readme-model-experience}.ts`，这些上游 rc.8 也改过。
