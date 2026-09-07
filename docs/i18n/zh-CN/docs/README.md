<!-- translation-source: docs/README.md; translation-source-sha256: 1763935be1a3ceba07c127083bd775b3900d74c7cf57cb01f5b40c1f3075af52 -->

# 文档

[English](../../../../docs/README.md)

这里汇总 Pi Stuff 的指南、参考、工程约定和保留证据。英文 Markdown 是权威来源，简体中文镜像按照同样的
仓库路径保存在 [`docs/i18n/zh-CN/`](../) 下。

<p align="center">
  <a href="../../../assets/readme/docs/index.png">
    <img src="../../../assets/readme/docs/index.png" alt="Pi 在实时对话中呈现 chart 和 tree" width="100%">
  </a>
  <br>
  <em>Pi 直接在对话中呈现 chart 和 tree。</em>
</p>

## 从这里开始

| 需求 | 文档 |
| --- | --- |
| 安装 Pi Stuff | [入门](getting-started.md) |
| 查看完整能力地图 | [Package README](../packages/pi-stuff/README.md) |
| 查找 slash command | [命令参考](reference/commands.md) |
| 配置一项能力 | [设置参考](reference/settings.md) |
| 选择内置主题 | [主题](reference/themes.md) |
| 处理常见问题 | [故障排查](troubleshooting.md) |
| 了解 Suite 如何组合 | [架构](architecture.md) |

## 能力指南

| 分类 | 用户指南 | Module README |
| --- | --- | --- |
| Conversation UI | [指南](capabilities/conversation-ui.md) | [Module](../packages/pi-stuff/src/conversation-ui/README.md) |
| Session Naming | [指南](capabilities/session-naming.md) | [Module](../packages/pi-stuff/src/session-naming/README.md) |
| Tool Display | [指南](capabilities/tool-display.md) | [Module](../packages/pi-stuff/src/tool-display/README.md) |
| Goal | [指南](capabilities/goal.md) | [Module](../packages/pi-stuff/src/goal/README.md) |
| Background Work | [指南](capabilities/background-work.md) | [Module](../packages/pi-stuff/src/background-work/README.md) |
| Agents | [指南](capabilities/subagents.md) | [Module](../packages/pi-stuff/src/subagents/README.md) |
| Todo | [指南](capabilities/todo.md) | [Module](../packages/pi-stuff/src/todo/README.md) |
| BTW | [指南](capabilities/btw.md) | [Module](../packages/pi-stuff/src/btw/README.md) |
| Notification | [指南](capabilities/notification.md) | [Module](../packages/pi-stuff/src/notification/README.md) |
| Ponytail | [指南](capabilities/ponytail.md) | [Module](../packages/pi-stuff/src/ponytail/README.md) |
| Context Management | [指南](capabilities/context-management.md) | [Module](../packages/pi-stuff/src/context-management/README.md) |
| Web | [指南](capabilities/web.md) | [Module](../packages/pi-stuff/src/web/README.md) |
| MCP | [指南](capabilities/mcp.md) | [Module](../packages/pi-stuff/src/mcp/README.md) |
| RTK | [指南](capabilities/rtk.md) | [Module](../packages/pi-stuff/src/rtk/README.md) |
| Codex | [指南](capabilities/codex.md) | [Module](../packages/pi-stuff/src/codex/README.md) |
| Code Mode | [指南](capabilities/code-mode.md) | [Module](../packages/pi-stuff/src/code-mode/README.md) |

Web 与 MCP runtime 另有源码就近 README：
[`web/runtime`](../packages/pi-stuff/src/web/runtime/README.md) 和
[`mcp/runtime`](../packages/pi-stuff/src/mcp/runtime/README.md)。

## 工程文档

| 文档 | 内容 |
| --- | --- |
| [`CONTEXT.md`](../CONTEXT.md) | 规范术语和职责边界 |
| [`DESIGN.md`](../DESIGN.md) | 共用界面与交互规则 |
| [Capability Contract 目录](capability-contract-catalog.md) | 当前可观察合同及验收状态 |
| [测试目录](../tests/README.md) | 测试层级、共享夹具、benchmark 输入与本地命令 |
| [兼容性](compatibility.md) | 已认证的 Host、工具链和依赖版本 |
| [质量保障](quality-assurance.md) | 验证命令、执行配置和迁移状态 |
| [代码质量](code-quality.md) | 源码质量门槛和完成审查 |
| [README 风格](readme-style.md) | README 结构、截图和翻译规则 |
| [参与贡献](../.github/CONTRIBUTING.md) | 开发和 pull request 流程 |
| [Agent 工作流](agents/) | 仓库工作规划与 issue 跟踪 |

