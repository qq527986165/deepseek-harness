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

已敲定：`sidebar.footer.action` 按钮打开面板，面板本体以右侧抽屉注册进 `shell.overlay` —— 两者都是加法 list slot，ui-layout 与 ui-sidebar 保持不动；没有独立路由（shell 无 URL 路由），也没有命令栏入口。面板是单一表面，带 scope tab（全局 / 项目），不与对话并排：面板跨会话，而对话列是会话级的。每个选中 scope 下有“日记记忆”和“节点记忆”两个集合筛选项：“日记记忆”列出该 vault 的 `journal/` 全部文档，“节点记忆”列出 `notes/` 全部文档；项目 scope 先选项目，再使用相同筛选。搜索限定在当前 scope 与集合内。节点阅读用 `MarkdownText`，编辑是字段化表单（标题、正文、tags —— frontmatter 归 provider 持有）；日记文档只读。节点↔日记及前序节点链接在面板内跳到精确文件或日记条目锚点，backlinks 显示在阅读视图旁，悬空链接保留现有标记。项目 tab 的工作区来源在 E 下敲定。修正后的蒸馏提交流程完成前，暂停 UI 实现调整。

### B. UI 风格与文案

已敲定：仓库 client 规则原样适用 —— 中文产品文案，CSS Modules 配 `--dsw-*` 语义别名，禁字面色值、禁组件库、禁 Tailwind。面板全部字符串走 slot 注册的 locale 命名空间（`settings.memory` 风格 key），i18n 记录随包提交；入口图标复用 `ui-primitives` 现有图标集。列表为紧凑两行行（标题行 + tags/相对更新时间行），密度对齐 ui-settings —— 第一版不做卡片网格。徽标：不做 scope 徽标（scope 即 tab 轴，且搜索只搜当前 tab），tags 作徽标（至多 3 个 + `+N` 溢出，点击过滤），`updated` 作相对时间文本，`MEMORY.md` 带 persona 标签。

### C. 会话节点

已敲定：`ui-memory` 内注册一个单事件 `ConversationNodeDefinition`（kind `memory-distill`）；`match` 只对已提交的 `memory/distill` 凭证返回 `{ id: String(event.seq), role: 'start' }`，`start` 把整个载荷折成 State，无 update 路径，`publication: 'immediate'`，不注册 `buildLocationData`（无消费者）。lifecycle 只有在一次“用户提问至助手回答结束”回合的全部节点、日记条目、双向链接、索引行与回读校验成功后才追加该事件；无持久候选或任何失败/部分提交都不产生事件，因而不产生会话节点。keyed renderer 为混合 scope 回合中每个已提交节点各渲染一个 chip，点击精确打开该“节点记忆”文档；不渲染日记 chip 或部分失败行，用户经节点内的来源链接进入对应“日记记忆”条目。chip 点击经注册者私有的 open-request 源打开面板：源放在面板注册的 inject `hooks` 区（渲染器绑成 `useMemoryPanelOpen()`），节点的 inject 面暴露 `openNote(ref)` 回调——store handle 不能跨两个 scope 挂载（session 节点 vs root 面板），slot 系统在 load 期即拒绝。client 经 `@deepseek-ai/dsh-memory-lifecycle` 的 type-only `./types` 导出消费事件载荷。仅 chat 视图；Phase 3 不给 trajectory 表加专门行。

### D. 命令

已敲定：`/memory review` 是三段式流程——命令 handler 跑一次辅助模型调用（蒸馏同款、走会话路由模型），提议项目→全局升级候选，数量受 config 上限约束，append log-only 的 `memory/review` 事件 `{ reviewId, candidates: [{ id, title, snippet, reason }] }`，返回 `{ kind: 'success', sourceEventSeq }` 指向该事件。第二个会话节点（kind `memory-review`，业务 id `reviewId`）由 `memory/review`（start）渲染候选卡片：每条含接受/拒绝、全部接受与跳面板 chip；决策走 Typert Remote `memoryReview.decide(sessionId, reviewId, decisions)`：host 依据会话日志校验 review，升级被接受的笔记（写全局 + 移除项目文件——即 move），并 append `memory/review-decided` `{ reviewId, accepted: [{ id, title, globalId }], rejected: [id] }` 作为节点的 update。不用通用审批 seam：它渲染不了记忆域呈现（逐候选跳面板）。v1 无参数——源 scope 恒为 project，非空 rawInput 返回错误；全局-only 会话返回清晰错误文本。候选上限是 config 字段（`maxReviewCandidates`，默认 5），不是命令参数；模型不得向上控制。结果落对话（review 节点）；面板仅经 chip 点击充当候选检视器。

### E. 浏览器的远端服务面

已敲定：新建 host 侧包 `@deepseek-ai/dsh-memory-remote`（`packages/memory/memory-remote/`），注入 `memory`，承载两个 Typert Remote namespace，遵守一元 request/result 约定。`memory` 会话无关——`list`、`read`、`search`、`write`、`delete` 不带 sessionId，项目库经显式 `workspaceDir` 寻址并走服务的 `resolveScopes`（非注册路径以 `NO_PROJECT_SCOPE` 失败）；`memoryReview` 会话寻址——`decide(sessionId, reviewId, decisions)`（见 D）。memory 服务本身保持无 UI：其主消费者是工具与 lifecycle，远端仅在 web 组合中挂载。列表与读取区分 `notes/` 下的“节点记忆”和 `journal/` 下只读的“日记记忆”；打开日记时可携带提交凭证中的稳定条目锚点。`decide` 复用既有原语：`readInScope(project)` → `write(global)` → `delete(project)`（先写后删，失败不留缺失笔记）。授权：面板变更直接执行、无审批 seam——控制台用户即权威，审批机制要求活跃 agent 回合，面板操作不得依赖它；边界是服务层检查（sole provider、工作区门控的项目 scope、排他写链）。面板变更不写会话事件——vault 文件加索引即记录，与外部 Obsidian 编辑同权，watcher 对账回灌 UI。浏览器远端没有日记写方法。client 经 gateway 懒安装的 namespace 服务检测远端在场：缺席即隐藏 footer 按钮（无痕），绝不报错。

### F. 删除与生命周期

