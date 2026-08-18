# @deepseek-ai/dsh-memory-lifecycle

[English](README.md) | 中文

记忆能力 seam 上的自动记忆生命周期消费方：会话开始上下文注入、已加载笔记的 watcher 驱动重载、带 `project`/`global` 作用域分类与日记追加的每回合蒸馏、`memory/inject` 与 `memory/distill` 会话事件，以及一段简短引导 section。插件从不改动主循环：它监听 `agent/session-start`、`session/event` 与 `memory/change`，并经 `agent.inject()` 注入。

## Composition

在记忆家族旁多加一行 cordis.yml：

```yaml
- name: '@deepseek-ai/dsh-memory'
  config: { dir: !!js require('node:path').join(process.env.DSH_HOME ?? '~/.dsh', 'memory') }
- name: '@deepseek-ai/dsh-memory-local'
- name: '@deepseek-ai/dsh-tool-memory'
- name: '@deepseek-ai/dsh-memory-lifecycle'
```

插件注入 `memory`、`llm` 与 `systemPrompt`，缺少任一服务的组合会在加载时失败。

## Config

| 字段 | 含义 | 默认 |
|---|---|---|
| `distill` | 是否蒸馏完成的回合 | `true` |
| `minTurnChars` | 参与蒸馏的最小回合非空白字符数 | `40` |
| `maxDistillTokens` | 每回合辅助蒸馏输出 token 上限 | `1024` |
| `distillTimeoutMs` | 辅助蒸馏端到端截止时间，毫秒 | `30000` |
| `provider` / `model` | 可选显式辅助路由；必须成对提供，否则复用会话最近一次已路由请求 | 未设置 |
| `maxInjectBytes` | 会话开始注入上下文的完整 UTF-8 字节上限 | `16384` |
| `recentNoteCount` | 注入上下文中的项目主题笔记数，最新在前 | `10` |

## Behavior

- **会话开始注入。** 在 `agent/session-start` 时插件读取各作用域的 `MEMORY.md` 加项目近期窗口，作为一条字节封顶的上下文消息注入；对应的 `memory/inject` 事件记录加载的文件、原因与字节数。日记从不进入注入集合。
- **Watcher 重载。** 当 `memory/change` 报告某 agent 注入集合中的文件（空批次表示就绪全量对账）时，插件重建上下文并注入新版本——内容相同则不重复注入。
- **每回合蒸馏。** 在 `turn/end` 时一次非阻塞辅助调用复用该回合的系统提示、工具与消息作为前缀，尾部追加蒸馏指令，使提供方的 KV 缓存保持温热。一次调用产出候选主题笔记——事实、决策、偏好——每条在同一回复中分类为 `project` 或 `global`，外加一条链接所触笔记的日记条目。
- **合并而非重述。** 标题命中其作用域内已有笔记的候选只追加新事实并合并标签/链接；与现有正文完全重复的候选不写入。仅全局会话中的 project 分类候选落入全局 vault。
- **日记追加。** 回合的日记条目经提供方的独占链追加到当天的 `journal/YYYY-MM-DD.md`，并发会话串行化而不会损坏文件。
- **写入记录。** 每次提交写入后，该次蒸馏追加一条 `memory/distill` 事件，点名笔记、日记条目与辅助路由；部分提交后失败的蒸馏记录已提交前缀与错误。一无所写时仅记一条警告日志。
- **引导 section。** 一段简短的 `tool:memory` 提示 section 告诉模型：在假定记得过往上下文前先查阅记忆，在被要求或产生持久事实时显式写入。

## Model Experience

### Injected context

#### What the model sees

每次注入一条 user 角色消息：一个 `Memory context` 块，每个作用域的人设笔记置于 `## Persona (<scope>)` 标题下，随后是 `## Recent project notes` 一节，最多 `recentNoteCount` 条主题笔记（标题与正文）。字节上限截断文本时会附加截断标记。

#### Token effect

受 `maxInjectBytes`（默认 16 KiB）约束；watcher 重载只在加载内容实际变化时注入。

#### KV Cache effect

注入上下文是进入回合批次的一条用户消息；仅当内容变化时才移动前缀。

### Guidance section

#### What the model sees

`tool:memory` 系统提示 section，渲染在工具引导区间（order 114）。

#### Token effect

插件挂载期间每个请求一个固定段落。

#### KV Cache effect

section 文本不变时前缀稳定。

## Known Limitations and Deferred Work

- **过慢的首次注入可能错过第一个请求** —— 会话开始注入与其他会话开始上下文生产方一样是异步的；第一个请求通常会包含它，但缓慢的 vault 读取可能使其落到下一步。
- **辅助调用跟随已路由模型** —— 未配置 `provider`/`model` 时蒸馏调用复用会话最近一次已路由请求；部署成本策略归属该路由。
- **模型质量上限** —— 分类器与日记叙事都是模型输出；错误或过时的笔记经 Obsidian 编辑或 Phase 3 的审核流程修正。
- **没有召回窗口增长策略** —— 笔记无 TTL 地累积；Phase 3 生命周期策略拥有清理。
