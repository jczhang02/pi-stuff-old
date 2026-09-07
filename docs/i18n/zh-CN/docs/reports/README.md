<!-- translation-source: docs/reports/README.md; translation-source-sha256: 02539c4050872a725ec10e661b92fb0824c68cd6d040d04b61ae396dabec6503 -->

# 报告

[English](../../../../../docs/reports/README.md)

这里保留 Pi Stuff 的验收、设计和性能证据。当前认证环境见[兼容性指南](../compatibility.md)，当前行为见
[文档索引](../README.md)。

<p align="center">
  <a href="../../../../assets/readme/reports/index.png">
    <img src="../../../../assets/readme/reports/index.png" alt="Ghostty 中的 Pi Stuff 诊断界面" width="100%">
  </a>
  <br>
  <em>Suite 诊断从当前进程提供范围明确的证据。</em>
</p>

## 基准与验收

- [可比 Package 资源与保留的输入失败](suite-comparable-resources-2026-09-06.md)
- [Suite 生命周期资源前后对照](suite-lifecycle-comparison-2026-09-06.md)
- [GC 观测与保留的 owner 成本](gc-and-owner-cost-2026-09-06.md)
- [Naming 与 Goal 历史选择成本](history-selection-cost-2026-09-06.md)
- [Agents 冷加载与投影器成本](agents-loading-and-projector-cost-2026-09-06.md)
- [Suite 资源源码清单](suite-resource-inventory-2026-09-05.md)
- [连续响应观察器与 Ledger 首次加载复现](suite-responsiveness-observer-2026-09-05.md)
- [Pi 0.85.0 Suite 资源基线](suite-resource-baseline-2026-09-05.md)
- [Capability Contract 验收与有界 Terminal-Bench 观察](ps-ps3-capability-contract-and-terminal-bench-observation-2026-08-30.md)
- [ps-8ew 可靠性修复验收](ps-8ew-reliability-acceptance-20260906.md)
- [Effect 下的 Magic Context 优化与重新认证](magic-context-effect-optimization-2026-09-02.md)
- [ps-qer Agent 完成验收](ps-qer-agent-completion-acceptance-20260902.md)
- [Effect v4 与 main 的取舍结论](effect-v4-mainline-decision-2026-09-01.md)
- [Skill Discovery 启动有界确认](../../../../../docs/reports/skill-discovery-startup-bounded-confirmation-20260830.json)及其
  [预注册](../research/skill-discovery-startup-bounded-confirmation-20260830.md)
- [Skill Discovery 隔离确认](../../../../../docs/reports/skill-discovery-isolated-confirmation-20260830.json)及其
  [预注册](../research/skill-discovery-isolated-confirmation-20260830.md)
- [Skill Discovery 直接读取研究](../../../../../docs/reports/skill-discovery-direct-read-20260830.json)及其
  [预注册](../research/skill-discovery-direct-read-20260830.md)
- [Skill Discovery 确认](../../../../../docs/reports/skill-discovery-confirmation-20260830.json)及其
  [预注册](../research/skill-discovery-confirmation-20260830.md)
- [Skill Discovery 基准](../../../../../docs/reports/skill-discovery-benchmark-20260830.json)及其
  [预注册](../research/skill-discovery-benchmark-20260830.md)
- [ps-8z1 最终验收](ps-8z1-final-acceptance-2026-08-29.md)
- [Pi Stuff 0.3.0 最终验收](pi-stuff-0.3.0-final-acceptance.md)
- [Effect v4 采用基线](effect-v4-adoption-baseline-2026-08-30.md)

## 设计与迁移

- [Astra 指令与交付审查](astra-instruction-delivery-review-2026-09-05.md)
- [单 Package 迁移](single-package-migration.md)
- [生命周期性能](pi-stuff-lifecycle-performance.md)
- [Context 提交并发](context-submit-concurrency-research-2026-08-14.md)

原始 JSON、ANSI、文本和图像证据与所属报告放在一起。历史版本、路径和哈希保持原样，便于确认当时的环境。

- [ps-eck 恢复和 Host 边界（2026-09-05）](ps-eck-recovery-host-boundary-2026-09-05.md)


- [质量保障迁移 — 2026-09-06](quality-assurance-migration-20260906.md)：命令、测试与 CI 分批迁移证据。