已敲定：`memory_delete` 参数 `{ ref, scope? }`（id 或精确标题，同 `memory_read`），底层补 `MemoryService.delete(ref, scope?, cwd?)` / provider `delete` 原语。删除为软删除：文件移入库外的回收文件夹——全局库旁 `$DSH_HOME/memory-trash/`、项目库旁 `<项目>/.dsh/memory-trash/`——文件名加时间戳，索引清除笔记行及其链接行。回收文件夹在库外，搜索与索引永不可见；恢复 = 手动把文件挪回（Obsidian 或任意文件工具），watcher 重新采纳；v1 不做恢复按钮。promote 的项目侧移除是例外：直接删除、不进回收站——内容已写入全局库，回收副本纯属垃圾。v1 无自动删除：`reviewAfterDays`（默认 30）仅给 `updated` 龄期超阈值的笔记打面板审核标记。链接修复只动索引：指向被删笔记的链接行被清除，文件正文永不改写，存留的 `[[wikilinks]]` 在下次重建时变悬空、按现有标记渲染。模型发起删除需经审批机制用户确认（其运行在活跃回合内）；面板删除是控制台用户本人操作，普通确认框即可。审批接入细节随 G 敲定。

### G. 设置与权限

已敲定：一张卡（namespace `memory-lifecycle`：lifecycle 包登记 host 半边，`ui-memory` 渲染浏览器半边），六个旋钮——`distill` 开关、`distillMode`（`concise` | `detailed`，默认 `concise`；模式选择固定的蒸馏指令，两段模型可见文本均由快照钉住）、`minTurnChars`、`maxInjectBytes`、`maxReviewCandidates`、`reviewAfterDays`——外加经新 `memory.info()` 遥控方法喂给卡片的只读全局库目录展示。卡片改动即时生效：设置写入先过校验，lifecycle 每次使用重读已解析配置。`maxDistillTokens`（默认升至 2048，暗处熔断器）、`distillTimeoutMs` 与辅助 `provider`/`model` 路由留插件配置——部署知识，非旋钮。用户自定义蒸馏提示词缓做。移除 `recentNoteCount`：会话开场注入改为两份 persona 全文 + 笔记目录（最新在前：标题、tags、更新时间、首行摘录），以 `maxInjectBytes` 字节封顶，细节经按需 `memory_read`/`memory_search` 获取；这修订了 Phase 2 注入机制，Phase 2 笔记、第一方提案、`memory/inject` 事件语义与回放快照随之更新。无新权限预设：面板操作即控制台用户行为（E），`memory_delete` 走现成 `ctx.approval.request`（`toolName: 'memory_delete'`），继承会话审批策略——`ask` 弹确认卡片，`never` 自动拒绝。无更细的按 scope 可见性：控制台用户所见即 host 所能触及（工作区门控的项目 scope、恒可见的全局 scope）。

### H. 组合与默认值

已敲定：`ui-memory` client 包默认进 web-app bundle，记忆远端缺席时自我隐藏——用户永远不用管浏览器半边；五个 host 包（记忆家族加 `memory-remote`）保持显式挂载，未组合即什么都不干。降级阶梯：无记忆行 → 无痕（无按钮、节点不匹配、无卡片）；有记忆行但无 `memory-remote` → 同上，Phase 2 无 GUI 照常工作；有 `memory-remote` 但 provider 未注册 → 按钮出现、面板渲染友好"提供方未挂载"横幅；全部组合 → 完整面板。分发意图（记档，待功能内测之后执行）：家族以外部插件式可安装组合包交付——第一方 `@deepseek-ai/dsh-memory-bundle` 声明 `dsh.bundle`，patch 组合五行并发布到 npm，用户 `dsh plugin --profile <name> add @deepseek-ai/dsh-memory-bundle` 即装即用，与 docs/user/develop/basic/publish.md 描述逐字一致。bundle 包、其安装测试与对外发布属于功能窗口之后的打包任务；在此之前用户仍可手写五行组合。代码暂留本仓库（开源抽离仍属范围外）；现在按外部插件设计分发形状，将来搬家对用户零感知。

### I. 验证

已敲定：凡模型或用户可见行为均由 keyless 测试钉住，凡触及的包都在逐文件覆盖率门禁内。蒸馏覆盖同时证明两条分支：无持久候选时两个 vault 与会话日志都不变；需要记忆的回合写入非空且唯一命名的节点，加 scope 内日记条目与精确双向链接，校验索引和读取路径后才追加可回放的 `memory/distill` 凭证。对每个文件/索引/校验步骤注入失败，证明整轮回滚或恢复，包括项目/全局混合回合。后续同类记忆创建带前序链接的新节点且旧文件不变；本地自然日测试覆盖配置时区跨 UTC 日期边界。回放 web 测试只凭已提交事件重建节点，为每个真实节点显示一个 chip，不含日记 chip 或部分失败节点。review 与删除组装测试保持原决策；面板投影、设置卡片及以后每项可见变更拿 keyless web 快照（`DSH_SNAPSHOT=replay pnpm run test:web`）。新包和被改包保持逐文件 100% 覆盖。门禁随改随跑：`test:gui`、typecheck、lint、doc-sync、双语 pair 重录、带 Model Experience 段的包 README 与生成目录。同一批改动更新 Phase 2 implemented 笔记、第一方提案、事件语义、提示词、README 与回放快照。

## Decisions log

