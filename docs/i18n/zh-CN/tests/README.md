<!-- translation-source: tests/README.md; translation-source-sha256: 8aaf15eb9ef001f841852b3bef045e122a373ff7ae8fb1d7814e5898a718761e -->

# 测试

本目录存放 Pi Stuff 的验证场景、共享夹具和固定 benchmark 输入。执行策略见[质量保障](../docs/quality-assurance.md)，必需检查与审查要求见[代码质量](../docs/code-quality.md)。

## 目录导览

测试文件按 `<level>/<capability>/<scenario>.test.ts` 组织；Node 兼容性场景使用 `.node.ts`。`repository` 汇集仓库工具测试。五个层级分别描述场景验证的边界。

| 目录 | 用途 |
| --- | --- |
| `unit/` | 隔离依赖，验证独立函数与组件 |
| `component-integration/` | 验证组件通过声明接口协作 |
| `system/` | 验证系统边界上的 Suite 与 Host 契约 |
| `system-integration/` | 验证本地运行时、工具及外部边界的集成 |
| `acceptance/` | 验证用户和 Host 可观察行为，包括 RPC、PTY 和源码安装 |
| `fixtures/` | 共享 fixture Provider、数据与断言辅助代码 |
| `goal-upstream/` | Goal 兼容性支持与 Node 编译桥接 |
| `benchmarks/` | 固定公共任务输入，目前为 Terminal-Bench 2.1 清单 |

`agents/`、`code-mode/`、`context/`、`tools/`、`ui/` 和 `work/` 存放共享场景支持代码，不是额外测试层级。可执行测试归入对应层级和 Capability；场景共用设置或夹具时复用支持代码。

## 运行测试

在仓库根目录执行：

```bash
bun run test --list
bun run test
bun run test --level unit --capability todo
bun run test --level acceptance --file repository/source-install.test.ts
bun run test --level acceptance --capability code-mode --matrix representative
bun run check
bun run verify
```

`bun run test` 默认运行完整离线清单及完整 Acceptance 矩阵，每个文件使用独立 OS 进程。离线场景使用 fixture Provider，不需要凭据，也不调用真实模型；部分场景仍需要已安装的 Pi、RTK、Node、tmux 等本地工具。`--list` 只预览要求，不执行场景；缺少依赖时预检失败。遇到失败会停止剩余文件，除非显式使用 `--keep-going`。报告写入 `.artifacts/tests/`。

单个兼容 Bun 的文件可通过 `bun test tests/unit/todo/format.test.ts` 直接执行。Node 兼容性文件及依赖环境预检的场景应使用仓库执行器。`check` 执行静态检查；`verify` 组合静态检查与按变更范围选择的测试。

## Benchmarks

为便于组织，benchmark 输入放在本目录，但 benchmark 仍独立于 Tests 和 CI 门禁。执行器位于 `scripts/`，使用显式的 `benchmark:capability:*` 或 `benchmark:suite:*` 命令。例如：

```bash
bun run benchmark:suite:terminal-bench --list
```

预览不调用模型。执行 Terminal-Bench 命令会启动真实的本地 Harbor 评测，应遵循[文档协议](../docs/quality-assurance.md)。生成结果放在忽略的 `.artifacts/` 中，不与固定输入混放。