## 架构决策

| ADR | 决策 |
| --- | --- |
| [0001](adr/0001-keep-pi-as-the-host.md) | 由 Pi 担任 Host |
| [0004](adr/0004-route-suite-diagnostics-through-owned-ui.md) | 通过自有 UI 显示 Suite 诊断 |
| [0006](adr/0006-cache-unchanged-suite-modules-across-host-reload.md) | Host reload 时缓存未变化的 Module |
| [0007](adr/0007-initialize-configured-context-before-editor-readiness.md) | 在编辑器 ready 前初始化已配置的 Context |
| [0008](adr/0008-own-the-context-command-surface.md) | 维护自有 Context 命令界面 |
| [0009](adr/0009-align-code-mode-with-openai-and-cloudflare.md) | 让 Code Mode 与 OpenAI、Cloudflare 对齐 |
| [0012](adr/0012-merge-pi-stuff-settings-file.md) | 使用一个合并后的设置文件 |
| [0015](adr/0015-certify-the-upstream-release-binary.md) | 认证上游 release binary |
| [0017](adr/0017-project-chart-and-tree-fences-inside-conversation-markdown.md) | 在 Conversation Markdown 中呈现 chart 和 tree fence |
| [0018](adr/0018-end-live-v1-agent-governor-coexistence.md) | 结束 live v1 Agent governor 共存 |
| [0019](adr/0019-isolate-context-engine-work-from-the-host-ui-thread.md) | 将 Context engine 工作移出 Host UI 线程 |
| [0020](adr/0020-add-automatic-session-naming.md) | 自动命名 Session |
| [0021](adr/0021-fork-ponytail-as-a-suite-capability.md) | 将 Ponytail fork 为 Suite 能力 |
| [0022](adr/0022-restrict-folding-to-native-retrieval.md) | 紧凑折叠仅用于原生检索 |
| [0023](adr/0023-use-a-closed-operation-block-family.md) | 使用封闭的 Operation Block 类型集合 |
| [0024](adr/0024-adopt-effect-as-the-internal-effect-model.md) | 采用 Effect 作为内部 effect 模型 |
| [0025](adr/0025-protect-vibe-line-spinner-liveness.md) | 在 Pi Stuff 边界内保护 Vibe Line Spinner 活性 |
| [0026](adr/0026-bound-context-managed-provider-requests.md) | 约束由上下文管理的 Provider 请求 |
| [0027](adr/0027-preserve-foreground-reporting-through-background-handoff.md) | 在 Background Work 移交后保留前台报告义务 |
| [0028](adr/0028-bound-tool-display-before-projection.md) | 在 projection 前限制 Tool Display |
| [0029](adr/0029-keep-work-independent-of-retention-quotas.md) | 让生产性工作不受内部保留配额支配 |
| [0030](adr/0030-unify-user-message-presentation.md) | 在原生 Host 内统一 User Message 呈现 |
| [0031](adr/0031-preserve-magic-context-behavior-through-suite-integration.md) | 在 Suite 集成中保留 Magic Context 行为 |
| [0032](adr/0032-organize-quality-assurance-by-verification-purpose.md) | 按验证目的组织质量保证 |
| [0033](adr/0033-continue-open-work-after-background-agent-results.md) | 后台 Agent 结果返回后继续尚未完成的工作（候选实现；验收待完成） |
| [0034](adr/0034-remove-redundant-suite-work-without-feature-cuts.md) | 消除 Suite 重复工作，不删减功能 |

## 证据与历史

- [研究](research/)保存按日期记录的调查与产品参考。
- [报告](reports/)保存验收、设计与性能证据。
- [发布说明](releases/)记录已经发布的变更。

这些证据只描述记录时的快照。当前行为以本页列出的指南、参考和工程文档为准。