| # | 日期 | 议题 | 决策 | 依据 |
|---|---|---|---|---|
| 1 | 2026-08-19 | A —— 面板形态与入口 | footer 动作按钮 + `shell.overlay` 抽屉；单面板带 scope tab，不与对话并排；列表只含笔记、按 `updated` 倒序，配 FTS 搜索框与 tags 徽标；`MarkdownText` 阅读 + 字段化编辑表单（frontmatter 归 provider）；wikilink 点击面板内跳转，backlinks 在阅读视图旁，悬空链接保留标记 | 面板跨会话，不能放会话级 seat；两个加法 list slot 无需 shell 改动；`updated` 倒序与 provider recency 语义一致；字段化编辑保住 provider 持有的笔记身份 |
| 2 | 2026-08-19 | B —— UI 风格与文案 | 仓库 client 规则原样；文案全走 locale 命名空间并提交 i18n 记录；复用 ui-primitives 图标；紧凑两行列表行、对齐 ui-settings 密度，v1 不做卡片；徽标：tags（≤3+溢出、点击过滤）、`updated` 相对时间文本、`MEMORY.md` 带 persona 标签，不做 scope 徽标 | scope 已是 tab 轴，行内徽标冗余；密集列表适合扫读大量蒸馏笔记的管理流程；时间是排序键而非分类属性 |
| 3 | 2026-08-19 | C —— 会话节点 | 单事件定义（kind `memory-distill`、`event.seq` 身份、无 update 路径、`immediate` 发布）；每条笔记写入一个 chip + 日记 chip（只读打开）+ 弱化失败行；面板打开经注册者私有源（面板注册的 inject `hooks` 区）+ 节点 inject 面的 `openNote(ref)`；`@deepseek-ai/dsh-memory-lifecycle` 加 type-only `./types` 导出；仅 chat 视图 | 事件每 pass 单条，start-only fold 即完整状态机；store handle 不能跨两个 scope 挂载（load 期错误），open 请求走 sanctioned 的 hooks 区；client 程序经纯类型子路径消费 wire 类型 |
| 4 | 2026-08-19 | D —— `/memory review` | 三段式：命令 handler 经一次辅助调用提议候选，append `memory/review` `{ reviewId, candidates[] }`，返回 `sourceEventSeq`；`memory-review` 节点渲染候选卡片；接受/拒绝走 `memoryReview.decide(sessionId, reviewId, decisions)`（会话日志授权），升级 = 写全局 + 移除项目文件（move），并 append `memory/review-decided`；不用审批 seam；v1 无参数；候选上限为 `maxReviewCandidates` config（默认 5） | `CommandResult` 只能指向权威领域事件，候选必须落会话日志；通用审批卡片渲染不了逐候选跳面板；升级为 move，链接经 scope 链解析；上限归 config 所有，模型不得向上控制 |
| 5 | 2026-08-19 | E —— 浏览器远端服务面 | 新包 `@deepseek-ai/dsh-memory-remote` 两 namespace：会话无关的 `memory`（`list`/`read`/`search`/`write`/`delete`，项目 scope 带显式 `workspaceDir`）与会话寻址的 `memoryReview.decide`；新增 `MemoryService.list` 原语（只列笔记、不含日记行）；`decide` = 读项目 → 写全局 → 删项目；无审批 seam——控制台用户即权威，服务层检查即边界；面板变更不写会话事件；日记经 adopted 身份只读打开 | memory 服务的主消费者在 host 侧，浏览器传输应放独立消费者包、只在 web 组合挂载；审批机制要求活跃 agent 回合，会话无关的面板操作不得依赖；面板写就是普通 provider 写，记录即 vault 加索引 |
| 6 | 2026-08-19 | F —— 删除与生命周期 | `memory_delete` `{ ref, scope? }` 走新 delete 原语；软删入 vault 外的回收文件夹（时间戳文件名、清索引行）；promote 的项目侧移除直接删；v1 无自动删除 TTL——`reviewAfterDays`（默认 30）在面板标记陈旧笔记；链接修复只动索引（文件永不改写，链接悬空按现有标记）；模型删除需确认，面板删除为普通确认框 | 库外回收文件夹天然对搜索与索引不可见，恢复就是日常文件移动；自动删除伤用户手改笔记而收益小，清理权归人；provider 从不改写非己所写文件，修复停在索引层 |
| 7 | 2026-08-19 | G —— 设置与权限 | 卡片字段：`distill` 开关、`distillMode`（`concise`/`detailed`，默认 `concise`）、`minTurnChars`、`maxInjectBytes`、`maxReviewCandidates`、`reviewAfterDays`、经新 `memory.info()` 展示的只读库目录；`maxDistillTokens`（升至 2048）与 `distillTimeoutMs` 留插件配置（熔断器/资源阀，非旋钮）；`provider`/`model` 留 cordis.yml；卡片改动即时生效；无新权限预设——面板操作即控制台用户行为，`memory_delete` 走 `ctx.approval.request`（继承会话策略；`never` 自动拒绝）；移除 `recentNoteCount`，会话开场注入改为 persona 全文 + 笔记目录（标题/tags/更新时间/摘录，最新在前、字节封顶），细节经按需 `memory_read` 获取——这是 Phase 2 机制修订，测试、快照、`memory/inject` 语义与两份笔记同步更新 | token 上限当用户旋钮等于鼓励截断；输出模式才是面向用户的旋钮，上限留作暗处熔断器；超时跟随路由，属部署知识；固定条数无视笔记大小与相关性——目录用字节换广度，模型需要时再取细节；审批策略本就归属会话 |
| 8 | 2026-08-19 | H —— 组合与默认值 | `ui-memory` 默认随 web-app bundle 发布、无记忆远端时自我隐藏；五个 host 包保持显式挂载；四档降级（无痕 → 无 GUI 但 Phase 2 照常 → provider 缺失友好横幅 → 完整面板）；分发意图记档：第一方 `@deepseek-ai/dsh-memory-bundle`（`dsh.bundle` + 五行 patch，npm 发布）经 `dsh plugin add` 安装，与 docs/user/develop/basic/publish.md 逐字一致——功能内测后、对外发布前的打包任务中构建并测试 | 浏览器半边对所有用户免费、在场由 host 组合决定，隐藏零成本；bundle 形态是文档化的外部插件路径，与既定终点（任意用户可装）一致；代码暂留仓库避免插件未成熟时分叉 client 工具链 |
| 9 | 2026-08-19 | I —— 验证 | 三份 keyless 组装测试（review 流程回放、删除含回收夹/索引/链接断言、仅凭事件重建蒸馏节点）加面板/卡片/一切可见变更的 keyless web 快照；新包与被改包逐文件 100% 覆盖；`test:gui`/typecheck/lint/doc-sync/pair/README/tool-catalog 随改随跑；Phase 2 修订同一批 PR 更新其笔记、提案、事件语义与快照 | 模型或用户可见行为需要 keyless 钉住的证据（仓库测试政策）；client 包在覆盖率门禁内；Phase 2 机制变更是行为变更，其所属证据随之更新 |
| 10 | 2026-08-19 | D 实现 —— registry 名称 | 命令注册为 `memory-review`：命令文法只接受单个小写 token（`/^[a-z][a-z0-9_-]*$/`），因此用户输入行是 `/memory-review`，其后任何非空 rawInput 都会报错 | 空格分隔的 `/memory review` 在 registry 文法中无法存在；连字符形式匹配 `memory-review` 节点 kind 与已敲定的无参数行为 |
| 11 | 2026-08-19 | ② 实现 —— 面板线缆细节 | 面板的三项实现决策：(1) `memory/change` 进入转发事件白名单（其 `Events` 声明移至 `dsh-memory/types`），面板随 watcher 对账重载；(2) `MemoryNote` 增加 `updated`（索引 mtime），使保存前写入的冲突检查能显示变更时间戳；(3) 正文 wikilink 在打开时按精确标题各发一次 `read` 解析（`NOT_FOUND` 未命中即标记悬空），已敲定的 remote 方法集保持不变 | 面板的实时对账是已敲定的 E 面，白名单就是唯一控制点；已敲定的风险条款要求显示更新时间戳，而 read 结果本身承载不了；逐标题读取复用现有 `read` 原语，不扩宽 remote |
| 12 | 2026-08-19 | ② 实现 —— 命名空间安装窗口 | gateway 提供 `memory` 命名空间服务的时刻比其方法安装早一 tick，因此任何消费者都不得在 apply 时刻捕获服务对象或调用其方法。面板经 reader `() => MemoryRemote` 按调用解析；presence 探针与设置卡片在 `info` 缺失时经 `queueMicrotask` 重试；面板控制器的 `refreshInfo`/`runLoad` 以 `info` 为哨兵等待方法就绪（全部方法在同一次 `defineProperty` 中安装）；`info()` 被拒绝时 presence 探针与卡片目录行落到 absent/unavailable，`connection/reset` 重新探测 | apply 时刻的同步访问与 gateway 的安装 tick 赛跑（组装启动实测 `remote().info is not a function`）；reader 加有界 microtask 重试让每个消费者在方法装好后自行收敛，不扩宽 remote、不改已敲定界面 |
| 13 | 2026-08-19 | ③ 实现 —— review 节点线缆细节 | review 节点的三项实现决策：(1) `memory/review` 增加必填 `workspaceDir`（会话的已注册工作区），跳面板 chip 得以精确寻址项目库，而不是落在工作区选择器上；(2) 逐卡接受/拒绝与全部接受只是暂存一个 partition，一次显式确认才把完整 partition 提交给 `memoryReview.decide`——已决的 `memory/review-decided` 随后把每张卡翻到已决标记（验收 2 的"确认后升级"）；(3) Definition 与 keyed renderer 同面板面一样随 presence 门控注册，无记忆远端的主机不留痕迹 | 命令只有在项目工作区存在时才能产出该事件，字段恒有定义；暂存 partition 加一次确认避免最后一次误点就提交 move；tier 2 要求无远端时节点不注册，只有门控 Definition 才能保证 |
| 14 | 2026-08-19 | ④ 实现 —— distill 节点线缆细节 | distill 节点的三项实现决策：(1) 以 `event.seq` 为键的单事件折叠——start fold 携带完整检查点（`notes` + `journal?` + `error?`），节点仅凭 log-only 事件即可重建，没有 update 路径；(2) 笔记 chip 在面板中打开所写笔记（普通视图），日记 chip 以 `adopted:journal/<date>.md` 只读打开；distill 事件不带 `workspaceDir`，项目作用域跳转使用拥有该会话节点的 session `cwd`；(3) Definition 与 renderer 与 review 节点共用 presence 门控（tier 2：无远端即无痕） | 事件每次 pass 单条且自带完整检查点，`event.seq` 就是精确的稳定身份；adopted 身份是 provider 解析日记文件的唯一路径；conversation node owner 已把已注册工作区目录传给 renderer；共用门控让四级降级阶梯在节点族内保持一致 |
| 15 | 2026-08-20 | ⑤ owner 走查 —— 项目 distill chip 寻址 | 项目 `memory-distill` chip 发布 open request 时携带 conversation node 的 `cwd` 作为 `workspaceDir`；面板不再依赖当前项目选择器值来处理节点驱动的项目打开请求，不改后端事件或 Remote 协议。面板仍无手工新建入口：笔记由自动蒸馏或 `/memory-review` 升级产生，随后面板负责列出、读取、编辑、保存、删除已有笔记 | owner 发现项目 distill chip 打开面板时报 `project-scope write requires a session working directory`；事件有意不带 `workspaceDir`，而 renderer 已从 `conversation.chat.node` 收到 session cwd；增加手工新建会违背 Phase 3 的生命周期模型 |
| 16 | 2026-08-20 | ⑤ owner 走查 —— 双轴记忆与提交凭证 | 一轮完整的“用户提问至助手回答结束”要么什么都不写，要么原子提交一篇或多篇新节点，并在每个参与 scope 追加一个 scope 内日记条目。节点与精确日记条目双向链接；后续同类事实创建唯一命名的新节点，可选链接前序节点，绝不合并旧文件。项目/全局分组共同提交或都不提交。日记日期取配置的用户/主机时区。文件、索引行、读取与链接全部校验后才追加 `memory/distill`，聊天节点只为每个已提交节点展示 chip；面板在每个 scope 下提供“日记记忆”与“节点记忆”筛选。本决策在冲突处取代决策 1、3、5、9、14、15 | 真实走查产生了两条 `notes: []` 的纯日记凭证，其中一条还声称已写入一个实际不存在的节点。模型生成的链接文字与前缀提交事件不能证明记忆已持久化。host 生成稳定引用、追加式节点、整轮提交语义与校验后发布，使聊天、面板、文件与 Obsidian 的每个入口都解析到真实内容，同时保留时间历史 |

