# @deepseek-ai/dsh-memory-remote

[English](README.md) | 中文

面向浏览器的记忆传输：记忆能力 seam 之上的会话无关 `memory` Typert Remote 命名空间（`list`、`read`、`search`、`write`、`delete`、`info`），以及会话寻址的 `memoryReview` 命名空间，其 `decide` 依据活跃会话日志校验一次 review，并把被接受的笔记从项目 vault 升级到全局 vault。仅在 web 组合中挂载；没有它，浏览器半边（`ui-memory`）自我隐藏，Phase 2 照常工作。

## Composition

该行仅加入 web 组合中的记忆家族：

```yaml
- name: '@deepseek-ai/dsh-memory'
  config: { dir: !!js require('node:path').join(process.env.DSH_HOME ?? '~/.dsh', 'memory') }
- name: '@deepseek-ai/dsh-memory-local'
- name: '@deepseek-ai/dsh-tool-memory'
- name: '@deepseek-ai/dsh-memory-lifecycle'
- name: '@deepseek-ai/dsh-memory-remote'
```

服务注入 `memory` 与 `agents`；gateway 从挂载的服务发现两个命名空间，client 侧远端组装挂载生成的贡献，因此 `ctx.remote.memory` 恰在宿主组合此行时存在。

## Namespaces

| 命名空间 | 方法 | 寻址 |
|---|---|---|
| `memory` | `info()`、`list`、`read`、`search`、`write`、`delete` | 会话无关；项目请求携带经服务作用域链解析的显式 `workspaceDir`（非注册路径以 `NO_PROJECT_SCOPE` 失败） |
| `memoryReview` | `decide(sessionId, reviewId, decisions)` | 会话寻址；依据活跃会话日志校验 |

## Behavior

- **一元约定。** 每个方法接受一个请求对象（`decide` 接受会话 id、review id 与决策集），返回 JSON 结果；`decide` 上预期的业务失败是带稳定错误码的结果联合（`review-not-found`、`review-decided`、`unknown-candidate`、`duplicate-candidate`、`undecided-candidates`、`note-missing`），服务级失败则呈现为远端错误。
- **面板变更是控制台用户的行为。** `list`/`read`/`search`/`write`/`delete` 直接执行、无审批 seam——审批机制要求活跃 agent 回合，而会话无关的面板操作不得依赖它——且不记录会话事件：vault 文件加索引即记录，与外部 Obsidian 编辑完全一致。
- **升级是 move。** `decide` 要求确切的活跃 agent、匹配的 `memory/review` 事件与其候选集的精确划分。每条被接受的笔记升级 = 读项目笔记 → 写全局笔记 → 彻底移除项目文件——先写后删，失败绝不留下缺失内容——结算向会话日志追加 `memory/review-decided`。
- **决策按会话串行化。** 同一会话上的并发 `decide` 调用一次只跑一个，因此 review-decided 检查与升级提交不会交错。
- **缺席即缺席。** 没有此行的 web 组合不提供任何 `memory/*` 描述符；浏览器检测到缺失的命名空间服务并隐藏面板入口——绝不报错。

## Model Experience

间接作用，通过用户决定一次 review 时由 chat 节点渲染的 `memory/review-decided` 结算事件：本服务不注册工具、也不注入自己的提示词文本，即以此方式对模型可见。

#### KV Cache effect

无直接影响；前缀影响由生命周期的辅助调用承担。

## Known Limitations and Deferred Work

- **仅活跃会话** —— `decide` 追加到活跃会话日志；冷（仅持久化）会话中的 review 在会话恢复前无法决定。
- **无恢复原语** —— 面板删除把文件移入同级回收文件夹，但恢复它们是一次手动文件移动；watcher 重新收养它们。
- **提供方缺席会渲染面板** —— 组合了此行但未注册提供方时，浏览器显示友好的"提供方未挂载"横幅而非列表；远端本身报告 `NO_PROVIDER`。
