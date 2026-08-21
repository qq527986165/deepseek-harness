# @deepseek-ai/dsh-memory-lifecycle

[English](README.md) | 中文

记忆能力 seam 上的自动记忆生命周期消费方：会话开始上下文注入、已加载笔记的 watcher 驱动重载、带 `project`/`global` 作用域分类与日记追加的每回合蒸馏、`/memory-review` 升级流程、`memory/inject`、`memory/distill`、`memory/review` 与 `memory/review-decided` 会话事件、一段简短引导 section，以及 settings 命名空间的 host 半边。插件从不改动主循环：它监听 `agent/session-start`、`session/event` 与 `memory/change`，并经 `agent.inject()` 注入。

## Composition

在记忆家族旁多加一行 cordis.yml：

```yaml
- name: '@deepseek-ai/dsh-memory'
  config: { dir: !!js require('node:path').join(process.env.DSH_HOME ?? '~/.dsh', 'memory') }
- name: '@deepseek-ai/dsh-memory-local'
- name: '@deepseek-ai/dsh-tool-memory'
- name: '@deepseek-ai/dsh-memory-lifecycle'
```

插件注入 `memory`、`llm` 与 `systemPrompt`，缺少任一服务的组合会在加载时失败。review 命令仅在命令注册表被组合时注册，settings 命名空间仅在 settings 服务被组合时注册；两者都不是必需的。

## Config

| 字段 | 含义 | 默认 |
|---|---|---|
| `distill` | 是否蒸馏完成的回合 | `true` |
| `distillMode` | 辅助调用使用哪条固定蒸馏指令：`concise` 或 `detailed` | `concise` |
| `minTurnChars` | 参与蒸馏的最小回合非空白字符数 | `40` |
| `maxDistillTokens` | 每回合辅助输出 token 上限（隐藏熔断器，同样作用于 review 调用） | `2048` |
| `distillTimeoutMs` | 辅助调用端到端截止时间，毫秒 | `30000` |
| `provider` / `model` | 可选显式辅助路由；必须成对提供，否则复用会话最近一次已路由请求 | 未设置 |
| `timeZone` | 选择蒸馏日记日期的 IANA 时区 | 主机时区 |
| `maxInjectBytes` | 会话开始注入上下文的完整 UTF-8 字节上限 | `16384` |
| `maxReviewCandidates` | 一次 `/memory-review` 提议的项目→全局升级候选上限 | `5` |
| `reviewAfterDays` | 面板给笔记打审核标记的龄期天数 | `30` |

settings 卡片经 `memory-lifecycle` settings 命名空间编辑 `distill`、`distillMode`、`minTurnChars`、`maxInjectBytes`、`maxReviewCandidates` 与 `reviewAfterDays` 并即时生效；token 上限、超时与路由仍属 `cordis.yml` 中的部署配置。

## Behavior

- **会话开始注入。** 在 `agent/session-start` 时插件完整读取各作用域的 `MEMORY.md`，外加每个作用域的笔记目录（标题、tags、更新日期、首行摘录，最新在前），作为一条字节封顶的上下文消息注入；对应的 `memory/inject` 事件记录加载的文件、原因与字节数。日记从不进入注入集合。
- **Watcher 重载。** 当 `memory/change` 报告某 agent 注入集合中的文件（空批次表示就绪全量对账）时，插件重建上下文并注入新版本——内容相同则不重复注入。
- **每回合蒸馏。** 在 `turn/end` 时一次非阻塞辅助调用复用该回合的系统提示、工具与消息作为前缀，尾部追加蒸馏指令，使提供方的 KV 缓存保持温热。一次调用产出候选主题笔记——事实、决策、偏好——每条在同一回复中分类为 `project` 或 `global`，外加一条链接所触笔记的日记条目。
- **增量新节点。** 每条值得沉淀的候选都创建带短 ID 后缀的新节点。同标题前序节点保持不变，新节点链接其精确路径；仅全局会话中的 project 分类候选落入全局 vault。
- **原子日记提交。** 一轮按已解析作用域分组，并把所有参与 vault 作为整体提交。每组向配置时区当天的 `journal/YYYY-MM-DD.md` 追加一条带精确锚点的条目；新节点与条目按精确路径和锚点双向链接，且链接不跨 vault。
- **提交凭证。** 仅当文件、索引行、读取与链接全部验证后，该次蒸馏才追加一条 `memory/distill` 凭证，点名新节点、每个参与作用域的一条日记条目及辅助路由。零候选不写节点、日记或事件；任何提交前失败都回滚整轮且不发凭证。
- **`/memory-review`。** 命令对项目 vault 的笔记目录跑一次辅助调用，提议受 `maxReviewCandidates` 约束的项目→全局升级候选；提议以日志独有的 `memory/review` 事件落定，并由会话节点渲染。命令无参数、要求项目工作区，经 `memoryReview.decide` 遥控结算，后者追加 `memory/review-decided`。
- **引导 section。** 一段简短的 `tool:memory` 提示 section 告诉模型：在假定记得过往上下文前先查阅记忆，在被要求或产生持久事实时显式写入。

## Model Experience

### Injected context

#### What the model sees

每次注入一条 user 角色消息：一个 `Memory context` 块，每个作用域的人设笔记置于 `## Persona (<scope>)` 标题下，随后是 `## Memory note catalog` 一节，其条目渲染标题、作用域、tags、更新日期与首行摘录。字节上限截断文本时会附加截断标记。

#### Token effect

受 `maxInjectBytes`（默认 16 KiB）约束；watcher 重载只在加载内容实际变化时注入。目录用字节换广度——模型经 `memory_read` 按需取整篇笔记内容。

#### KV Cache effect

注入上下文是进入回合批次的一条用户消息；仅当内容变化时才移动前缀。

### Guidance section

#### What the model sees

`tool:memory` 系统提示 section，渲染在工具引导区间（order 114）。

#### Token effect

插件挂载期间每个请求一个固定段落。

#### KV Cache effect

section 文本不变时前缀稳定。

### Distillation and review instructions

#### What the model sees

每次辅助调用的最后一条 user 消息：`distillMode` 选定的两条固定蒸馏指令之一（两段文本均由测试逐字钉住），或固定 review 指令加项目笔记目录。

#### Token effect

仅限辅助调用内；受 `maxDistillTokens` 约束。

#### KV Cache effect

蒸馏调用是已路由请求的真前缀，因此提供方的 KV 缓存保持温热。

## Known Limitations and Deferred Work

- **过慢的首次注入可能错过第一个请求** —— 会话开始注入与其他会话开始上下文生产方一样是异步的；第一个请求通常会包含它，但缓慢的 vault 读取可能使其落到下一步。
- **辅助调用跟随已路由模型** —— 未配置 `provider`/`model` 时蒸馏调用复用会话最近一次已路由请求；部署成本策略归属该路由。
- **模型质量上限** —— 分类器与日记叙事都是模型输出；错误或过时的笔记经 Obsidian 编辑或 Phase 3 的审核流程修正。
- **无自动删除** —— `reviewAfterDays` 只在面板中标记陈旧笔记；删除它们仍是人的决定。