## Alternatives considered

- **用 dsh 内通用文件查看器代替专用记忆面板。** 否决作为唯一界面：面板必须知道 scope 归属、笔记身份与后续的升级/删除流程，通用查看器表达不了。通用查看器仍是独立的插件决策，不是 Phase 3 的依赖；面板的读取/编辑视图可以复用共享的 markdown 原语。
- **只用 Obsidian，不做 GUI 界面。** 否决：被静默蒸馏的内容的可见性与 `/memory review` 升级流程是提案面向用户的承诺；没有面板，它们在 vault 文件夹之外就不可见。
- **只经 cordis.yml 配置，不做 settings card。** 否决：部署级配置已存在，但窗口指令保留了设置页；settings card 是仓库标准的做法，让用户不必编辑 patch 文件就能拿到同样的旋钮。

## Acceptance criteria

- 面板列出双 scope、打开笔记，编辑经提供方 watcher 对账后持久化。
- `/memory review` 展示候选，用户确认后把笔记升级到全局 vault。
- `memory_delete` 连同索引与链接清理一起删除笔记。
- 会话节点只凭已提交的 `memory/distill` 凭证即可重建，暴露全部真实节点且不提供日记捷径；空蒸馏或失败蒸馏绝不出现节点。
- 每个选中 scope 都从 `journal/` 列出“日记记忆”、从 `notes/` 列出“节点记忆”；双向链接能在精确日记条目与其节点间跳转。
- 需要记忆的回合跨项目/全局分组原子提交新节点、scope 内日记条目、索引行和双向链接；无记忆回合什么都不写，后续同类事实创建带前序链接的新节点，本地日期遵循配置时区。
- 设置卡片改变部署级配置字段。
- 仓库门禁通过：逐文件覆盖率、keyless 快照、双语文档。

## Risks

