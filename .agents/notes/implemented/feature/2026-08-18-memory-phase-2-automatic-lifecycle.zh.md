# Agent Note：记忆 Phase 2 —— 自动生命周期与日记追加原语

Status: implemented

[English](2026-08-18-memory-phase-2-automatic-lifecycle.md) | 中文

## Problem

[第一方记忆提案](../../proposed/feature/2026-08-18-first-party-pluggable-memory.md)预先冻结了 Phase 2 的四个行为——会话开始自动加载、带作用域分类的每回合蒸馏、`memory/*` 会话事件与引导 section——但留下一个接口未定：向某天的日记文件追加条目需要 Phase 1 的 `write`（"按 id 整体替换"）无法表达的原语。日记追加还必须经提供方的独占链串行化，否则两个并发蒸馏的会话会损坏同一天的文件。此外，Phase 1 的真实 chokidar watcher 实际忽略了所有子目录（其 `ignored` 谓词过滤掉一切非 `.md` 路径，而 chokidar 传给谓词的目录路径不带 stats），因此 vault 子文件夹从未被真正监视。

## Decision

Phase 2 交付四个包层面的改动：服务与提供方原语、新的 `dsh-memory-lifecycle` 消费方包、两个 `memory/*` 会话事件、一个 Cordis 事件与一段引导 section。提案冻结的四个行为按原样实现、未加宽；日记追加是唯一新设计的接口。

### 日记追加原语

`ctx.memory.appendJournal(input, cwd, signal?)` 是服务级方法，与 `write` 完全一致地按 `input.scope` 路由（`project` 要求已解析的 workspace）。提供方在目标 vault 的单条独占链上执行：读取当天的 `journal/YYYY-MM-DD.md`（不存在时以 `type: journal` frontmatter 创建），追加一条 `## heading` 加 markdown 正文的条目，写回文件，并以 `adopted:journal/<date>.md` 身份重新索引。日期默认为 UTC 当日并按真实日历日校验；标题必须是单行非空，正文非空。并发追加因此串行化而非交错。

生命周期所需的其他读取成为并行的服务原语：`readPersona(scope, cwd)` 完整读取某 vault 的 `MEMORY.md`，`recent(opts, cwd)` 按最新在前列出项目 vault 的主题笔记，`readInScope(ref, scope, cwd)` 在恰好一个 vault 内解析。`MemoryProvider` 还拥有 `commitDistill`，供新节点及其日记条目走整轮原子提交路径。

### `memory-lifecycle` —— 自动化消费方

`@deepseek-ai/dsh-memory-lifecycle`（`packages/memory/memory-lifecycle/`）注入 `memory`、`llm` 与 `systemPrompt`；所有贡献都是 effect，因此 dispose 插件 fiber 会移除每个监听器与 section 注册，中止在途工作并排空。配置字段：`distill`、`distillMode`（`concise` 默认 | `detailed`；选择两条固定蒸馏指令之一）、`minTurnChars`、`maxDistillTokens`（默认 2048）、`distillTimeoutMs`、成对可选的 `provider`/`model`、`timeZone`（IANA，默认主机时区）、`maxInjectBytes`、`maxReviewCandidates`（默认 5）与 `reviewAfterDays`（默认 30）。六个用户持有的旋钮（`distill`、`distillMode`、`minTurnChars`、`maxInjectBytes`、`maxReviewCandidates`、`reviewAfterDays`）注册为 `memory-lifecycle` settings namespace 并即时生效；token 上限、超时、路由与时区仍属组合配置。

- **会话开始。** `agent/session-start` 监听器完整读取每个已解析作用域的 `MEMORY.md`，外加每个作用域的笔记目录（标题、tags、更新日期、首行摘录，最新在前），组装一份上下文文本并交给 `agent.inject()`——注入内容走普通 `user/message` 日志事件，日志独有的 `memory/inject` 事件记录加载的文件、原因（`start`/`change`）与字节数。字节上限作用于含截断标记在内的完整组装文本；日记从不进入该集合，因为列表跳过日记行。
- **Watcher 重载。** `memory-local` 把每次 watcher 驱动的对账上报为 `memory/change` Cordis 事件（vault 目录加相对 vault 的变更路径；空批次表示就绪全量对账）。生命周期跟踪每个 agent 的注入文件，在已加载文件变更时重建上下文；与上次注入文本的内容相等判定使无变化的重建成为空操作，也让就绪对账无害。
- **每回合蒸馏。** `turn/end` 监听器发起一次非阻塞辅助 `ctx.llm.stream()` 调用，其消息重放完成的回合（系统提示、工具 schema 与 surface 消息），尾部追加蒸馏指令——调用是已路由请求的真前缀，提供方的 KV 缓存保持温热（`purpose: 'memory-distill'`，在 `llm-deepseek` 中映射为关闭思考）。一次回复产出候选主题笔记，每条在同一回复中分类为 `project`/`global`，外加一条日记条目；仅全局会话中的 project 分类候选降级到全局 vault。
- **增量原子提交。** 每条值得沉淀的候选都创建带短 ID 后缀的新节点；同标题前序节点保持不变，并可按精确路径链接。host 按已解析作用域分组，把所有参与 vault 作为整体提交，每个作用域有一条带精确锚点的日记条目及精确双向链接。日记日期取配置的 IANA 时区，未配置时回退主机时区。
- **提交凭证。** 仅当所有文件、索引行、读取与链接都验证成功，该次蒸馏才追加 `memory/distill`，点名新节点、每个参与作用域的一条日记条目及辅助路由。零候选不写节点、日记或事件；提交前失败会恢复整轮且不发凭证。配套 invariant 在 append 的提交前分发阶段校验每条 `memory/*` 记录，坏记录拒绝 append 而非破坏重建。
- **Review 命令。** `memory-review` 命令（仅在命令注册表被组合时注册）对项目笔记目录跑一次辅助调用，提议受 `maxReviewCandidates` 约束的项目→全局升级候选，以日志独有的 `memory/review` 事件落定，并把命令结果指向该事件；`memoryReview.decide` 遥控依据活跃会话日志校验决策，以写优先升级被接受的笔记，并追加 `memory/review-decided`。
- **引导 section。** 一段简短的 `tool:memory` section（order 114）告诉模型：在假定记得过往上下文前先查阅记忆，在被要求或产生持久事实时显式写入。

