<!-- translation-source: .github/CONTRIBUTING.md; translation-source-sha256: d90bbb9869a65fc21a5b11d20df6837144641e7d34047ebdf55dd43e17725f96 -->

# 贡献指南

遵循 [AGENTS.md](../AGENTS.md) 中按任务读取的要求和工程边界。已接受的共享工作按 [Issue 跟踪契约](../docs/agents/issue-tracker.md)使用 Beads；外部请求先由维护者接纳。

## 开发

使用仓库固定的 Bun 版本，遵循[验证政策](../docs/code-quality.md#按风险验证)，包括纯文档变更路径和复用同一版本的必要 CI 证据。普通自动化测试保持离线且无需凭据；真实 Provider 或外部 Service 验收需要显式选择。

本地工作使用 `bun run check` 执行 Static Checks，使用 `bun run test` 执行离线 Tests，使用 `bun run verify` 执行只读 Plan/Checks/selected-Tests 流程。命令范围和迁移状态见[质量保障指南](../docs/quality-assurance.md)。

## Package 变更

Pi Stuff 只有一个私有本地 Package。Capability Module 不独立确定版本或发布。行为需要持久用户记录时更新 `docs/releases/`。Suite 组合变化时，修改 `packages/pi-stuff/suite.json` 并运行 `bun run suite:generate`。使用适用的 Acceptance 测试 `tests/acceptance/repository/source-install.test.ts` 验证源码安装。本仓库没有 registry 发布或 Changesets 流程。

## 提交

使用带签名的 Conventional Commit：

```text
<type>(<scope>): <imperative subject>
```

维护者可以把已验证的提交 push 到 `main`。外部贡献以 pull request 交付和审查；接受的范围与状态按 [issue-tracker 契约](../docs/agents/issue-tracker.md)记录在 Beads。禁止 force-push 或删除 `main`。
