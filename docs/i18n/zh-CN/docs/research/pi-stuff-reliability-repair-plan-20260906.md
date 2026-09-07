<!-- translation-source: docs/research/pi-stuff-reliability-repair-plan-20260906.md; translation-source-sha256: 23e24af858e6279cea8f7d2363d349defdcc1f33e54577b019b42dd74a2e6b33 -->

# Pi Stuff 可靠性修复方案

[English](../../../../../docs/research/pi-stuff-reliability-repair-plan-20260906.md)

**日期：** 2026-09-06

**状态：** 完整方案及测试边界已确认，可独立实施。

**工作：** `ps-8ew`，作为独立修复工作安排实施与验收。

**规格：** [ps-8ew / GitHub #239](https://github.com/jczhang02/pi-stuff/issues/239)。

**本地证据基线：** `d620c43dba9f904e7c895c708a535ab5715fb4fc`，认证 Pi 0.85.1。

这是方案记录，不代表修复已经实现或通过验收。验收时须记录最终修复 revision 及所用的认证 Host 版本。

## 已确认方向

- **Q1 — 保留有用能力，重审定制。** 交互、模块边界和实现都可以改变。既有 ADR、单 Package 结构、Effect 的采用
  及现有职责划分都是待重审的输入，不能成为保留错误行为的理由。没有明确收益的本地偏离应恢复上游行为；由此产生的
  持久契约变化必须同步更新所属文档。
- **Q2 — 修复完整关联链路。** 从 Subagents 出发，追查相关的 Context Management、Goal、Code Mode、Tool 执行和
  结果递送路径。其他 fork 有具体失败证据时再纳入，避免把这次修复扩大为没有边界的全仓重写或审计。
- **提问方式。** 此后每个产品决策问题都附上相关 harness 对照、一手来源，并区分已查证行为、推断和未知行为。
  只询问重要的产品方向；直接使用 npm、增加薄适配或保留 fork，由实现方根据证据选择。

## Q3 — 后台完成与接续

已确认：后台子代理自动回传结果，让主 Agent 完成尚未结束的原任务。仅显示 UI 通知、再要求用户发出请求，不满足这一行为。

| 对照对象 | 已确定行为 | 证据边界 |
| --- | --- | --- |
| pi-subagents 0.65.1 | notifier 通过 `pi.sendMessage` 发送完成内容，`triggerTurn` 默认为 true。 | 这是请求 Host 启动 turn。包内的完成消息合批不能证明 Host 忙碌或空闲时的调度方式，owner 校验也不能证明取消会阻止所有迟到 turn。 |
| Codex | 主线程协调子代理，并将子代理结果整合到最终回答中。 | 所引产品文档没有规定空闲父代理的唤醒、忙碌时的递送优先级，或取消后的迟到结果策略。 |
| Claude Code | 后台子代理与主会话并行；结果作为后续 turn 的完成通知送给 Claude，Claude 等待通知后再报告结果。 | 这没有规定每一种空闲唤醒或取消边界情况。 |
| 本地 Pi Stuff 基线 | 使用自定义 Session entry 记录完成供 UI 显示，但排除于模型上下文；后台启动回执明确表示完成不会触发新的 main turn。 | 界面出现完成行，不代表主 Agent 已收到或整合子代理结果。 |

来源：[pi-subagents 发布提交](https://github.com/nicobailon/pi-subagents/commit/83be9c3de2cde1553c0269f383efc1eb1194dc8b)、
[notifier](https://github.com/nicobailon/pi-subagents/blob/83be9c3de2cde1553c0269f383efc1eb1194dc8b/src/runs/background/notify.ts#L373-L390)、
[默认 turn 请求](https://github.com/nicobailon/pi-subagents/blob/83be9c3de2cde1553c0269f383efc1eb1194dc8b/src/runs/background/notify.ts#L639-L659)、
[Codex 子代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)、
[Claude Code 子代理](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)、
[本地完成处理](../../../../../packages/pi-stuff/src/subagents/src/extension/completion-handling.ts)和
[本地启动回执](../../../../../packages/pi-stuff/src/subagents/src/extension/product-executor.ts)。
公开资料查阅日期为 2026-09-06；这不等于本地验收运行。

**已确认决策：** 自动递送有界结果及可检索的完整输出引用。只要原任务仍未结束，空闲时继续整合，忙碌时排队。
用户已取消或明确结束的任务，不因迟到结果重新启动，但结果仍可查看。与 Goal 协调，避免一次完成启动重复接续。
主 Agent 进入空闲或发出非终态进展更新，本身不能解除尚待完成的委派工作。这些边界规则是已约定的本地契约，
不代表每个参考 harness 都已实现。持久决策记录在 [ADR 0033](../adr/0033-continue-open-work-after-background-agent-results.md)，实现仍待完成。

## 实施顺序

1. 在相同 Host 与场景下，对照相关上游发布版本和集成候选版本的行为。直接复用 Package 能满足所需行为时优先复用；
   仅针对已证明的缺口增加最小适配或保留补丁。记录受影响 fork 改动的处置，包括曾删除的保护。
2. 在职责所属的共享接缝修复下列五项缺陷，检查使用相关路径的前台、后台、detach、resume、嵌套和 Code Mode 调用方。
   保留继续有效工作的能力；payload 变短或出现终态都不等于成功。
3. 将约定的完成策略落实到主 Agent 结果递送与 Goal 接续，同时检查模型实际可见的结果和 UI 状态。
   更新所属 Module 契约，并明确替换与新行为冲突的 ADR 决策。
4. 集成可靠性修复并验证同一个修复候选版本。复用相同 revision 的有效检查，明确认证 Host 基线，
   如进行资源测量，避免其他重负载任务干扰。

## 验收目标

| 工作 | 必须可观察到的结果 |
| --- | --- |
| `ps-qbn` | 子代理 Context 承压后，既有发现、已完成检查和下一步有效行动仍能通过保留上下文或显式检索获得，子代理能够产出所需最终结果。仅保留原始 Session 不足以通过。 |
| `ps-81j` | 请求准入依据实际模型与请求约束；保守的序列化估算不能单独误杀本来可行的子请求，真实溢出仍应准确报告为可恢复失败。 |
| `ps-q2k` | 从仓库子目录启动的隔离任务，首次运行和恢复时均位于对应的 worktree 子目录，并保留文件及工作状态。 |
| `ps-sfx` | 整个 run 的取消同样约束在取消之后才注册的子代理；它们不会在被取消的 run 结束后执行工作或报告成功。 |
| `ps-gaz` | 前台 completion 文件缺失或不可读时，status 恢复保留正式最终报告，不会用后续进展文本替换它。 |
| `ps-8ew.3` | 后台结果进入主 Agent 上下文，无需用户再发消息就能继续有效整合；忙碌及空闲时递送、并发完成、Goal 协调、取消、去重与原始 Session 归属均符合 Q3。 |
| `ps-8ew.1` | 每项受影响的 fork 改动都有理由充分的处置和行为证据；检查删除过的上游保护及相关集成接缝，不能仅因符合旧 ADR 就通过。 |
| `ps-8ew.2` | 集成 revision 通过真实 Host 的日常编码、委派、压力、停止与恢复，以及约定的结果递送策略验证；真实模型证据及局限与 fixture、性能测量分开报告。 |

Q3 须明确覆盖结果递送期间切换 Session、退出和用户结束任务的情形：结果不能唤醒无关 Session，也不能复活已关闭或
已结束的工作。验证模型实际可见的结果能否被有效整合并产出最终交付物，不能仅检查通知或 Session entry 是否存在。

初始审计结合了源码及历史检查、确定性的生产路径探针、历史事件证据和 15 个通过的本地测试。这些证明了具体风险和
已有可用界面，不能认证修复后的端到端流程。自动通知父代理本身也不能修复尚未完成的子代理内部丢失的证据。
用户于 2026-09-06 确认了完整方案及测试边界。实现与验收仍由 `ps-8ew` 跟踪，尚未完成。
