<!-- translation-source: docs/capabilities/context-management.md; translation-source-sha256: 1f91c4893a8c7918164d3864a86c3172ec341f1b390421330732693f0a689f78 -->

# Context Management

[English](../../../../capabilities/context-management.md)

Context Management 提供检索、记忆、笔记、压缩和压力处理；Pi 保留会话界面、Session、前台执行、重试和队列行为。

## 命令和工具

| 命令 | 行为 |
| --- | --- |
| `/ctx` 或 `/ctx status` | 打开状态和可用操作 |
| `/ctx flush` | 在下一条消息应用排队的丢弃记录 |
| `/ctx wrapup [N]` | 压缩较早历史，默认保留 20 条消息 |
| `/ctx recomp [start-end]` | 显式重建全部或部分历史的 compartment |
| `/ctx upgrade` | 升级受支持的旧会话历史和记忆 |

对话框显示用量、保留和丢弃标签、compartment、记忆、笔记、待处理工作、Historian 状态、缓存、历史 token 和错误。
维护操作持久化为模型不可见的 Context Activity。`recomp` 和 `upgrade` 在后台继续；切换或分叉会话只分离可见更新，
不取消操作。

配置好的引擎提供延迟发现工具 `ctx_search`、`ctx_expand`、`ctx_memory`、`ctx_note` 和 `ctx_reduce`。
Pi Stuff 负责 `/ctx`，并抑制上游重复的状态、对话框、公告和 Todo UI。

## 启动和投影

已识别且无需迁移的配置在编辑器就绪前激活。缺失或旧配置保持休眠，直到直接输入、`/ctx` 或显式投影授权首次设置。
自动轮次不能创建或迁移用户配置。Magic 未配置或被显式禁用时，保留 Pi 原生行为。

启用 Magic 后，即使引擎失败，前台投影也仍由 Magic 负责。Suite 不回退到原始历史或原生摘要。Pi Session JSONL
保留原始记录。Worker 首次绑定或分支不连续时接收完整快照；普通刷新只发送新叶节点。每次前台 Context 事件都调用
Magic，重试正确性不依赖额外的 Suite 投影缓存。

本地载荷估算仅供参考。估算偏高、未知、非有限数或无法获取，本身都不会中止有效的 Magic 请求。状态百分比是估算，
不是远端 Provider 接受请求的保证。正确投影必须保留当前输入和已完成工具结果；无法取得时进入有界恢复。
BTW 和 Agents 保留既有的有界引用投影及调用方拥有的快照契约。

提示贡献按 Host、Context Management、其他注册 Capability 的顺序组织。直接模式指导仍限制为 8,000 字符。

## 压缩和恢复

Magic 执行普通主动压缩。Provider 实际超限后，Pi 调用公开压缩钩子；Magic 运行现有 Historian，返回真实持久化
摘要和保留历史边界。Pi 持久化结果并执行既有重试。第二次超限按 Pi 策略结束本次尝试。手动压缩也使用 Magic。
自动恢复不会调用完整 `/ctx recomp`，也不会重跑已完成工具或重交输入。

一次故障恢复阶段共享十分钟期限，涵盖压缩、现有瞬时失败重试、退避、完成核验和最多一次 Worker 重启。没有进展或
完成状态不确定时提前停止。回执丢失后检查持久化状态：复用确认完成的结果；只有确认未完成且安全的工作才可重复。
正常 Agent 执行、普通主动压缩和正常 Provider 响应时间不受恢复期限限制。

Pi 的自动压缩设置必须开启，Pi 才会触发自动超限恢复。关闭它不会关闭 Magic 的普通压缩。`/ctx` 说明缺失的 Host
钩子；Pi Stuff 不自行修改设置。原生自定义轮次预检只在 Magic 未配置或显式禁用时适用。

## Worker、取消与显示

引擎运行在一个内部 Worker 中，保持终端绘制响应。普通镜像生命周期事件不继承当前 Agent 轮次信号。
压缩接收自身取消信号；工具及支持信号的命令保留调用所属的取消语义。致命 Worker 故障只通过有界关键恢复替换。
迟到结果和 Host 副作用绑定原始会话；关闭采用有限宽限期。

恢复期间输入遵循 Pi 压缩队列。显式取消停止 Magic 操作；随后 Pi 可能交付排队输入，与没有 Suite 时相同。
Pi Stuff 不清空、不重交队列，也不修改 Host 来施加另一套终止策略。

实际恢复在现有 Context 显示中呈现 `recovering` 和简短阶段；成功后清除恢复状态。无法恢复时只说明一次原因，并保留
会话和当前输入。技术细节留在模型不可见的 `/diagnostics` 中。估算不确定或可选维护失败，不会主动中断仍可继续的 Agent。

## 配置和参考

Context 引擎及 Worker 配置仍位于 `pi-stuff.json` 之外。修改后重启 Pi，并检查 `/ctx` 和 `/diagnostics`。

- [模块契约](../../packages/pi-stuff/src/context-management/README.md)
- [恢复决策](../adr/0031-preserve-magic-context-behavior-through-suite-integration.md)
- [命令参考](../reference/commands.md#context)
- [故障排查](../troubleshooting.md#context)
