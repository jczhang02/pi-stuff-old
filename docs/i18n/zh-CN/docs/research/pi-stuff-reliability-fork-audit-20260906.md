<!-- translation-source: docs/research/pi-stuff-reliability-fork-audit-20260906.md; translation-source-sha256: 27b135b8b663267077400cc3157565934c67beaa4e5ff5ac91dbd9ebaf5deba6 -->

# Pi Stuff 可靠性 fork 适配审计

日期：2026-09-06。范围：ps-8ew.1；Context/Goal 压缩与继续、Code Mode 嵌套 Tool Display，以及 Conversation UI Host 适配器。

基线：`48a3de5072b2cb95e3e5b8320cbb29f297abdc67`（已签名的 Pi 运行时提交，Pi 0.85.1）；当前审计源是此 worktree 中未提交的候选实现。

本报告是有界的源代码与历史审计，不认证实时 Provider 或合并修复候选。复用 `ps-qbn` 记录的完整 Agents 诊断，包括后续项 `ps-81j`、`ps-sfx`、`ps-q2k`、`ps-gaz` 和 `ps-tgj`。

已确认的认证 Host 证据来自 `bun test test/agents/child-context-pressure-host.test.ts test/context/magic-recovery-host.test.ts`：在 Pi 0.85.1 上通过 14 个测试、0 个失败、116 个断言，耗时 73.21 秒（日志：`.artifacts/ps-8ew-acceptance/context-host.log`）。该测试使用生产 `buildPiArgs`、真实 Magic Worker/Historian、新建及分支 seeded history、两次真实溢出恢复、8 次中间 Tool 调用、steering，以及对先前 findings 和 completed-check ID 的最终报告断言。依赖补丁的 SHA-256 现为 `0c75ef8e484250b614d1650dfc772d3e66f3d83f9fc4478d863de9bd7d4044d2`。这一确定性 Provider fixture 证明了生产控制流和协议保持；它不证明实时 Provider 溢出容量。

另一次在 Pi 0.85.1 上进行的实时 Provider 后台运行（`openai-codex/gpt-5.6-luna`，medium）完成了主要最终交付物并干净 teardown（0 个 extension error）；日志为 `.artifacts/ps-8ew-acceptance/live-provider-wrapper-final-20260906.log`，`stale-handler-final.jsonl` 为空。这不代表远端实时溢出已获证明。

另一次独立的实时手动 Magic compaction/recovery 在公开 RPC 压缩后恢复了先前的 finding 和 check marker（`tokensBefore=79939`、`estimatedAfter=22002`、`lastCompactedOrdinal=19`）。这是手动合成证据，用于证明手动压缩和证据保留；它不证明远端实时溢出、真实代码检查身份或组合验收。

## 处置