- **远端服务面扩大。** 向浏览器暴露记忆 list/write/delete 是面板最大的新攻击面；会话无关变更的授权设计是最危险的一块，应最先敲定。
- **删除不可逆。** 物理删除没有回收站，粗心的 TTL 可能毁掉用户编辑过的笔记；软删除或 review-first 默认值可以限定损害。
- **并发编辑。** 面板、Obsidian 与蒸馏可能写同一条笔记；提供方在文件层面保证最后写入者胜出，因此面板必须在保存前重读并展示更新时间，避免覆盖。
- **模型侧的删除权力。** 静默的 `memory_delete` 可能删掉用户编辑过的笔记；授权模型决定删除是否需要用户确认。
- **跨 vault 提交中断。** 进程可能在项目/全局 vault 的节点、日记与索引写入之间崩溃；暂存与恢复元数据必须在任何成功事件可见前补完或回滚整轮。
- **追加式重复。** 新节点保留时间顺序且不改写旧记忆，但相关事实可能累积；前序链接与后续节点视角提供连续性，不削弱禁止合并规则。

## Deferred

- **请求时刻的意图驱动召回。** 从用户提示词推断当前意图，展开成查询词并注入匹配的记忆。记档待与 Phase 4 语义检索一同评估（提案将该项留到 Phase 4："Decided then, not now"）。现在点名的代价：请求关键路径上的推断调用（可感知延迟）或弱关键词抽取、每次请求注入导致前缀缓存失效、需要带自身上限与快照的新注入事件族。Phase 3 改用目录注入 + 模型按需 `memory_search`/`memory_read`。
- **可配置的全局记忆库目录。** owner 希望全局 vault 路径可配置为显式绝对目录，因为 `$DSH_HOME` 可能位于空间紧张的系统盘。该项推迟到迁移行为、热重载时机、校验与 watcher 归属设计清楚后再做。
- **一级记忆设置页。** owner 希望 Memory 与通用设置、模型、插件、Agent 预设同级，而不是嵌在插件里。该项推迟到 settings 导航与 slot 归属定义一方功能页如何注册该层级后再做。

## Out of scope

- 语义检索（Phase 4）。
- dsh 内通用文件查看器（独立的插件决策，不是 Phase 3 阻塞项）。
- 开源/抽离插件（插件完整后再议）。

## Implementation plan

开发以用户明确签批为起点。阶段 ①–④ 交付功能窗口；⑤–⑥ 按用户节奏执行（先功能内测，再打包）；⑦ 仅记档。

### ① host 基础（服务原语 + 删除 + 遥控面 + 机制修订）

- `memory`：新增按集合区分的 `list(scope, kind, cwd?)`、`delete(ref, scope?, cwd?)`、`info()`（全局库目录）；`kind` 区分“节点记忆”和“日记记忆”。
- `memory-local`：provider 分别列出 `notes/` 节点与只读 `journal/` 文档，并为节点提供 `delete`（软删入库外回收夹，清索引与链接行）。
- `tool-memory`：`memory_delete { ref, scope? }` 经 `ctx.approval.request` 询问（`ask` 弹确认卡片、`never` 自动拒绝）；tool-catalog 条目。
- `memory-lifecycle`：目录注入替换 `recentNoteCount`（连同 `memory/inject` 语义）；`distillMode` 指令选择；`maxDistillTokens` 默认 2048；配置活源（设置免重启生效）；`installSettingsSection` host 半边（namespace `memory-lifecycle`）；`./types` 导出；`/memory review` 命令 handler + `memory/review` 事件 + `maxReviewCandidates`/`reviewAfterDays` 字段。
- `memory-remote`（新）：namespace `memory`（`list`/`read`/`search`/`write`/`delete`/`info`，会话无关）与 `memoryReview.decide`（会话日志授权；promote = 读项目 → 写全局 → 删项目；append `memory/review-decided`）；`./invariant`；README。

测试：服务/provider 单测（list 排除 journal、回收夹与链接清理、`NO_PROJECT_SCOPE`）；目录注入组装测试（字节封顶）；`distillMode` 指令快照；删除组装测试（验收 3）；审批路径；`decide` 校验与三步 promote。门禁：逐文件覆盖率、typecheck、lint、doc-sync、pair 重录。同一批 PR 更新 Phase 2 笔记与第一方提案（注入机制段）。

### ② client 包 + 面板 + 设置卡片

- `ui-memory`（新）：完整骨架（client aggregate 引用、web-app `dsh.client` 行、web-app 依赖）+ 对 `memory-remote` 的 type-only 边。
- 面板在 host 修正关闭后再调整：footer 动作按钮 + `shell.overlay` 抽屉；scope tab + 工作区选择；“日记记忆”/“节点记忆”集合筛选；集合内搜索；紧凑节点列表；带精确条目跳转的只读日记视图；包含双向/前序链接、backlinks 与悬空标记的 `MarkdownText` 节点视图；字段化节点编辑；删除确认框；provider 缺失横幅；store + 注册者私有 open-request 源；locale 命名空间。
- 设置卡片：六旋钮 + 经 `memory.info()` 的只读目录，写入带 revision 栅栏。

测试：四档降级、组件行为 spec、keyless web 快照（面板、卡片）、逐文件 100%。门禁：`test:gui`、`DSH_SNAPSHOT=replay pnpm run test:web`、i18n 记录。

### ③ `/memory review` client 半边

`ui-memory` 的 `memory-review` 节点：`memory/review` 为 start、`memory/review-decided` 为 update（业务 id `reviewId`）；候选卡片带接受/拒绝/全部接受与跳面板 chip；已决态。回放驱动组装测试（验收 2）以脚本化 adapter 驱动全流程，断言两个库与事件。门禁同 ②。

### ④ 蒸馏提交流程与会话节点

先修正 host 流程，再进行任何 UI 工作：零候选整批不写；追加式唯一命名节点；按配置时区选择的分 scope 日记条目；host 生成的精确条目双向链接与可选前序链接；项目/全局 vault 的整轮暂存与恢复；写后索引/读取/链接校验；仅在提交完成后产生 `memory/distill` 凭证。随后把 `ui-memory` 节点改为只给每个已提交节点显示一个 chip，精确打开该“节点记忆”文档。回放测试覆盖空结果、成功、混合 scope、前序链接、时区边界与每条部分失败路径，再运行组装节点快照。门禁同 ②，并覆盖被修改的 host 包。

### ⑤ 功能内测

起真实测试 profile（五行 + web-app）；走通生成笔记的列出/读取/编辑/保存/删除、蒸馏节点、review 流程与设置即时生效；全量门禁复查（覆盖率、`test:gui`、web 回放、typecheck、lint、doc-sync、budgets）。PRD 在同一 PR 转正为 implemented Agent Note。

### ⑥ 打包、发布与安装测试

核对五包 npm 发布状态并补发缺失；新建 `@deepseek-ai/dsh-memory-bundle`（`dsh.bundle` + 五行 patch）；在干净 `$DSH_HOME` 上执行 `dsh plugin --profile <test> add @deepseek-ai/dsh-memory-bundle`，以 `--dump-config` 验证层，启动、确认面板出现，并确认 `remove` 干净。

