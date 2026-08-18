# memory/ — 记忆能力家族

[English](README.md) | 中文

第一方、默认关闭的记忆能力：两个 Obsidian 兼容的 markdown vault（一个全局、一个每项目），配派生的 SQLite 全文/链接索引、自动作用域解析、四个面向模型的工具与一套自动生命周期——会话开始注入上下文，并把每个完成的回合蒸馏进主题笔记与关联的日记。本家族实现[扩展手册](../../docs/cookbook/extension-cookbook.md)为记忆预留的形态——service seam 加模型工具——且不进入任何默认组合。

| 包 | 角色 | ctx key |
|---|---|---|
| [`memory/`](memory/README.md)（`@deepseek-ai/dsh-memory`） | Service Definition：唯一提供方注册、会话作用域解析、write/read/search/traverse 服务接口加生命周期原语 | `ctx.memory` |
| `memory-local`（`@deepseek-ai/dsh-memory-local`） | 文件优先提供方：`$DSH_HOME/memory/` 与 `<project>/.dsh/memory/` 下的 markdown vault、派生 SQLite FTS/链接索引、chokidar 对账、日记追加 | 注册于 `ctx.memory` |
| `tool-memory`（`@deepseek-ai/dsh-tool-memory`） | 四个模型工具：`memory_write`、`memory_read`、`memory_search`、`memory_traverse` | 注册于 `ctx.tools` |
| `memory-lifecycle`（`@deepseek-ai/dsh-memory-lifecycle`） | 自动生命周期：会话开始注入、watcher 重载、带作用域分类的每回合蒸馏、日记追加、`memory/*` 会话事件、引导 section | 消费 `ctx.memory`/`ctx.llm`/`ctx.systemPrompt` |

子系统参考——作用域、vault 布局、笔记格式与服务契约——见 [docs/subsystems/memory.md](../../docs/subsystems/memory.md)；设计与分期、被否决的替代方案见[第一方记忆 Agent Note](../../.agents/notes/proposed/feature/2026-08-18-first-party-pluggable-memory.md)。