| 边界与所有者 | 预期行为与本地差异 | 证据与处置 |
| --- | --- | --- |
| Context Management（`packages/pi-stuff/src/context-management`）；Context 拥有投影，Magic 拥有压缩，Pi 拥有持久化/重试 | 固定的 Magic Context 0.41.1 artifact（`cbfac49f…`）在内部 Worker 中运行。本地补丁 `patches/@cortexkit%2Fpi-magic-context@0.41.1.patch` 提供 tokenizer 解析/预加载、图像哈希复用、保留摘要身份、持久化溢出完成和 signed reasoning 保留，并使 pre-hook cache 失效。本地历史 `673e6a8b`、`911f686e` 和 `143b7e5f` 有意移除了 native fallback 及仅估算式中断，同时保留公共 Host hook。当前候选完全移除 Agents 的 `continuation-context.ts` 及其估算门禁/投影器，将子任务压力归还 Context Management/Magic。 | `test/agents/child-context-pressure-host.test.ts` 通过两次新建/分支溢出、其间的 Tools、steering、findings、completed-check ID 和最终报告位置，测试生产启动及真实 Magic Worker/Historian。此前的失败（signed reasoning 被擦除；重试使用陈旧缓存）已在现有依赖补丁中修复，测试现已通过其 fresh/final-placement 用例。`test/context/core-provider-boundary.test.ts`、`core-compaction.test.ts` 和现有 recovery Host suite 覆盖估算、取消、重启、陈旧结果以及无 fallback 控制。**保留**已审计的 Magic 补丁及边界，直到达到文档化的移除触发条件。**恢复单一所有者边界**：不要重新引入 Agents 估算门禁或竞争性的 emergency projector。实时压力容量仍未获证明；后台 clean teardown 由独立实时运行覆盖。 |
| Goal（`packages/pi-stuff/src/goal`）；Goal 拥有继续和终止策略 | 上游 `pi-extensions` `v0.48.0`、`f0963e4c…` 提供状态机、queue/RPC、持久化和测试。本地提交 `b0663fab`、`b10f94be`、`a3c0f79c` 和 `3789e99e` 将展示适配到共享 Dialog，保留 terminal usage/budget 和最终响应，在 native compaction 后恢复，并避免普通 automatic/no-progress limit，同时保留 emergency backstop 和显式限制。 | `test/goal-upstream/goal-terminal-tools.node.ts` 覆盖 goal identity、escaped continuation、结构化完成证据、重复 blocker 证据、陈旧替换和 terminal usage。`test/ui/command-dialog-attribution.test.ts` 覆盖等待 Goal continuation 后再刷新。**保留**本地策略。**未发现新的缺陷**；不要恢复 upstream UI kit 或 aggregate quota。剩余的组合完成/竞态证明属于 `ps-8ew.2` 和 `ps-8ew.3`。 |
| Code Mode 与嵌套 Tool Display（`packages/pi-stuff/src/code-mode`、`packages/pi-stuff/src/tool-display`）；Code Mode 拥有嵌套执行，Tool Display 拥有展示 | Code Mode 源自 `howaboua-pi-stuff` `b3591d99…` 和 Cloudflare `@cloudflare/codemode` 0.5.1。它有意重新进入 Pi 公共 Tool 准备/校验/生命周期，并保持 envelope 静默；Tool Display 源自 `pi-tidy-tools` 0.4.1 `4b251377…`，保留结果优先摘要，但使用原生 Pi 0.85.1 定义及有界语义展示。本地历史 `6d0507c1`、`5c64f803`、`682d6f4d` 限制同步展示，并使 ledger 状态真实且可回放。 | `test/code-mode/ledger.test.ts` 通过 replay、approval、精确大结果、effect 后失败、重复/陈旧结算、rollback 和无 execution quota。使用现有缓存的认证 `rust-v0.145.0` Host，设置 `PI_STUFF_CODE_MODE_REAL=1` 后运行 `test/code-mode/v8-real.test.ts`：11 个测试、0 个失败、41 个断言，耗时 855ms（binary SHA-256 `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`；日志 `.artifacts/ps-8ew-v8-real.log`）。未设置该标志时默认门禁仍跳过这些测试。**保留**适配器边界及有界展示；网络服务行为不在该证据范围内。 |
| Conversation UI（`packages/pi-stuff/src/conversation-ui`）；UI 拥有投影，Pi 私有方法只经过版本检查适配器 | 从 `pi-unicode-charts` 0.1.0 `8d63d300…` 吸收 Unicode/chart 源码；`5c653a43`、`6a0d9367`、`6770c76e` 以及兼容提交 `1844ed86`/`d620c43d` 引入原生 user-message 插入/回放及 status/thinking 适配器。本地差异移除了竞争性的 transformer/UI 注册，shutdown 时恢复原生方法，并在保留 canonical Session message 的同时隔离投影失败。 | `test/ui/user-message-display.test.ts` 覆盖重叠所有者、不兼容 Host 拒绝、失败隔离/重试及 replay adoption；`test/ui/conversation-markdown.test.ts` 覆盖公共 transformer 注册/失败；`test/ui/statusline-rendering.test.ts` 覆盖仅 events 的适配器、恢复状态、未知 usage 和窄宽度。**保留**版本绑定的私有 Host 适配器；未发现新的有界行为回归。真实 TUI 认证仍是发布门槛。 |