### ⑦ 对外发布

仅记档；计划在本窗口之外。

### 验收标准映射

| # | 验收 | 阶段 | 验证方式 |
|---|---|---|---|
| 1 | 面板列出双 scope、打开笔记、编辑持久化 | ①② | 组装测试（remote list/read/write → 文件+索引断言）+ web 快照 |
| 2 | review 展示候选、确认升级 | ①③ | 回放驱动组装测试 |
| 3 | `memory_delete` 连同索引与链接清理删除 | ① | 删除组装测试（回收夹、索引、悬空） |
| 4 | 节点仅凭 `memory/distill` 事件重建 | ④ | 回放测试 + cookbook 套件 |
| 5 | 设置卡片改部署级字段 | ①② | 组装测试（行为变化）+ web 快照 |
| 6 | 仓库门禁通过 | 各阶段 | 各阶段门禁 + ⑤ 全量 |

开发期备忘：Windows node 22 PATH；symlink-EPERM 用例与 26 处 `rescope-vendor` 残留是环境/既有项，不修；新服务面守能力 seam 三角色；远端照 `message-feedback` 一元模式；节点守 match/update 纪律；含中文文件只用仓库 read/write/edit 工具改。

## 执行检查点（2026-08-19）

阶段 ① 已在工作树中完成（未提交）；阶段 ②–⑥ 待续，笔记保持 `Status: proposed`，直至阶段 ⑤ 转正。已交付：服务原语（`list`/`searchInScope`/`delete`/`info`）、提供方列表与回收站删除、经审批 seam 的 `memory_delete`、取代 `recentNoteCount` 的目录注入、`distillMode` 与 2048 token 熔断、`memory-lifecycle` 设置命名空间、`memory-review` 命令与 review 事件、新包 `dsh-memory-remote`（命名空间 `memory` 与 `memoryReview.decide`）、`memory-review` LLM purpose，以及删除/review 组装测试。memory 包测试全过，`packages/memory/**/src` 逐文件覆盖 100%，`typecheck`/`lint` 通过；暂停时 `doc-sync` 除两项记录在案的环境专属 symlink-EPERM 失败（文档站点检查、sqlite 持久化）外全部通过。

续接：重跑 `pnpm run doc-sync`（只修不在环境清单上的失败），随后按计划进入阶段 ②。会话之间保持工作树不提交。

阶段 ② 状态（2026-08-19）：`ui-memory` 包、面板与设置卡片已实现。gateway 命名空间服务的安装竞态由按调用解析的 reader 加有界 `queueMicrotask` 重试处理（决策 11–12）；此前以 `remote().info is not a function` 失败的组装启动现已通过。单测：14 个文件 / 154 个测试全绿。组装 web 通道（`DSH_SNAPSHOT=replay`）：`built-boot`、`memory-panel`（两条新 keyless 场景）、`image-display`、`todo-row`、`max-tokens-notice`、`search-card` 全部通过。阶段 ② 门禁：`ui-memory` 逐文件 100% 覆盖（四项指标全满）、`test:gui`（287 套件）、`typecheck`、`lint`、`doc-sync`（28/28）、i18n 记录重录、四份生成目录（slot/config/cordis/doc-graphs，含 memory subsystems 双语页）重新生成。`memory_read` 输出 schema 与 `ReadNoteValue` 补上 `updated` 字段（决策 11），工具恢复通过校验。本 Windows 机器上的环境专属 web 通道失败（不得修复；Linux CI 拥有回放）：Playwright 浏览器未安装（浏览器 e2e 套件在 `browserType.launch` 失败）、`apps/web/tests/scaffold.ts` 把原始 Windows cwd 代入 JSON fixture 头（seed-fixture 套件解析失败）、三份 goldens 的平台漂移（shipped 工具清单里 `pwsh` 对 `bash`、manifest 图标/主题字段、minimal-preset 快照的路径分隔符）、`hmr-live`（dev:web 端口被用户正在运行的 `dsh web` 占用）。阶段 ② 完成；下一阶段为 ③（`/memory review` client 半边）。

阶段 ③ 状态（2026-08-19）：`memory-review` 会话节点已实现并随 presence 门控（决策 13）。节点以品牌 `reviewId` 折叠 `memory/review`（start）与 `memory/review-decided`（update）；候选卡片暂存接受/拒绝（另有全部接受与跳面板 chip），一次显式确认把完整 partition 提交给 `memoryReview.decide`。`memory/review` 增加必填 `workspaceDir` 字段（host、invariant、测试，memory 279 测试全绿）。fixture 提供 `memoryReview/decide`（双层包装的 `MemoryReviewDecideResult`、提升进全局库、append `memory/review-decided`、转发 `memory/change`），fx-alpha 增加 `/memory-review` 回合（todo 回合移至 75）。阶段 ③ 门禁：`ui-memory` 17 文件 / 187 测试且逐文件 100% 覆盖、`connection` 50 测试、`typecheck`、`lint`、`test:gui`、`doc-sync` 28/28（slot/persistence 目录重生成）、i18n pair 重录、keyless 组装 `memory-review.snapshot.ts`（验收 2）及其余组装快照在 `DSH_SNAPSHOT=replay` 下通过。阶段 ③ 完成；下一阶段为 ④（`memory-distill` 会话节点）。

阶段 ④ 重新打开记录（2026-08-20）：原会话节点实现及自动化证据描述的是决策 14 的前缀提交事件，不是决策 16 的提交凭证。owner 走查用两条 `notes: []` 的纯日记事件证明了缺口，其中一条还带悬空节点链接。当时阶段 ④ 重新打开，先修 host 提交流程；已有的节点项目寻址修复仍有用，但不能作为完成证据。阶段 ⑤ 暂停；修正后的 lifecycle、事件与组装回放通过前，不调整面板实现，也不开始阶段 ⑥。

