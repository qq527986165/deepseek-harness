# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

记忆能力 seam 之上的面向模型工具：`memory_write`、`memory_read`、`memory_search` 与 `memory_traverse`。调用方会话的 cwd 解析作用域链（项目 vault 在前、全局在后）；提供方拥有全部存储细节。记忆工具调用与结果都是普通会话日志事件，因此记忆内容可从日志重建。

## Composition

每个包一行 cordis.yml，全部默认关闭：

```yaml
- name: '@deepseek-ai/dsh-memory'
  config: { dir: !!js require('node:path').join(process.env.DSH_HOME ?? '~/.dsh', 'memory') }
- name: '@deepseek-ai/dsh-memory-local'
- name: '@deepseek-ai/dsh-tool-memory'
```

只挂工具不挂服务时，条目保持等待；之后工具调用在无提供方注册时以 `NO_PROVIDER` 显式失败。

## Tools

| 工具 | 用途 |
|---|---|
| `memory_write` | 创建主题笔记或按 id 替换；`project`/`global` 作用域可显式指定或默认解析 |
| `memory_read` | 按 id 或精确标题读一篇笔记，含两个方向的链接 |
| `memory_search` | 作用域链上的排序全文命中，项目排前 |
| `memory_traverse` | 沿 `wikilink`/`related` 链接走一到两跳，双向，带悬空标记 |

## Model Experience

### Tool schemas

#### What the model sees

插件挂载期间，每次请求携带上述描述对应的四个工具 schema；生成的 schema 见[工具目录](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory)。`memory_write` 参数：`id?`、`scope?`、`title`、`content`、`tags?`、`related?`。`memory_search` 参数：`query`、`limit?`。

#### Token effect

可见期间四个固定 schema 随每次请求发送；本包 opt-in，默认不挂载。

#### KV Cache effect

插件与 schema 不变时前缀稳定。

### Tool results

#### What the model sees

写入结果说明笔记名、作用域与 vault 路径。读取结果渲染笔记正文加 `Related`/`Backlinks`/`Tags` 行。搜索结果渲染排序的 `title (scope): snippet` 行，或一条显式的空结果消息。遍历结果逐边渲染并带悬空标记与截断提示。

#### Token effect

每次调用一个结果块；大小随笔记正文、命中数与节点数变化，受提供方 `maxSearchResults`/`maxTraverseNodes` 上限约束。

#### KV Cache effect

结果仅在工具调用内；除已落日志的回合外无前缀影响。

## Known Limitations and Deferred Work

- **没有 `memory_delete` 工具** —— 删除是 Phase 3 的生命周期决策（审核、TTL、链接修复）；用户仍可直接编辑或删除 vault 文件。
- **没有自动召回注入** —— 工具是 Phase 1 唯一面向模型的接口；会话开始注入、每回合蒸馏与引导 section 在 Phase 2 到来。
- **精确标题查找** —— `memory_read`/`memory_traverse` 按 id 或精确标题解析；模糊标题匹配延期到 Phase 4 检索提供方。