## 被移除的保护与上游对比

提交 `513f74b6` 删除了 `context-management/work-continuity.ts` 及其 completed-verification retention assertion，同时保留 `subagents/src/runs/shared/continuation-context.ts` 的紧急历史删除。被删除的 assertion 原本是 completed-check authority 的回归检测器。这是实际的保护缺失，由 `ps-qbn` 负责；通过静态检查或当前小 payload 测试不能为其合理性提供依据。`ps-qbn` 回放显示，41/100/801 条消息的历史会在本地估算/紧急投影下坍缩为 4 条，而不含 raw signature 字段的反事实则保留历史。该反事实不能授权删除 Provider 所需的签名。

发布的 `pi-subagents` 0.65.1 提交 [`83be9c3de2cde1553c0269f383efc1eb1194dc8b`](https://github.com/nicobailon/pi-subagents/tree/83be9c3de2cde1553c0269f383efc1eb1194dc8b) 包含针对 parent-only message 和 Tool ID 的 child-hook 清理，但不包含 Pi Stuff 的 `projectChildContinuationContext`/`emergencyProjection` 策略。因此，上游来源不能为本地历史删除或丢失的 assertion 提供依据。

当前候选完全移除了 Agents 所有的 continuation-context seam；本审计将该历史删除视为由所有权移除修复，但仍需确认 Context/Magic 在每条集成路径上保留必需证据。

同一发布提交上的匹配 fork 对比是具体的：上游 `test/unit/fork-context.test.ts` 和 `test/integration/fork-context-execution.test.ts` 覆盖持久化 parent/leaf 前置条件、按 index 的 branch file、Anthropic signed-thinking 删除、thinking 降级以及显式 fork fail-fast。本地 `test/agents/fork-context.test.ts` 通过 signed-thinking 用例；本地 `test/agents/foreground-engine-context.test.ts` 通过 raw-versus-projected fork 选择、异构 fallback 顺序和持久化 branch 测量。因此，本地候选展示的是 Pi Host session/worktree 及 model fallback 集成方面的适配差异，没有理由继承上游无关的 UI/runtime。当前本地运行通过了替代的 Context-owned child-history 用例，但不能证明实时 Provider convergence 或上游集成等价性。

相关的已发布源代码记录为 [pi-extensions `f0963e4c`](https://github.com/narumiruna/pi-extensions/tree/f0963e4c343124a6f1419163b0425f571282c9b0)、[Code Mode 源码 `b3591d99`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/b3591d996efbf6df293e426dea2bb2dd17fcbfe6)，以及本地模块 provenance 文件 [Context](../../packages/pi-stuff/src/context-management/UPSTREAM.md)、[Goal](../../packages/pi-stuff/src/goal/UPSTREAM.md)、[Code Mode](../../packages/pi-stuff/src/code-mode/UPSTREAM.md)、[Tool Display](../../packages/pi-stuff/src/tool-display/UPSTREAM.md)、[Conversation UI](../../packages/pi-stuff/src/conversation-ui/UPSTREAM.md)。

## 验证限制

列出的 Context、Goal、nested-ledger 和 UI 定向确定性测试通过：最新有界命令运行了 78 个测试，78 个通过，375 个 expectations；认证 V8 Code Mode 另有 11 个测试、41 个断言通过。认证的 child-pressure/recovery 命令另有 14 个测试、116 个断言通过。实时后台 Provider 运行完成最终交付物并干净 teardown；它与压力压缩证据相互独立。Goal `.node.ts` runner 的记录来自既有证据，因为 Bun 默认文件发现不会包含它。除非设置 `PI_STUFF_CODE_MODE_REAL=1`，默认 Code Mode 门禁会跳过 V8 测试；如上所述，显式认证 Host 运行已通过。未进行远端实时溢出认证、真实代码检查身份验证、资源测量或修复后的组合认证。审计建议：对文档化适配器采取 **保留**；在 `ps-qbn` 中 **修复/验证** Context 所有的子任务证据连续性；将最终验收 **延后** 至集成候选及认证 Host 确定后的 `ps-8ew.2`。