阶段 ⑤ 基础设施（2026-08-19，owner 走查待进行）：测试 profile `memory-phase5` 已建在 `$DSH_HOME/profiles/memory-phase5`（bundles `dsh-base` + `dsh-web-app`，外加五行 memory host 行；vault 在 `$DSH_HOME/memory-phase5-vault`，watcher 开启）。端到端已验证：`dsh --profile memory-phase5 --dump-config` 正确组合各行；真实启动（`pnpm dsh --profile memory-phase5 --port 3180`）无错装载整棵树、前端根页面正常响应、插件注册表正常提供 ui-memory 浏览器 bundle。全量门禁复查已在本窗口完成：覆盖率门禁逐文件阈值零错误（所有被改包 100%）、809/814 套件通过——shipped tool-catalog golden 补上五个 memory 工具（就地修正）、一个 oxlint-contract 计时测试在并行 lane 下抖动且单独运行通过、三个套件为环境性失败（Windows 沙箱进程创建：`sandbox-windows-acl`、`pwsh-sandbox`、`acp-snapshot`）；`test:gui`、`typecheck`、`lint`、`doc-sync` 全部通过；完整 `DSH_SNAPSHOT=replay` web 通道的 node-harness 套件全部通过（built-boot、memory-panel、memory-review、memory-distill、todo-row、image-display、search-card、max-tokens-notice、scaffold-hermetic、vite-entry、subagent-interrupt），其余 67 个失败全部落在已记录的环境族内（Playwright 浏览器缺失、`scaffold.ts` 的 Windows cwd JSON 代入、三份平台 golden、dev:web 端口被用户在用服务器占用）。阶段 ⑤ 剩余：owner 在该 profile 上走查生成笔记的列出/读取/编辑/保存/删除、蒸馏节点、review 流程与设置即时生效，随后 PRD 转正为 implemented Agent Note。

阶段 ⑤ owner 走查反馈（2026-08-20）：profile 经已配置凭据源完成真实蒸馏，暴露的是 lifecycle 缺陷，不是凭据或单纯面板缺陷。项目 vault 只有 `journal/2026-08-20.md`；两条持久事件都是 `notes: []`，第一条日记还链接并声称已写入一个实际不存在的节点。决策 16 以整轮提交凭证取代纯日记/前缀成功，并重新打开阶段 ④。阶段 ⑤ 保持打开但暂停，直到修正后的 host 流程通过，owner 再复测真实节点创建、节点→日记跳转、面板列出/读取/编辑/保存/删除、review 与设置即时生效。

阶段 ④ 重新关闭检查点（2026-08-20）：决策 16 的 host 流程与必需的 `memory-distill` 节点调整已在工作树中关闭。验证证据：host 精确 coverage 通过 17 个文件 / 329 个测试，四项指标均为 100%；client `ui-memory` + `connection` 通过 20 个文件 / 241 个测试；keyless web `memory-distill` 回放通过 1 个文件 / 1 个测试；`test:gui` 通过 292 个文件 / 3997 个测试，1 个跳过；`typecheck` 通过；`pnpm run lint:contracts-ready` 通过。`doc-sync` 不是该检查点的关闭证据。阶段 ⑤ 仍未完成并暂停等待 owner 复测；阶段 ⑥ 未开始。

阶段 ⑤ owner 第二次走查交接（2026-08-21）：本轮 session `0ff7...` 明确在 `memory_search` 后执行 `memory_write`（seq289/290），随后 `turn/end` 为 seq366，全日志没有 `memory/distill`；它产生 `notes/测试节点标题约定-phase-owner-走查.md`，文件名无 8hex 短 ID，正文无日记链接，今日无 `journal` 且无事务残留。该结果是普通显式 tool 写节点，不是 `commitDistill` 部分失败；新 host 事务不因此重新打开。走查提示词“请记住”会诱导 `memory_write`，不能作为自动蒸馏验收样本；后续验收要用不诱导显式写的陈述性回合，或不挂 `tool-memory` 的专用 profile，并同时核验短 ID 节点、今日 journal、双向锚点和 `memory/distill` receipt。

用户报告聊天中没有 `memory-distill` UI，与该轮无 `memory/distill` receipt 一致。当前设计没有为普通 `memory_write` 注册专用 memory 会话节点；该轮不能证明 journal 创建失败。

已确认的真实遗漏是决策 16 要求每个 scope 下提供“日记记忆/节点记忆”筛选，但现实现的 `MemoryService`/remote list 仍只列 notes、没有 `kind`，controller 与 panel 没有集合状态和控件，journal 无法列出。决策 16 已取代旧决策 5 的 journal-excluded list，因此阶段 ⑤ 不得关闭。

交接前仍需先裁决：显式 `memory_write` 是继续作为独立 node-only 写入并与自动蒸馏分离，还是也必须纳入整轮节点、日记和 receipt 语义；当前没有既定决定，不得擅自宣称。阶段 ⑤ 保持打开并暂停，交给其他 agents 修复；阶段 ⑥ 不得开始。当前 agent 未改功能代码。

## Handover

阶段 ②–④ 保持在未提交工作树中已实现，阶段 ④ 已按决策 16 重新关闭。阶段 ⑤ 仍未完成并暂停，需先修复 journal 列表筛选遗漏并裁决显式 `memory_write` 语义，阶段 ⑥ 未开始。本笔记保持 `Status: proposed`，直至 owner 阶段 ⑤ 关闭。

### 交与下一任执行者的交接（2026-08-19）

**阶段状态与证据。** ②（面板 + 设置卡片）、③（`memory-review` 节点）、④（`memory-distill` 节点）全部完成且门禁全绿：`ui-memory` 19 文件 / 204 测试且逐文件 100%（四项指标）、`memory` 279 测试、`connection` 108 测试、`typecheck`、`lint` 0/0、`test:gui`、`doc-sync` 28/28，keyless 组装快照（`memory-panel`、`memory-review`、`memory-distill`，另有 `built-boot`、`todo-row`、`image-display`、`search-card`、`max-tokens-notice`）在 `DSH_SNAPSHOT=replay` 下全绿。阶段 ⑤ 代理可做的半边已完成：`memory-phase5` 测试 profile 真实启动成功（见下），覆盖率门禁逐文件阈值零错误（809/814 套件；一处 shipped-tool-catalog golden 就地修正；三个 Windows 沙箱套件为环境性失败），完整 web 通道的 node-harness 套件全部通过、其余 67 个失败全部落在已记录的环境族内。

**当前暂停点。** 阶段 ④ 已满足决策 16 的整轮提交要求：空候选不写，记忆回合创建唯一命名的新节点而不合并，scope 内日记条目按精确锚点双向链接，可选前序链接保留时间线，混合 scope 提交保持原子，配置时区日期已覆盖，`memory/distill` 只在校验后发布，聊天入口只指向节点。阶段 ⑤ 仍打开：先修复每 scope 下“日记记忆/节点记忆”筛选与 journal 列表能力，并裁决显式 `memory_write` 是否保持 node-only；随后 owner 再复测真实节点创建、节点→日记跳转、面板列出/读取/编辑/保存/删除、review 与设置即时生效。阶段 ⑤ 未关闭时不得开始 ⑥。

