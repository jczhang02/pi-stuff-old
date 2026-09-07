<!-- translation-source: .github/CONTRIBUTING.md; translation-source-sha256: 36456493065a7dcd01776ab2ca3b63e3a4dbc98a7d324f04bbcf5c250e815682 -->

# 贡献指南

遵循 [AGENTS.md](../AGENTS.md) 中按任务读取的要求和工程边界。已接受的共享工作按 [Issue 跟踪契约](../docs/agents/issue-tracker.md)使用 Beads；外部请求先由维护者接纳。

## 开发

使用仓库固定的 Bun 版本，遵循[验证政策](../docs/code-quality.md#按风险验证)，包括纯文档变更路径和复用同一版本的必要 CI 证据。普通自动化测试保持离线且无需凭据；真实 Provider 或外部 Service 验收需要显式选择。

本地工作使用 `bun run check` 执行 Static Checks，使用 `bun run test` 执行离线 Tests，使用 `bun run verify` 执行只读 Plan/Checks/selected-Tests 流程。命令范围和迁移状态见[质量保障指南](../docs/quality-assurance.md)。

CI 为精确版本记录 `Plan`、`Checks`、`Tests` 和 `Verify`。Plan 拥有现有保守范围决策，Checks 运行静态验证，Tests
保留断网测试/基准/打包 Host 验证顺序。缺失或未成功的必需任务使 Verify 失败；仅在显式、成功的不测试计划下才允许
跳过 Tests。手动触发总是要求完整测试。发布须使用这些当前结果，不能重标历史 Fast/Acceptance 运行。
参见[兼容性契约](../docs/compatibility.md)。

连续检查原生 Spinner、输入和命令补全选择时，运行
`bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN"`。脚本使用隔离的合成 Session，并在仓库外保留原始
观察记录。[观察器报告](../docs/reports/suite-responsiveness-observer-2026-09-05.md)说明了锁定门槛、故意卡顿
对照与 Execution Ledger 首次加载复现。这些针对性检查不能替代完整资源或 Capability 验收。

设置 `PI_STUFF_UI_PTY_ARTIFACT_DIR` 后，观察器还会在采集结束后把证据 JSON 复制到该目录。
CI 通过现有失败附件保留合成场景的画面、交互时序、Provider 事件日志、Session 记录和 Source 快照，
调度工作负载失败时也会保留；不会复制 Host 可执行文件或私有夹具配置。调度汇总在每项工作负载完成后保存，
后续负载失败也会上传。未完成的批次仅供诊断，不代表验收成功。

手动触发 CI 时可设置 `probe_kernel_events=true`，先在独立的 GitHub 托管虚拟机上执行调度事件正控，
再在普通验收之前运行七种诊断工作负载。它们复用响应性 observer，覆盖原生 Pi、Suite Tool、前台/后台
Agent、Context、Goal 和冷 Ledger。只有采集器使用宿主机 root 跟踪权限；工作负载以普通 runner 用户
运行，并使用独立的用户、网络和 PID 命名空间。独占 tracefs 实例使用全局时钟，拒绝事件丢失、任务
生命周期不完整、根进程身份不明确或不支持的非主线程 exec。唤醒按目标任务归属统计，覆盖线程/子进程
创建、退出清理及 PID 复用。计数和内核事件格式保留为汇总附件；不上传全系统原始跟踪。
将 `scheduler_baseline` 设为仓库完整 commit SHA，可在同一 runner 上按基线/候选/候选/基线顺序比较干净的
Package 源码树。每批都用当前 observer 执行全部七种工作负载，记录实际选择的 Package commit；进程和配置
均为新建，但不清空内核页缓存。observer 的 `--package` 参数也可用于本地对照，并分别保存 observer 与
Package 的 commit/diff 来源。
这些诊断运行不证明活性通过。普通验收仍在关闭跟踪后运行；请求额外测量的手动运行增加 25 分钟 job 时限，
供串行对照使用。
采集器传入 `--diagnostic`，允许观测 75 秒，且不能与 `--gates` 同用。结果记录该时限及诊断用途。
普通观测仍为 30 秒，Agent 和 Goal 为 60 秒；采集器外层 90 秒进程限制及全部响应性门槛保持不变。

## Package 变更

Pi Stuff 只有一个私有本地 Package。Capability Module 不独立确定版本或发布。行为需要持久用户记录时更新 `docs/releases/`。Suite 组合变化时，修改 `packages/pi-stuff/suite.json` 并运行 `bun run suite:generate`。使用适用的 Acceptance 测试 `tests/acceptance/repository/source-install.test.ts` 验证源码安装。本仓库没有 registry 发布或 Changesets 流程。

## 提交

使用带签名的 Conventional Commit：

```text
<type>(<scope>): <imperative subject>
```

维护者可以把已验证的提交 push 到 `main`。外部贡献以 pull request 交付和审查；接受的范围与状态按 [issue-tracker 契约](../docs/agents/issue-tracker.md)记录在 Beads。禁止 force-push 或删除 `main`。
