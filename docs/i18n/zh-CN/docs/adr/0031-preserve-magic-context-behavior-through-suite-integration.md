<!-- translation-source: docs/adr/0031-preserve-magic-context-behavior-through-suite-integration.md; translation-source-sha256: 367c3782dfb72cfd7db8f3aad5de97f5d8078412541d51ba6e1a2387429f2dc2 -->

---
status: accepted
---

# 在 Suite 集成中保留 Magic Context 的行为

## Context

启用 Magic 后，投影和全部压缩均由 Magic 负责。Magic 失败时，Pi Stuff 不得改用原始会话历史或 Pi 原生摘要。
Pi 负责前台执行、会话持久化、重试和队列交付。本决策取代 ADR 0026，以及 ADR 0007、0019、0029 中的原生兜底条款。

## Decision

每次投影都使用 Magic 现有的消息身份解析器；消息数量相同并不代表位置一一对应。每次前台 Context 事件都调用
Magic，由 Magic 管理自己的投影状态，Suite 不再维护额外的复用缓存。本地估算仅供显示和主动压缩使用，不能据此
中断仍可继续的 Agent。可选维护失败本身也不能否定可用的前台投影。

实际超限时，Pi 的公开自定义压缩钩子调用现有 Magic Historian，提交真实 compartment，并返回持久化摘要和保留历史
边界。Pi 持久化压缩结果并执行既有的压缩后重试。第二次超限按 Pi 既有策略结束本次尝试；Suite 不增加前台重试循环。
手动压缩也使用 Magic。完整重建（`/ctx recomp`）仍需显式发起。

一次故障恢复阶段共享十分钟期限，最多自动重启一次 Worker。Historian 工作、现有瞬时失败重试、退避和完成核验均
消耗同一期限；没有进展则提前停止。正常 Agent 执行、普通主动压缩和恢复成功后的正常 Provider 响应不受该期限计时。
重启从 Pi 会话和 Magic 存储重建状态，并保留已选择的工具。

确认回执丢失后，先检查持久化完成证据，再决定是否重复操作。复用已确认的 compartment 和待提交 Pi 边界；仅对确认
未完成且可安全重复的操作重试。完成状态不确定时说明原因后停止。取消必须传递到压缩调用并阻止迟到的发布。
切换会话后，旧结果和副作用失效。已接受输入及已完成工具结果保留在原有会话记录中；恢复不重跑工具、不重交输入。

## Host 行为与显示

恢复期间输入遵循 Pi 的压缩队列。显式取消会停止 Magic 调用；随后 Pi 可能交付排队输入，这与未安装 Pi Stuff 时相同。
Suite 不清空、不重交这些队列，也不修改 Pi 来施加另一套终止策略。WebSocket/SSE 选择不属于本次变更。

使用现有 Context 显示呈现 `recovering` 和当前阶段。恢复成功后清除此状态；无法恢复时仅说明一次原因，并告知会话与
输入已保留。技术诊断不进入模型上下文。未知或偏高的估算本身不代表恢复失败。

## Consequences

原生兜底会改变所选压缩责任方。按估算拒绝请求不能确定远端 Provider 的真实上限。合并 Host 适配器和 Magic 自身的
Pi 适配器，会混淆 UI/Worker 集成与上游消息、存储语义。保留职责分离；只有上游自身行为需要修正时才补丁固定版本，
并在 `UPSTREAM.md` 记录来源和移除条件。

直接运行带补丁的 Magic 与完整 Suite，在输入、压缩和取消语义上应一致；明确的 Suite UI 以及 BTW/Agents 有界引用
投影除外。在真实 Host 边界验证恢复、耗尽、已完成工具、Worker 故障、回执丢失、会话隔离和冷恢复。
注入超限的夹具只能证明控制流程，不能证明远端容量；真实 Provider 证据必须单独报告。保留现有用户可见能力。
