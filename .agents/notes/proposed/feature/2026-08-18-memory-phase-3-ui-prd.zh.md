# Agent Note：记忆 Phase 3 UI —— PRD 与决策记录

Status: proposed

[English](2026-08-18-memory-phase-3-ui-prd.md) | 中文

## Problem

Phase 2 已交付自动机制——会话开始注入、带作用域分类的每回合蒸馏、日记追加、`memory/inject` 与 `memory/distill` 会话事件，以及引导 section——但用户只能通过 Obsidian、`memory_read`/`memory_search` 工具结果与会话日志看到记忆。提案把 Phase 3 留作第一个用户可见界面，其设计讨论需要一份活记录：冻结范围、待敲定的开放问题、逐条落定的决策，以便所有开放问题拍板、实施计划获确认后才开始开发。每轮讨论把结论追加进决策日志，并重录双语 pair。设计真源是[第一方记忆提案](2026-08-18-first-party-pluggable-memory.md)（`Automatic memory lifecycle`、`Phasing`、`Acceptance criteria`）；已交付的 Phase 2 基线见[自动生命周期笔记](../../implemented/feature/2026-08-18-memory-phase-2-automatic-lifecycle.md)。

## Proposal

来自提案的 Phasing 与原始窗口指令，Phase 3 窗口恰好拥有五个界面：

1. **管理面板**（双 scope）——列出、读取、编辑全局与项目笔记。
2. **`/memory review`** 升级流程——模型提议项目→全局升级，用户确认。
3. **`memory_delete`** 与生命周期策略——审核、TTL 与链接修复。
4. **会话节点**展示蒸馏写入。
5. **设置页**（settings page），即记忆机制的用户配置面。

未经用户明确要求，不加入任何其他内容。下面的开放问题是讨论议程；每敲定一项就移入决策日志。

### A. 面板形态与入口

- 入口：侧边栏 slot、命令栏入口、工作区面板，还是独立路由页？
- 布局：带 scope tab 的单面板，还是与对话并排的两栏？
- 列表：按 scope、标签或更新时间排序/分组；搜索框接 `memory_search`？
- 笔记视图：渲染后的 MarkdownText 加编辑模式；点击 `[[wikilink]]` 的行为（面板内跳转、高亮 backlinks）？

### B. UI 风格与文案

- 中文产品文案、`--dsw-*` tokens、CSS Modules、不用 Tailwind——仓库 client 规则原样适用。
- 视觉语言跟随 `ui-workspace`/`ui-settings`；确定卡片/列表密度与哪些 frontmatter 事实做徽标（scope、标签、更新时间）。

### C. 会话节点

- 在 `memory/distill` 事件族上做 `ConversationNodeDefinition`（match/update/state 纪律，不扫全量日志）。
- 呈现：每条已写笔记一个 chip，点击在面板中打开该笔记；日记条目的链接。
- 范围：仅 chat 视图，还是 trajectory 表也要？

### D. 命令

- `/memory review` 走 `ctx.commands`；确认界面长什么样（候选卡片 → 确认/拒绝），结果落到哪里（面板、对话，或两者）？
- 命令参数（scope 过滤、候选数）？

### E. 浏览器的远端服务面

- 面板是浏览器代码：list/read/write/delete 需要覆盖 `ctx.memory` 的新 Typert Remote 服务；`message-feedback` 的 `@Remote` 一元约定是模板。
- 暴露哪些方法，面板变更如何授权——面板操作与会话无关，审批流不得要求一个活跃的 agent 回合。

### F. 删除与生命周期

- `memory_delete` 参数（ref？）与语义：物理删除文件还是软删除/回收。
- 生命周期策略：TTL 默认值、审核触发条件、删除后悬挂 `[[wikilinks]]` 的修复（悬挂标记已存在）。
- 模型删除的授权：静默还是用户确认。

### G. 设置与权限

- Settings-card 字段：`distill` 开关、`minTurnChars`、`maxDistillTokens`、`distillTimeoutMs`、`maxInjectBytes`、`recentNoteCount`，以及只读的 vault 目录展示。
- 面板编辑与全局 vault 写入是否需要权限 preset；按 scope 的可见性规则。

### H. 组合与默认值

- 新的 `ui-memory` client 包加入 web-app bundle：默认可见还是显式启用？
- 未挂载记忆提供方时的退化表现。

### I. 验证

- 面板投影、review 流程与删除的 keyless 快照。
- 逐文件 100% 覆盖率（client 包在门禁内）、`test:gui`，以及可见变更的 web 快照对。

## Decisions log

| # | 日期 | 议题 | 决策 | 依据 |
|---|---|---|---|---|
| — | — | — | （空——由讨论窗口填写） | — |

## Alternatives considered

- **用 dsh 内通用文件查看器代替专用记忆面板。** 否决作为唯一界面：面板必须知道 scope 归属、笔记身份与后续的升级/删除流程，通用查看器表达不了。通用查看器仍是独立的插件决策，不是 Phase 3 的依赖；面板的读取/编辑视图可以复用共享的 markdown 原语。
- **只用 Obsidian，不做 GUI 界面。** 否决：被静默蒸馏的内容的可见性与 `/memory review` 升级流程是提案面向用户的承诺；没有面板，它们在 vault 文件夹之外就不可见。
- **只经 cordis.yml 配置，不做 settings card。** 否决：部署级配置已存在，但窗口指令保留了设置页；settings card 是仓库标准的做法，让用户不必编辑 patch 文件就能拿到同样的旋钮。

## Acceptance criteria

- 面板列出双 scope、打开笔记，编辑经提供方 watcher 对账后持久化。
- `/memory review` 展示候选，用户确认后把笔记升级到全局 vault。
- `memory_delete` 连同索引与链接清理一起删除笔记。
- 会话节点仅凭 `memory/distill` 事件即可重建。
- 设置卡片改变部署级配置字段。
- 仓库门禁通过：逐文件覆盖率、keyless 快照、双语文档。

## Risks

- **远端服务面扩大。** 向浏览器暴露记忆 list/write/delete 是面板最大的新攻击面；会话无关变更的授权设计是最危险的一块，应最先敲定。
- **删除不可逆。** 物理删除没有回收站，粗心的 TTL 可能毁掉用户编辑过的笔记；软删除或 review-first 默认值可以限定损害。
- **并发编辑。** 面板、Obsidian 与蒸馏可能写同一条笔记；提供方在文件层面保证最后写入者胜出，因此面板必须在保存前重读并展示更新时间，避免覆盖。
- **模型侧的删除权力。** 静默的 `memory_delete` 可能删掉用户编辑过的笔记；授权模型决定删除是否需要用户确认。

## Out of scope

- 语义检索（Phase 4）。
- dsh 内通用文件查看器（独立的插件决策，不是 Phase 3 阻塞项）。
- 开源/抽离插件（插件完整后再议）。
