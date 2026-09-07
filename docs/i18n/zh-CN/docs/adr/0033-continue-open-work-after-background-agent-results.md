<!-- translation-source: docs/adr/0033-continue-open-work-after-background-agent-results.md; translation-source-sha256: 4f9ebea4ea1396127e7da14a0f639f93356e61f034b851ce8c96bba5b9c694aa -->

---
status: accepted
---

# 后台 Agent 结果返回后继续尚未完成的工作

## 背景

Pi Stuff 已检查的完成路径将结果记录为 UI 可见条目，却不将其放入主 Agent 的上下文，也不请求新的 turn。
这可能导致委派工作已经完成，而用户的原任务仍未完成。对于委派 Agent，放到后台执行不能免除主 Agent 接收结果并
完成原任务的责任。用户于 2026-09-06 确认了这一产品决策及完整修复方案；当前候选已在 `ps-8ew.3` 实现结果送达路径，组合生产验收仍待完成。

## 决策

自动将有界的成功、失败及部分结果，连同可检索的正式输出引用，递送给发起委派的主 Agent。只要原任务仍未结束，
空闲时继续整合，忙碌时排队。主 Agent 空闲或发出非终态进展更新，不能解除尚待完成的委派工作。与 Goal 协调递送，
避免同一个结果启动相互竞争的接续。

用户已经取消或明确结束的工作，不能因迟到结果重新启动；结果仍保留供查看。保留 Session/run 归属校验与去重。
Host 和上游的递送机制能够满足契约时应优先复用。本决策没有选定集成架构，也不代表当前 Runtime 已经实现这些行为。

## 后果

这里选择了完成用户的委派工作，而非现有的仅通知策略。pi-subagents 0.65.1 默认请求启动主 turn；Codex 和 Claude
Code 文档说明了结果回传及主 Agent 整合行为。公开证据并未证明三者的空闲调度和取消行为完全一致，因此这些边界
属于明确的本地要求。版本化来源、本地证据和验收目标见[修复方案](../research/pi-stuff-reliability-repair-plan-20260906.md)。

本决策针对委派 Agent。Agents 保留 lifecycle 和 protocol 权限，Context Management/Magic 拥有 child pressure 投影和本地估算处理。ADR 0027 针对 Background Shell 移交，其中对显式独立 Shell 的区分，不能作为 Agent
采用仅通知策略的证据。实现时应一起审查相关 Module 契约与 ADR，不能把任一策略悄然推广到其他 Capability。
