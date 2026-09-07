<!-- translation-source: docs/adr/0029-keep-work-independent-of-retention-quotas.md; translation-source-sha256: d8f61442432293e7078ac7867eae92db9686dc79f844e58cf5ef2059c56030f5 -->

---
status: accepted
---

# 让生产性工作不受内部保留配额支配

下文有关 Context 兜底、请求准入和恢复的条款已由
[ADR 0031](0031-preserve-magic-context-behavior-through-suite-integration.md) 取代，其余决策保持不变。

## 背景

Pi Stuff 的若干安全边界目前会作出 lifecycle 决策，尽管它们衡量的只是已保留证据或经过时间。例如 Code
Mode 的 Session ledger 字节上限与 nested call 次数、Background Work 的输出上限，以及 Agents 的累计
protocol 字节数、启动次数、默认运行 timeout 和默认快速 Tool timeout。一个长期但健康的任务可能因此被
Suite 记账终止，而不是由拥有它的 lifecycle 决定。单纯提高这些常量只会推迟同一种失败。

并非所有边界都是任意的。模型 request window 有限，并发进程消耗真实资源，不受信任的 protocol record
必须经过验证，而 cost 或 no-progress guard 可以防止自动工作失控。用户显式指定的 deadline 与 Session
终止也是有意的 lifecycle 输入。这些边界必须与 Pi Stuff 保留多少 diagnostic 或 replay 证据的限制区分开。

## 决策

Pi Stuff 对当前 Pi Session 内的生产性工作采用 **Work Continuity Contract**。Suite 自身设定的累计 ledger
字节数、保留输出量、已完成 operation 数、已完成 Agent 数以及隐式 wall-clock 阈值，本身不得终止生产性
工作。拥有 lifecycle 的 Capability 仍负责在自己的边界实现该契约；Pi Stuff 不增加中央 work manager。

Retention 不是 lifecycle authority。Background output、Child Agent protocol diagnostic、Child transcript 与
Code Mode trace 可以保留有界 tail 或带明确 omission count 的滚动证据。跨过 retention 阈值时，只丢弃非权威
证据，不向 producer 发出信号，也不让它失败。单条畸形 record 仍可在其 trust boundary 失败。

Effect authority 更严格。Code Mode 把准确的 replay 状态保存在 append-only Pi Session custom entry 中，不设
累计字节配额。执行前已知的输入可以保留单次 operation validation。一旦 effect 可能已经发生，追加 canonical
completion 失败就会让 execution 保持 incomplete、停止后续 nested call，并且绝不能触发自动 replay。Pi
Session history 仍是唯一的 Code Mode ledger；在没有测量依据与 Host 支持的 authority model 时，Pi Stuff
不增加 sidecar database、payload-artifact store 或 garbage collector。

Agents 不再有默认总运行时间、默认累计启动次数或普通 child Tool 的隐式 timeout。调用者仍可显式指定 run
或 Tool deadline。运行并发、嵌套深度、启动前模型容量检查、cost attention 与安全的 protocol-frame validation
继续执行。Agent setup hook 同样不设隐式 deadline，但可以显式选择一个。

MCP Tool 与 resource request 默认不设绝对 request deadline，因为放弃可能产生修改的 request 会让其 effect
处于不确定状态。配置的正数 deadline 仍具权威性。连接、认证与 metadata discovery 保留有界 setup 行为；
Provider 与只读 Web operation 可以保留单次调用的 no-progress 或可重试读取 deadline。

Context Management 不修改 Host 设置，也不接管 Pi 的 native compaction。当 Magic Context 已启用而 native
compaction 被禁用时，所属的 `/ctx` 状态界面会报告 continuity 没有 native fallback，并指向恢复它所需的显式
Host 设置。

当用户停止工作、当前 Session 结束、显式 deadline 到期、所属 safety policy 暂停自动工作、trust boundary
拒绝某次 operation，或真实资源或持久化失败使继续运行不再安全时，本契约即告结束。它不会创建 daemon，
也不承诺跨 Session 切换或 Host 重启延续工作。

## 已拒绝的替代方案

- 提高现有常量仍会保留隐藏的最终失败，无法满足长期工作。
- 删除所有边界会把任意 retention quota 与 validation、concurrency、model capacity、cost 和 runaway 保护混为一谈。
- 中央 long-running-work manager 会重复 Goal、Agents、Background Work、Code Mode、MCP 与 Context Management
  已有的 lifecycle authority。
- Code Mode sidecar ledger 或 payload-artifact store 会增加另一条持久化路径，而 append-only event metadata
  仍然可能增长；若测量表明确有需要，物理 Session compaction 应属于未来的 Pi Host seam。
- 自动更改 native compaction 设置会违反配置所有权与纯 startup。

## 后果

各 Capability 的本地实现会在常见路径上变得更简单：producer 持续运行，已有 output、transcript 与 trace
seam 只限制自身保留的内容。测试必须证明，跨过各个旧累计边界不再终止工作、omission 清晰可见，而显式
安全边界仍按文档运行。

Session history 与持久化 Agent 状态可以增长，直至遇到真实 storage failure。Pi Stuff 会报告这种失败，而
不会用任意 quota 提前预测。如果后续代表性测量表明 loading、memory 或 disk 行为无法接受，下一个设计必须
在 owning authority 处压缩，并且不得改变已 settle 的 effect 或引入相互竞争的 lifecycle。
