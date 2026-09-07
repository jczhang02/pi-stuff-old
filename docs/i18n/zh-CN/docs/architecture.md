<!-- translation-source: docs/architecture.md; translation-source-sha256: 8600c8c031f3f507b0215a9904b71ddb9663fb62d9ccbfe2759a4314028b2412 -->

# 架构

[English](../../../../docs/architecture.md)

Pi Stuff 作为一个 Package 运行在 Pi Host 中。各 Capability Module 共用 Pi 的 conversation、Session、命令、
Tool 与终端界面，同时分别负责自己的状态和策略。

## 系统形态

```text
Pi Host
└── Pi Stuff Package
    ├── Conversation 界面
    ├── 工作生命周期
    ├── Context 与集成
    └── 支撑 Tool 与 runtime adapter
```

Pi 负责编辑器、普通前台 Agent 运行、Session、model 和 Extension 加载。Pi Stuff 通过 Pi 的公开 Extension API
加入 Suite 行为。

## Suite 组合

`packages/pi-stuff/suite.json` 是组合来源。生成的 Extension factory 按以下顺序初始化能力：

| 阶段 | Capability Module |
| --- | --- |
| Conversation 基础 | Conversation UI、Session Naming、Tool Display |
| Model 与命令支持 | RTK、Codex |
| 工作与 Context | Goal、Context Management、Ponytail |
| 集成 | Web、MCP |
| 委派工作 | Background Work、Agents、Todo |
| 交互辅助 | BTW、Notification |
| 可选执行 | Code Mode |

当后加载的能力使用前面提供的共享 UI、诊断、生命周期状态或 Tool 时，初始化顺序会影响行为。

## 生成组合

`bun run suite:generate` 读取 `packages/pi-stuff/suite.json` 并更新：

- `packages/pi-stuff/index.ts`：Package 的 Extension 入口；
- `packages/pi-stuff/src/suite-runtime.ts`：生成的 capability loader。

组合变化时先修改 manifest，再重新生成。Capability 实现位于 `packages/pi-stuff/src/<capability>/`。

## Runtime 加载

Package 内的相对导入直接写出交付文件的名称：TypeScript 导入使用 `.ts`，真实 JavaScript 模块保留其自身后缀。
生成的组合代码遵循同一规则。仓库导入检查会拒绝不存在的目标，避免 Host 反复查找不存在的 `.js` 路径后，
再回退到 TypeScript 源码。

导入 Package 时会注册 Extension factory。Session 启动阶段读取用户配置，并在编辑器就绪前初始化已配置的能力。
外部服务和依赖子进程的可选集成会在所属能力需要时启动。

初始化失败会传回 Host。能够隔离的 runtime 问题会写入共享诊断界面，可通过 `/diagnostics` 查看。

共享 runtime 类型检查函数在模块加载时一次性绑定 TypeBox 判定函数。它们保留 JavaScript 的 number 类别
（包括 `NaN` 和无穷大）与 object 类别（包括数组和 `null`）；有限数字检查仍单独区分。

## 生命周期所有权

| 生命周期 | Owner | 职责 |
| --- | --- | --- |
| 前台 Agent 工作 | Pi | 普通 turn、model 执行、Goal Final Response 和 Host 终端行为 |
| Goal continuation | Goal | 目标持久化、证据门槛、continuation、终止状态持久化和队列意图 |
| 委派 Agent 执行 | Agents | 子执行、监督和当前 Session 的 Agent 控制 |
| 后台进程 | Background Work | Background Shell、Monitor、输出和取消 |
| Context 投影 | Context Management | 检索、压缩、压力处理与历史投影 |

这些 owner 通过有界共享状态与 Pi Extension event 协同。每种可见状态只有一个 UI authority，避免 Welcome
卡片、Statusline、overlay、通知和 transcript 同时解释同一状态。
Goal 会先验证并持久化已接受的终止状态，再返回 Tool result；随后由 Pi 在同一次前台 Agent run 中负责普通的
follow-up Provider 请求与 Assistant 消息；若已记录的用量耗尽显式预算，或触及其他强制停止边界，则不再请求。

## 配置与数据

| 位置 | Owner |
| --- | --- |
| `<agentDir>/settings.json` | Pi Host 设置 |
| `<agentDir>/pi-stuff.json` | Pi Stuff 设置命名空间 |
| `<project>/.pi/code-mode.json` | 受信项目的 Code Mode override |
| 用户 MCP 配置 | MCP server 声明、连接策略和认证 |
| 外部 Context 配置 | Context engine 与 worker 选择 |

Session 数据、凭据、model store、cache 和外部服务状态由对应的 Host 或集成管理。Pi Stuff 支持的命名空间见
[设置参考](reference/settings.md)。

## 设计权威

- [CONTEXT.md](../CONTEXT.md)定义规范术语与所有权边界。
- [DESIGN.md](../DESIGN.md)定义共享可见界面行为。
- [Capability 文档](README.md#能力文档)链接当前局部契约。
- [ADR](README.md#当前-adr-索引)记录持久取舍。
- [兼容性](compatibility.md)记录已认证 Host 与开发工具链。