### Watcher 修复

`VaultWatcher.ignored` 现在只排除索引文件与 `.obsidian/`；markdown 过滤移入 `all` 事件处理器，丢弃 `addDir`/`unlinkDir` 事件与非 `.md` 路径。谓词以 unix 归一化路径比较，因为 chokidar 传给谓词的是归一化路径。对账现在对原生分隔符的遍历条目与绝对 watcher 批次都存储相对 vault 的前向斜杠路径，使 `notes/` 前缀查询与碰撞检查在 Windows 上保持一致。

## Consequences

Phase 2 验收标准第 10 条由回放驱动的组装覆盖钉死：真实 `cordis.yml` 经 Loader 启动 memory 包，并以脚本化 adapter 驱动真实 agent-loop 回合，展示两份人设注入、零候选无写入且无事件、项目/全局提交凭证带新节点与 scope 内日记条目、同标题前序链接、配置日历日选择，以及只凭 `memory/distill` 重建节点且日记不在注入集合。提供方、服务与生命周期包各自达到逐文件 100% 覆盖率，包括 HMR/disposal 证明：卸载生命周期 fiber 会移除其监听器与 section 并中止在途工作。

## Testing

- **服务与提供方：** `readInScope`/`readPersona`/`recent`/`appendJournal` 的作用域路由（含 `NO_PROJECT_SCOPE` 与 `NO_PROVIDER`）、日记日期/标题/正文校验、并发追加串行进同一天的文件、收养笔记的近期正文、带相对 vault 路径的 watcher 批次上报，以及真实 chokidar 的 `memory/change` 发出。
- **生命周期：** 注入组装的多字节截断字节上限、日记排除、watcher 重载去重、蒸馏路由解析、回合消息收集、最小长度门槛、JSON 回复解析与校验、零候选无操作、作用域降级、整轮原子提交与凭证门控、配置日历日选择、监听器卸载，以及 dispose 排空在途工作。
- **回放验收：** 上述第 10 条组装测试。
- **Invariant：** 良构 `memory/*` 记录通过；空凭证或交叉引用不一致等畸形蒸馏凭证在 append 处被拒。

## Alternatives considered

**在提供方的 `write` 内追加。** 否决：`write` 按 id 替换、由标题派生主题笔记路径；日记文件按日期命名、只追加，且不应以笔记身份铸造。

**生命周期自持文件 I/O。** 否决：生命周期消费方不知道 vault 目录——服务拥有会话可以触达哪些 vault——且在提供方独占链之外写入会重新引入交错损坏。

**为分类器增加第二次模型调用。** 否决：提案固定每回合一次调用，且分类器所需上下文不超过蒸馏本身。

**host 侧合并或子串抑制。** 否决：模型只提议新的持久事实，host 对每个接受候选始终创建新节点。相关事实通过可选前序链接保留时间线，而不是合并旧文件或抑制同标题候选。

## Risks

**蒸馏成本跟随已路由模型。** 每回合一次辅助调用复用会话已路由的 provider/model，除非配置覆盖；token 上限与最小长度门槛约束成本，配置开关可完全关闭。

**静默的错误记忆。** 自动写入的笔记是模型输出；当前修正路径是 Obsidian 编辑，未来是 Phase 3 的审核流程。无论怎样，`memory/distill` 写入记录使每次静默变更可重建。

**Watcher 重载噪声。** 已加载文件的变更会重新注入整份上下文消息；内容相等判定让无变化的重建保持静默，但注入笔记的频繁编辑仍会反复呈现——与 AGENTS.md 变更模式同等的取舍。
