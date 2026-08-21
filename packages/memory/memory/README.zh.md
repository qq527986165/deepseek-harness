# @deepseek-ai/dsh-memory

[English](README.md) | 中文

记忆能力 seam：唯一提供方注册、会话作用域解析、write/read/search/traverse 服务接口，以及生命周期与面板原语（人设读取、项目近期窗口、按作用域精确查找、日记追加、vault 列表与软删除）。服务拥有产品规则——会话可以触达哪些 vault——而注册的提供方拥有每个 vault 内的文件布局与索引。存储是文件优先的 markdown，可在 Obsidian 中编辑、可在 git 中做 diff。

## Config

| 字段 | 含义 | 默认 |
|---|---|---|
| `dir` | 全局 vault 目录 | harness home 下的 `memory/` |
| `dshHome` | 省略 `dir` 时使用的 harness home | `$DSH_HOME` 或 `~/.dsh` |

## Behavior

- **唯一提供方。** `register(provider)` 只接受一个提供方；第二次注册失败。dispose 会关闭注册并等待每个在途操作结束，之后其他提供方才可注册。
- **作用域解析。** cwd 匹配已注册 workspace 时 `resolveScopes(cwd)` 返回 `['project', 'global']`，否则返回 `['global']`；缺少 workspace 注册表、未注册路径或注册表故障都会降级为只有全局。
- **写入路由。** `scope: 'project'` 的写入解析 `<cwd>/.dsh/memory/` 下的项目 vault，在已注册 workspace 之外以 `NO_PROJECT_SCOPE` 失败；`scope: 'global'` 的写入永远指向配置目录。
- **生命周期原语。** `readPersona(scope, cwd)` 完整读取某个 vault 的 `MEMORY.md`；`recent(opts, cwd)` 按最新在前列出项目 vault 的主题笔记；`readInScope(ref, scope, cwd)` 在恰好一个 vault 内解析；`appendJournal(input, cwd)` 在提供方的独占链上向某天的日记文件追加一条条目；`commitDistill(groups, cwd)` 先解析所有参与作用域，再委托一次原子的整轮节点与日记提交。
- **面板原语。** `list(scope, cwd, opts)` 返回单个 vault 的可列表行——persona 置顶，随后是 `notes/` 笔记按 `updated` 倒序，日记排除；`searchInScope(query, opts, scope, cwd)` 在恰好一个 vault 内跑全文检索；`delete(ref, scope, cwd, opts)` 把一篇笔记软删入同级回收文件夹（或以 `permanent` 模式彻底移除），并清理索引与入向链接；`info()` 报告配置的全局 vault 目录。
- **变更上报。** 注册的提供方在每次 watcher 驱动的 vault 对账后发出 `memory/change` 事件，携带 vault 目录与相对其变更的文件。
- **失败词汇。** 操作以 `MemoryError` 显式失败，错误码为 `DUPLICATE_PROVIDER`、`NO_PROVIDER`、`NO_PROJECT_SCOPE` 与 `NOT_FOUND`。
- **天然可插拔。** 服务只经显式 `cordis.yml` 行挂载；消费方通过 `ctx.get('memory')` 读取。

## Model Experience

间接作用，经由 `tool-memory` 消费方：本服务不注册工具、不注入提示词文本，只把模型工具调用路由给提供方。

#### KV Cache effect

无直接影响；工具消费方拥有任何模型可见的 schema 成本。

## Known Limitations and Deferred Work

- **每宿主一个提供方** —— 唯一提供方规则阻止两个记忆系统共存于一个宿主；需要多个存储的部署改为挂载多个不同 `dir` 的插件实例。
- **作用域解析受 workspace 门槛约束** —— 已注册 workspace 之外的会话只有全局记忆；不经 workspace 注册的自动每目录项目 vault 属延期项。
- **直接追加的日记日期使用 UTC** —— 调用方未给日期时，`appendJournal` 默认使用 UTC 日；自动蒸馏会传入按 `memory-lifecycle.timeZone` 选择的日期，该配置默认取主机时区。
- **删除默认是软删除** —— 文件落入同级回收文件夹，恢复是手动移动文件；尚无恢复原语或回收保留策略。