**⑤ 关闭后的续接步骤。** (1) 把本笔记转正为 implemented Agent Note：pair 移至 `.agents/notes/implemented/feature/`，`Status: implemented`，行文改为现在时，保留决策 1–16 并明确决策 16 的取代关系，跑 agent-note 分类/格式门禁并重录 pair。(2) 开始 ⑥：核对五包 npm 发布状态并补发缺失；新建 `@deepseek-ai/dsh-memory-bundle`（`dsh.bundle` 包 + 五行 patch）；在干净 `$DSH_HOME` 上 `dsh plugin --profile <test> add @deepseek-ai/dsh-memory-bundle`，以 `--dump-config` 验证，启动、确认面板出现，并确认 `remove` 干净——全部按 `docs/user/develop/basic/publish.md`。

**工作树清单（全部未提交，约 111 项；未经 owner 同意不得提交/清理）。** `packages/memory/*`（约 42：服务原语、`memory-local` list/delete、`memory-lifecycle` review+settings、`tool-memory` `memory_delete` 与 `updated` schema 修正、新包 `memory-remote` 承载 `memory` + `memoryReview.decide`）；`packages/client/*`（约 7：新包 `ui-memory`、`connection` fixture 的 memory Remote + `memoryReview/decide` + fx-alpha 回合 74/75/76 与收养日记、`web` 平台 zod 播种）；`packages/api/remotes` + `packages/host/apiproxy`（`memory/change` 转发白名单 + memory 类型边）；`packages/bundle/web-app`（ui-memory 行 + 依赖）；`packages/core/session`（`known-event-types` + `packages/core/tools/tests` 的 tool-catalog golden 修正）；`apps/web/tests`（assembled-boot 行 + `memory-panel.snapshot.ts` + `memory-review.snapshot.ts` + `memory-distill.snapshot.ts`）；生成文档（slot/config/cordis/persistence/tool 目录、doc-graphs、subsystems 双语页、`capability-seams`）；`tsconfig.base/client/host.json`（ui-memory paths 与 refs）；`scripts/verify-package-readme-model-experience.ts`；`pnpm-lock.yaml`（+ 备份 `pnpm-lock.yaml.bak-phase2`）；`.agents/notes`（本 pair + `.i18n.yaml`）；`.codebuddy/memory/*` 会话笔记。

**环境与工具坑（本窗口全部复核）。** Windows node 22 用 `$env:PATH = (Join-Path $env:APPDATA 'nvm\v22.21.1') + ';' + $env:PATH`；装依赖用 `corepack pnpm install --no-frozen-lockfile`（pnpm 11.7.0；普通 pnpm 10 会漂移 lockfile）；Playwright 浏览器未安装（浏览器 e2e 套件在 `browserType.launch` 失败）；`apps/web/tests/scaffold.ts` 把原始 Windows cwd 代入 JSON fixture 头（seed-fixture 套件解析失败）；三份 golden 有平台漂移（`pwsh` 对 `bash`、manifest 图标/主题字段、路径分隔符）；`hmr-live` 需要 dev:web 端口空闲（常被用户在用 `dsh web` 占用）。绝不要在 references 完整前单独跑 `tsc -b packages/client/ui-memory/tsconfig.json`——不完整的构建会把 `.d.ts`/`.d.ts.map` 排进相邻 `src` 树，令 `oxlint` 报数千错（如发生，删除这些 untracked 产物即可）。含中文的文件只用仓库 read/write/edit 工具改。`zod` 是播种的平台模块；`dsh-memory-remote` 自持其 `zod` 依赖。

**关键决策。** 决策 11–15 记录现有实现；决策 16 在点名处取代其蒸馏与面板列表假设，host 修正后阶段 ④ 已重新关闭。review 与 distill 注册仍随 presence 门控，但只有校验后的提交凭证可以产生 distill 节点。

**命令速查。** `pnpm exec vitest run packages/client/ui-memory`；聚焦覆盖用 `--coverage.include='packages/client/ui-memory/src/**' --coverage.reportsDirectory='.coverage-X'`；`DSH_SNAPSHOT=replay pnpm run test:web`（或先 `pnpm run build:lib:client` 再 `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/memory-*.snapshot.ts` 的组装子集）；`pnpm dsh --profile memory-phase5 --port 3180` 启动走查 profile（注意：`dsh web` 硬编码 `web` profile，要用通用 `--profile <name>` 形式）。

- **权威来源。** 本 PRD（决策日志 + 各定稿小节）是活记录；第一方提案是设计真源；Phase 2 笔记是已交付基线；四个 memory 包 README 是当前配置与局限；client 栈规矩在 `packages/client/AGENTS.md`、slot 标准笔记、web client 架构笔记与 settings-card/conversation-node 两篇 cookbook；分发路径遵循 `docs/user/develop/basic/publish.md`。
- **执行顺序。** 阶段 ①–④ 按序构建功能窗口（host 基础 → client 包 + 面板 + 卡片 → review client 半边 → 蒸馏提交流程 + 节点）；⑤ 是与 owner 一起的功能内测；⑥ 打包并测试 `dsh-memory-bundle` 安装链路；⑦ 对外发布在本窗口之外。决策 16 曾重新打开并随后重新关闭 ④；⑤ 仍暂停，owner 关闭 ⑤ 前不开始后续阶段。严格一次一个阶段：只有该阶段的开发、阶段测试与门禁全部通过才算关闭。
- **PRD 纪律。** 任何新增或修订的决策须追加进 `## Decisions log` 并同步更新本 pair 两册，然后重录：`pnpm exec tsx scripts/verify-translation-pairing.ts --write .agents/notes/proposed/feature/2026-08-18-memory-phase-3-ui-prd.md`。含中文的文件只用仓库 read/write/edit 工具改。
- **越界即停。** Phase 4 语义检索、dsh 内通用文件查看器、开源抽离均在范围外；任何超出已定界面的需求先停下问 owner。
- **环境（Windows）。** 用 node 22（`$env:PATH = (Join-Path $env:APPDATA 'nvm\v22.21.1') + ';' + $env:PATH`）。symlink-EPERM 用例（doc-sync 的 documentation site checks、sqlite 持久化）是环境性失败，不得"修复"；26 处 `rescope-vendor` 残留是既有项。
- **门禁。** client 包在逐文件 100% 覆盖率门禁内；一切可见 UI 变更需要 keyless 快照 + `pnpm run test:gui`（组装 web 输出变化时加 `DSH_SNAPSHOT=replay pnpm run test:web`）；双语文档 + i18n 记录；`doc-sync`/`typecheck`/`lint` 随改随跑。
- **惯例。** 新服务面守能力 seam 三角色；面板远端照 `message-feedback` 的 `@Remote` 一元模式；会话节点守 match/update 纪律（只看当前事件、不扫全量日志）；review 命令、删除与注入改动在同一批 PR 更新 Phase 2 笔记、第一方提案、事件语义与快照。
