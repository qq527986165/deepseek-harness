# Agent Note: 第一方可插拔记忆系统

Status: proposed

[English](2026-08-18-first-party-pluggable-memory.md) | 中文

## Problem

DSH 没有交付任何第一方记忆系统。[扩展手册](../../../../docs/cookbook/extension-cookbook.md)预留了形态——系统提示词 section 提供方加面向模型的工具——但没有包填充这一行。今天的跨会话召回要么是 opt-in 的 [`tool-session-query`](../../../../packages/session-query/tool-session-query/README.md) 对历史会话做全文检索（只读、受 cwd 权限作用域约束、默认不挂载），要么是[第三方记忆 MCP overlay](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md)之一。两者都留下同一个缺口：记忆应当围绕会话被 DSH 自动加载和自动写入，活在运行时可观测性之内（落日志、可回放、可投影），复用 DSH 的压缩做蒸馏，并且存储是人用日常工具就能阅读和编辑的。

## Proposal

新增第一方、默认关闭的记忆能力，作为三角色的[能力 seam](../../../../docs/architecture.md#capability-seams)放在新的 `packages/memory/` 组下：`memory`（Service Definition）、`memory-local`（提供方：两个 Obsidian 兼容的 markdown vault——一个全局、一个每项目——外加每个 vault 一个提供方自有的 SQLite 索引）、`tool-memory`（消费方：模型工具）。检索基于文件的全文检索加链接遍历；不含 embedding。这个 seam 支撑的产品行为：

- **自动加载。** 会话开始时，提供方把全局与项目人设笔记加一个近期窗口的项目笔记注入首次请求。
- **自动写入。** 每回合结束后，一次辅助蒸馏调用把该回合总结成主题笔记并静默写入；同一调用内的分类器把个人事实与偏好路由到全局 vault，把项目事实留在项目 vault。
- **管理。** UI 面板列出、编辑并在后续阶段删除两个作用域的笔记；`/memory review` 命令浮现可升级为全局的候选。

存储模型沿用 Claude Code、OpenClaw 和腾讯 WorkBuddy 验证过的文件优先记忆系统：人类可读的 markdown 加 frontmatter 与 `[[wikilinks]]`，可在 Obsidian 中编辑、可在 git 中做 diff。

## Vault 布局与笔记格式

两个对称的 vault。全局 vault 位于 `$DSH_HOME/memory/`；项目 vault 位于 `<project>/.dsh/memory/`。产品根目录加子目录的形态沿用 `.claude/`（Claude Code）与 `.codebuddy/`（WorkBuddy）；一个提供方实现同时服务两个作用域，未来的项目级 DSH 状态在 `memory/` 旁边也有归处。

文件夹名属于能力，不属于插件：插件身份已经在 npm 包名（`@deepseek-ai/dsh-memory-local`）里，而 vault 路径是必须跨提供方替换存活下来的用户数据。唯一提供方注册已经阻止两个记忆系统在同一宿主挂载，全局 `dir` 配置字段则是部署确实需要另一位置时的覆盖口。

```text
$DSH_HOME/memory/          # global scope; project scope: <project>/.dsh/memory/
  MEMORY.md                # persona note: identity, preferences, standing rules
  notes/<title-slug>.md    # one topic note per distilled memory unit
  journal/2026-08-18.md    # one daily narrative per active day, linked to topic notes
  .memory-index.sqlite     # provider-owned derived state; delete-safe
```

`MEMORY.md` 是一篇普通笔记，提供方把它当作该作用域的人设笔记；会话开始注入时在字节上限内整篇读取。

每篇笔记是一个 Obsidian 兼容的 markdown 文件：

```markdown
---
id: 9f3c1c2e-…
scope: project
created: 2026-08-18T10:00:00.000Z
updated: 2026-08-18T10:00:00.000Z
tags: [deepseek, memory]
related:
  - "[[session-query]]"
---

Body text. Facts are stated plainly and may contain [[wikilinks]].
```

日记文件是普通的带日期 markdown：

```markdown
---
type: journal
date: 2026-08-18
---

## Fork sync to upstream
- Merged upstream/master and fixed the node version mismatch.
- Touched facts: [[fork-sync-upstream]]
```

记忆保持两个轴。主题笔记承载蒸馏出的事实——身份、偏好、决策——每一个都是稳定的召回单元。日记承载时间叙事：每个活跃日一个文件，每回合追加一小段链接到所触及主题笔记的任务摘要。事实只活在主题笔记里，因此日记条目只指向而不复述；日记是人类可读的变更日志，也是链接图的时间轴。提供方递归索引 vault 根下的 markdown 文件，因此 `notes/` 与 `journal/` 子目录是约定而非格式规则，把 `dir` 指向一个已存在的 markdown 文件夹即收养其中文件为记忆。主题笔记文件名在创建时由标题派生并且稳定不变；带链接修复的重命名推迟。提供方在自身主题笔记写入时负责 `id`/`created`/`updated`；外部编辑按文件状态更新索引，提供方不重写该文件。wikilink 允许悬空，遍历时标记为未解析。插件绝不触碰 git 配置：提交项目 vault 是文档化的团队记忆共享方式，忽略它则保持记忆私有。

## 作用域解析

会话的作用域从它的 `cwd` 解析：`cwd` 的规范路径匹配已注册 [`ctx.workspaceRegistry`](../../../../packages/workspace/workspace/README.md) 中的 workspace 时，该会话获得那个项目的 vault；没有 `cwd` 或 workspace 的会话只有全局 vault。读取与搜索沿链项目 → 全局行走，项目命中排在前面；链接保持作用域内。全局 vault 永远是第二作用域，因此只有全局的会话仍能搜索自己的记忆。宿主层面配置不同 `dir` 的多个实例继续作为相互独立的安装工作。

## Service 接口

`memory` 声明 `ctx.memory`，带 branded 的 `MemoryNoteId` 和一个以 `ctx.sessionTitle.register()` 为模板的唯一提供方注册（[session-title](../../../../packages/session/session-title/README.md)）：提供方挂载该 service 并注册自己的实现；第二次注册失败；dispose 提供方会中止其在途操作。没有注册提供方时，工具加载显式失败。

| 方法 | 契约 |
|---|---|
| `write(input, signal?)` | 按 `id` 在显式 `scope`（`project` 或 `global`）里创建或替换一篇笔记；project 作用域要求已解析出项目 vault。在一个事务里写入 markdown 文件与索引；返回 `{ id, scope, title, path, created, updated }`。 |
| `read(ref, signal?)` | 按 `id` 或精确标题在会话的作用域链上解析笔记；返回 frontmatter、正文与两个方向的链接。 |
| `search(query, opts?, signal?)` | 对标题、tags 与正文做 FTS5 检索，横跨作用域链，项目命中排前；每命中带片段与 tags；条数上限由提供方配置决定，模型不得向上突破。 |
| `traverse(ref, opts?, signal?)` | 从一篇笔记出发，沿 `wikilink` 与 `related` 链接走一到两跳，双向，限于该笔记的作用域内；节点数有上限；悬空链接如实上报。 |

Phase 1 不新增任何 `SessionEventMap` 成员：工具调用与结果本就落日志。Phase 2 新增 `memory/*` 事件，使每次蒸馏写入与注入的上下文都能从日志重建。

## 面向模型的工具

`tool-memory` 通过 `defineTool`（[工具编写参考](../../../../docs/cookbook/adding-a-tool.md)）注册四个工具：`memory_write`、`memory_read`、`memory_search` 与 `memory_traverse`。

| 工具 | 参数 | 规范化输出 |
|---|---|---|
| `memory_write` | `id?`、`scope?`（默认 `project`，无项目 vault 时为 `global`）、`title`、`content`、`tags?`、`related?`（wikilink 目标） | `{ id, scope, title, path, created, updated }` |
| `memory_read` | `ref`（id 或精确标题） | `{ note: { id, scope, title, tags, body, related, backlinks } }` |
| `memory_search` | `query`、`limit?`（上限由配置封顶） | `{ hits: [{ id, scope, title, snippet, tags }] }` |
| `memory_traverse` | `ref`、`depth?`（`1` 或 `2`，默认 `1`）、`kinds?`（`wikilink`/`related`，默认两者） | `{ start: { id, title }, nodes: [{ id, title, via }] }` |

Phase 1 刻意没有 `memory_delete`：删除是生命周期决策（审核、TTL、链接修复），与生命周期策略一起在 Phase 3 到来。Phase 1 唯一面向模型的接口就是这四个 schema 与描述——还没有系统提示词 section。

## 自动记忆生命周期

自动加载与自动写入是 Phase 2 的行为，这里先描述以现在定死设计：

- **会话开始。** `agent/session-start` 上的监听器读取全局与项目的 `MEMORY.md` 加一个可配置的项目主题笔记近期窗口（标题与正文，受字节上限约束），交给 `agent.inject()`，于是首次请求把它们看作持久的注入上下文——作为普通注入的用户内容落日志，满足模型可见即落日志。已加载笔记被 watcher 观察到变更时以同样方式注入（AGENTS.md 子目录变更模式）。日记不进入注入集合；召回通过搜索到达它。
- **每回合蒸馏。** `turn/end` 上的监听器对刚结束的回合发起一次非阻塞的辅助 LLM 调用（压缩 summarizer 的架构：重放前缀加缓存友好的尾部指令）。调用产出候选主题笔记——事实、决策、偏好——并在同一轮里把每条分类为 `project` 或 `global`：个人身份、偏好与跨项目规则归全局；项目事实留项目。同一调用还产出一条日记条目——一段链接到所触及主题笔记的简短任务叙事——经提供方的独占写链追加到当天的日记文件，并发会话因此串行追加而不是损坏文件。候选随后经 service 静默写入，对已有笔记执行合并而不重复陈述规则。`memory/distill` 会话事件记录写了什么，使日志能重建每一次记忆变更。
- **成本与噪声控制。** 蒸馏可配置开关（开/关、参与蒸馏的最小回合长度、每回合 token 上限）；辅助调用默认每回合一次。
- **全局卫生。** `/memory review`（Phase 3）列出模型建议升级为全局的项目笔记，供用户确认；用户明确要求记住某事永远压过分类器。
- **引导 section。** Phase 2 加一个简短的 `ctx.systemPrompt.section()`，告诉模型何时查阅、何时显式写入记忆。

## 索引与外部编辑对账

`memory-local` 为每个 vault 在 `.memory-index.sqlite` 处拥有一个 SQLite 索引：

- `notes(id, path, title, created, updated)` —— 每篇笔记一行。
- `links(from_id, to_id, kind)`，`kind IN ('wikilink','related')` —— 两个方向均可查询。
- `notes_fts`（FTS5）覆盖标题、tags 与正文。
- `meta` 携带单调递增的 `SCHEMA_VERSION`。

索引是派生状态，永远不是权威：版本不匹配或索引文件被删会从 vault 全量重建；测试支持 `:memory:`。

因为人会用 Obsidian 编辑 vault，提供方用 `settings-file` 与 `credentials-local` 的 chokidar 纪律监视每个 vault 目录：防抖重载、就绪时对账一遍以免与 watcher 启动竞态的改动丢失、隔离 watcher 错误、dispose 前先关闭。watcher 只索引 markdown 文件，忽略 `.obsidian/` 与索引文件。读取时还会复查 mtime，因此错过或被禁用的 watcher 事件会在下次使用时对账，而不是一直提供过期的链接。

## 可插拔与卸载语义

可插拔就是本设计的目的，而且它来自 DSH 现有规则而非新机制：

- **默认关闭的包。** 三个包都不进入任何交付组合；挂载是显式配置。
- **可选 service。** 第三方消费方用 `ctx.get('memory')` 读取；`tool-memory` 注入声明的 service，因此只有工具没有提供方的组合在加载时失败——配置错误显式失败。
- **基于 effect 的注册。** 工具、section 注册与事件监听器都是 `ctx.effect`：dispose 所属 fiber 即移除（HMR 安全，由仓库要求的 disposal 测试覆盖）。
- **卸载后数据存活。** 卸载会停止 watcher 与蒸馏、关闭索引、注销工具。vault 文件与索引文件留在磁盘上：重新挂载即恢复全部召回。数据从不随插件 fiber 存亡。

## 分期

- **Phase 1（本提案的构建）：** seam、带全文检索与链接的双作用域文件优先提供方、四个工具、卸载语义。
- **Phase 2：** 会话开始自动加载、带分类器的每回合蒸馏、`memory/*` 会话事件、引导 section。
- **Phase 3：** 两个作用域的 UI 管理面板（列出、阅读、编辑）、`/memory review` 升级流程、带生命周期策略的 `memory_delete`、展示蒸馏写入的会话节点。[recallable-compaction 笔记](2026-07-06-recallable-compaction.md)拥有相邻的会话内工作记忆设计；两者保持各自的作用域。
- **Phase 4：** 同一 service 之后的可选语义检索提供方（embedding）。届时再定，不是现在。

## Alternatives considered

- **维持只有 MCP overlay 的立场**（[第三方记忆 MCP 示例](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md)）。那份笔记交付了提供方 overlay，且刻意不含任何通用记忆 service；它仍然有效、仍然交付。作为第一方方案不予采纳，因为 MCP 记忆数据留在会话日志之外，自动加载与自动写入无法由会话事件触发，DSH 的压缩也够不到它。本提案是对 overlay 的补充，不是替代。
- **单一扁平全局 vault。** 不予采纳：项目事实会污染全局召回，也无法随项目走；双作用域链只需要一条仓库已在实践的作用域解析规则（workspace cwd 权限）。
- **只有工作区记忆。** 不予采纳：人设级的身份与偏好天生是全局的，WorkBuddy 的分层也证明两层各有价值。
- **纯日记式笔记（WorkBuddy 文件风格）。** 作为唯一轴不予采纳：只有日记会失去事实的精确召回与图谱中心性。混合形态保留日记的时间顺序与叙事，而事实留在互链的主题笔记里；其边际成本是设计本就支付的蒸馏调用里多一个输出字段。
- **Phase 1 就做 embedding/向量优先存储。** 不予采纳：付费或自托管依赖、结果不透明，而且在全文检索加链接尚未被证明不够用之前就投入检索质量工作。Phase 4 在 seam 之后留着这扇门。
- **笔记放进 `ctx.storage` KV**（[domain KV storage](../architecture/2026-07-24-domain-kv-storage-and-workspace.md)）。不予采纳：KV 值失去 Obsidian 兼容性与人类可编辑性，而这两点正是文件优先模型的意义。
- **把记忆并入 `session-query`。** 不予采纳：那个 seam 在 cwd 权限下读取不可变的会话日志；记忆是可变的、人可编辑的、天生跨会话的。
- **单包、无 seam。** 被能力 seam 规则否决：Service Definition/Service Provider/消费方的拆分正是 Phase 4 换检索提供方而不碰工具的前提。
- **提供方自有的 JSON 存储**（MCP Reference Memory 模式）。不予采纳：纯 markdown 文件更易读、更可 grep、更兼容 Obsidian。

## Acceptance criteria

1. 一个 keyless 测试组合经 Loader 启动三个包，并在没有模型密钥的情况下驱动每个工具；每次调用后两个作用域的 vault 文件与索引行一致。
2. Obsidian 能把任一 vault 作为有效 vault 打开；笔记之间的 `[[wikilinks]]` 正常解析；watcher 忽略 `.obsidian/` 与索引文件。
3. 每个作用域的 `write` 后 `read` 都能往返一篇笔记，`id` 稳定、时间戳由提供方维护；不带 `id` 的写入创建新笔记；没有解析出项目 vault 时的 project 作用域写入显式失败。
4. `search` 返回横跨作用域链的排序命中且项目命中排前；`traverse` 返回作用域内的双向有界邻接并标记悬空链接。
5. 对 vault 文件的外部编辑（不经过 DSH）在对账后出现在 `read`/`search` 中；与 watcher 启动竞态的编辑不丢失。
6. dispose 提供方 fiber 会注销工具并关闭 watcher；vault 文件与索引存活；重新挂载恢复同样的召回。
7. 同一宿主的两个会话共享记忆：会话 A 写入，会话 B 读取并检索到该笔记。
8. 全局 vault `dir` 缺失或不可写时，插件加载显式失败；project 作用域写入解析到不可写项目 vault 时显式失败。
9. 仓库门禁通过：逐文件覆盖率、HMR 安全/disposal 测试、固定模型可见 schema 与结果的 keyless 组装快照、包 README、invariant，以及新 service 的子系统页。
10. Phase 2 验收（现在记录、届时验证）：回放驱动的组装测试展示两份人设笔记的会话开始注入、一次每回合蒸馏写入项目笔记并追加一条链接该笔记的日记条目、分类器把一条个人事实路由到全局 vault、一个能重建该写入的 `memory/distill` 事件，以及日记不在注入集合内。

## Risks

- **Vault/索引漂移。** 外部编辑器与崩溃可能让索引失同步；派生状态设计把损失限制在重建以内，mtime 复查让过期状态只是暂时的。
- **并发编辑。** Obsidian 与 git 同步可能在提供方写入时同时写；文件层级最后写入获胜加索引对账，且提供方绝不重写自己最近没有写过的文件；日记追加经提供方单条独占写链串行。
- **蒸馏成本与质量。** 每回合一次辅助 LLM 调用是真实的每回合成本；配置开关（关闭项、最小回合长度、token 上限）约束它，合并而不重复陈述防止笔记累积复述。
- **静默写入错误记忆。** 自动写入的笔记可能错误或过期；UI 面板、`/memory review` 与 Obsidian 可编辑性是修正路径，审阅蒸馏内容是用户的持续职责。
- **无限增长。** Phase 1–2 没有 TTL 或清理；vault 变大后全量重建变慢。Phase 3 生命周期策略解决它。
- **只有 FTS 的召回。** 子串与词元匹配会漏掉语义等价的表述；Phase 4 度量差距前先接受。
- **Schema token 成本。** 挂载期间四个工具 schema 随每次请求发送；opt-in 包接受这一点，后续阶段可以按会话限制可见性。
- **作用域误判。** 没有 cwd 或 workspace 的会话回落到只有全局；在其注册 workspace 之外打开的项目不会写入项目记忆。这是文档化行为，不是隐藏默认值。
