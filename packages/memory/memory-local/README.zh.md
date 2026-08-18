# @deepseek-ai/dsh-memory-local

[English](README.md) | 中文

文件优先记忆提供方：Obsidian 兼容的 markdown vault，配派生的 SQLite 全文/链接索引与 chokidar 对账。每个目录成为一个 vault handle，其写入与对账都在单条独占操作链上执行。markdown 文件是权威数据；索引是可重建的派生状态。

## Config

| 字段 | 含义 | 默认 |
|---|---|---|
| `watch` | 监视每个 vault 并对账外部编辑 | `true` |
| `debounceMs` | watcher 写入静默窗口，毫秒 | `100` |
| `maxSearchResults` | 搜索条数上限 | `20` |
| `maxTraverseNodes` | 遍历节点上限 | `50` |

## Behavior

- **两种 vault 形态。** 服务把显式目录交给本提供方：全局 vault 在 `$DSH_HOME/memory/`，项目 vault 在 `<project>/.dsh/memory/`。两者都是可用 Obsidian 直接打开的普通文件夹：`MEMORY.md`、`notes/` 主题笔记，以及可收养的 `journal/`。
- **笔记即 markdown。** 提供方写入存储 frontmatter（`id`、`scope`、`title`、`created`、`updated`、`tags`、`related`）加正文；正文中的 `[[wikilinks]]` 与 frontmatter 的 `related` 条目成为带类型的链接行。没有我方 frontmatter 的文件以确定的 `adopted:<path>` 身份被收养，因此任何已存在的 markdown 文件夹都成为可搜索的记忆。
- **索引是派生状态。** `.memory-index.sqlite` 存放笔记行、可双向查询的 `links` 表与 FTS5 表。schema 版本不匹配或索引文件被删会全量重建；索引从不凌驾于文件之上。
- **外部编辑会对账。** 带 settings-file 纪律的 chokidar watcher（防抖、就绪全量对账、错误隔离、关闭前静稳）保持索引新鲜；读取时还会复查 mtime，删除会清掉行。
- **有界结果。** 搜索最多返回 `maxSearchResults` 条命中（显式的更低 `limit` 会被遵守，非法值显式失败）；遍历最多返回 `maxTraverseNodes` 个节点并如实给出 `truncated` 标志。
- **卸载后数据存活。** dispose 停止 watcher、排空操作链、关闭数据库；vault 文件与索引文件留在磁盘上，重新挂载即恢复召回。

## Model Experience

间接作用，经由 `tool-memory` 消费方：本提供方不注册工具、不注入提示词文本，只服务四个 service 操作。

#### KV Cache effect

无直接影响；工具消费方拥有任何模型可见接口。

## Known Limitations and Deferred Work

- **Phase 1 只有主题笔记** —— 提供方写入 `notes/` 主题笔记；日记条目由 Phase 2 的蒸馏监听器写入，不过收养的日记文件已被索引并可搜索。
- **只有 FTS 召回** —— 搜索匹配精确词元与短语，不匹配语义等价表述；embedding 检索提供方是延期的 Phase 4 插槽。
- **无删除与 TTL** —— `memory_delete` 与生命周期策略（审核、TTL、链接修复）在 Phase 3 到来；文件仍可手工或经 Obsidian 删除，watcher 会清掉对应行。
- **全量对账会扫描 vault** —— 很大的被收养文件夹会让打开与就绪对账变慢；其间增量 watcher 批次已避免重复扫描。
