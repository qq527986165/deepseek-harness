# @deepseek-ai/dsh-client-ui-memory

[English](README.md) | 中文

记忆特性的浏览器半边：`memory` Remote（`info`、`list`、`read`、`search`、`write`、`delete`）之上的侧边栏底栏按钮与 `shell.overlay` 抽屉，memory-lifecycle 设置卡（命名空间 `memory-lifecycle`），以及两个会话节点——会话寻址的 `memoryReview.decide` Remote 之上的 `memory-review` 节点、log-only `memory/distill` 写入记录之上的 `memory-distill` 节点。面板用作用域标签页列出两个 vault，带项目工作区选择器、排序搜索与紧凑双行列表；笔记打开进 `MarkdownText` 阅读视图，旁边展示反向链接、已解析与悬空链接标记，编辑是字段式表单——保存前重新读取，遇到并发修改时显示变更时间提示。删除先确认，然后软删除到 vault 旁侧的回收文件夹。回顾节点把一次 `/memory-review` 提议渲染成候选卡片，带逐卡接受/拒绝与跳面板 chip；一次显式确认提交整次回顾，追加的 `memory/review-decided` 把每张卡翻到已决标记。蒸馏节点把一条已提交凭证渲染成每个真实节点一个 chip，绝不渲染日记、进度、失败或部分写入 chip。

## 组合

该行默认随 web-app bundle 发布，在主机组合缺少记忆 remote 时自我隐藏：

```yaml
- id: ui-memory
  name: '@deepseek-ai/dsh-client-ui-memory'
```

存在性靠启动时一次 `memory.info()` 探测（经网关的命名空间服务）；缺失即无痕迹（没有底栏按钮、没有抽屉），重连后重新探测。remote 已组合但没有注册存储提供方时，面板显示友好的「提供方未挂载」横幅。

## 行为

- **四级降级。** 没有任何记忆行，或有记忆行但无 `memory-remote`，都不渲染痕迹（没有底栏按钮、没有抽屉、没有会话节点）；有 `memory-remote` 但无提供方，显示横幅；全部组合齐全，渲染完整面板与两个节点。设置卡始终注册，主机不提供 `memory-lifecycle` 命名空间时插件标签页跳过它。
- **控制台用户即权威。** 面板的读写直接经 remote 执行、没有审批 seam——控制台用户就是权威，服务层检查（唯一提供方、工作区门控的项目作用域）是边界。面板修改不记录会话事件：vault 文件加索引就是记录。
- **转发对账。** 转发的 `memory/change` 事件在目录匹配当前 vault 时重载活动列表，让外部 Obsidian 编辑与 watcher 对账实时反馈到 UI。
- **作用域寻址。** 项目标签页通过选中的已注册工作区目录列出；目录缺失或未注册时保持空闲，而不是把 `NO_PROJECT_SCOPE` 抛到界面上。节点驱动的打开请求携带回顾的 `workspaceDir` 或蒸馏节点的会话 cwd，跳转精确落在对应项目 vault。
- **冲突感知保存。** 保存前重新读取笔记；`updated` 时间戳变化会拦截一次写入并显示「打开后已被修改」提示，再次保存即提交（覆盖）。收养文件（`adopted:*` 身份、日记打开）只读渲染，没有编辑与删除按钮。
- **暂存式回顾提交。** 回顾节点把 `memory/review` 起点与 `memory/review-decided` 更新折叠进以品牌 `reviewId` 为键的同一个 Context。接受/拒绝与全部接受只暂存一个 partition；确认按钮在每位候选都已决定前不可用，最后一次误点不可能提交升级。业务失败（回顾不存在、已处理、未知/重复候选、尚有未决、笔记缺失）各自渲染一行。
- **单事件蒸馏折叠。** 蒸馏节点以 `event.seq` 为键、每条已提交 `memory/distill` 凭证一个 Context——事件自带完整且已校验的检查点，节点仅凭日志即可重建、没有 update 路径。它为每个真实已提交节点渲染一个 chip；每个 chip 打开精确的“节点记忆”文档。日记条目经节点内来源链接到达，空回合或失败回合不产生蒸馏节点。

## 设置卡

卡片编辑 memory-lifecycle 命名空间的六个用户旋钮——`distill`、`distillMode`、`minTurnChars`、`maxInjectBytes`、`maxReviewCandidates`、`reviewAfterDays`——经带修订栅栏的 settings scope 写入，并展示来自 `memory.info()` 的只读全局 vault 目录。改动即时生效：lifecycle 每次使用都重读其解析后的配置。

## Model Experience

间接影响，经由本面板驱动的 host 半边：设置写入会进入 memory-lifecycle 的解析后配置（注入内容与蒸馏），面板修改不追加会话事件。回顾节点消费日志独有的 `memory/review` 与 `memory/review-decided` 事件，并驱动 `memoryReview.decide`；decide remote 的升级流程（读取项目 → 写入全局 → 删除项目）从不进入模型请求。

#### KV Cache effect

无直接失效；生命周期的辅助调用负责自己的前缀影响。

## Known Limitations and Deferred Work

- **仅内存态** —— 面板查看状态按页面加载保存；作用域、工作区与打开的笔记不跨刷新存续。
- **无恢复原语** —— 删除把文件移入旁侧回收文件夹，但恢复是一次手工移动文件；watcher 会重新收养它。
- **逐链接解析开销** —— 阅读视图对正文里每个 wikilink 各发一次 remote read，链接很多的笔记会按链接数量付费。
- **一次性回顾** —— 回顾节点只经一次 decide 调用提交；已决标记落地后没有重开路径，候选跳转只在项目笔记仍存在时有意义。
- **项目作用域 chip 跳转需要会话 cwd** —— 蒸馏 chip 通过所属会话节点的会话 cwd 解析项目笔记；没有已注册项目 cwd 时，host 在提交前把 project 分类候选降级到 global。
