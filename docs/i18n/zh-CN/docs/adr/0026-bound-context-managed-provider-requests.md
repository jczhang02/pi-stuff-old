<!-- translation-source: docs/adr/0026-bound-context-managed-provider-requests.md; translation-source-sha256: 60444df69f436d4c02eabbb5b0e11d82f2edbdc2a340f0e187a69aa595468e44 -->

---
status: superseded by ADR-0031
---

# 由上下文管理约束的 Provider 请求

下文有关 Context 兜底、请求准入和恢复的条款已由
[ADR 0031](0031-preserve-magic-context-behavior-through-suite-integration.md) 取代，其余决策保持不变。

## 背景

Context Management 通常发送派生投影，而 Pi 负责组装由 Session 和已注册贡献构成的最终 Provider 请求。否则，
传输或 Worker 失败可能导致后续请求使用原生上下文，却没有证明其最终 payload 仍处于已配置的模型窗口之内。

## 决策

对于每个处于活动状态、由 Host 管理的前台 `before_provider_request`，Context Management 都会测量最终 JSON
序列化的 Provider payload，并要求有限的 token 估计值不超过模型 Context window 的 95%。窗口数据缺失或不可靠、
序列化或测量失败、估计值非有限，以及 payload 超出边界，都会产生本地 abort/error，并将估计值设为 unknown。
启动和 engine 降级路径可以使用 Pi 的原生 fallback，但活动的 Provider 边界会 fail closed。绕过此 hook 的直接调用
不在范围内。

只有在该 Provider 边界通过验证的结果才能复用，并且必须满足每个有序 raw message object 以及 Provider、model id
和 Context window 均完全相同。任何变化都会重新运行验证。Pi 继续负责现有的 retry、continuation 和 compaction
行为；本策略不增加任何 budgets。

正常运行期间，Statusline 报告最近一次通过验证的百分比。恢复期间，在获得通过验证的结果前报告 `recovering`。
失败时报告 `unknown` 并在本地 abort。一次成功的 assistant 或 Session lifecycle 完成后，恢复状态会清除。

## 被拒绝的替代方案

- 无限重试无法修复不可测量或确定性超大的 payload。
- 只防护 WebSocket 关闭码 1006，会遗漏其他传输和 Worker 失败。
- 根据观察到的 Provider 接受情况动态设定限制，会削弱本地安全保证。
- 只修改固定版本的 Magic Context 软件包，无法验证由 Pi 组装的最终 Provider payload。
- 向上游提交或引入新依赖超出了本地 adapter contract 的范围。

## 后果

Pi Stuff 可能会中止一个 Provider 本可接受的请求，但活动恢复不能静默发送未经验证的原生 payload。证据必须包括
一个聚焦的单元回归，以及真实 Pi Host PTY 覆盖：长 raw history、流开始后的传输失败、无需新的用户输入即可恢复、
有界的序列化 payload、输入变化后的重新运行、状态转换和本地失败行为。证据不得声称增加了新的 retry budgets 或
terminal exhaustion。
