<!-- translation-source: docs/capabilities/subagents.md; translation-source-sha256: 012885b9d43e496258b322d5f3f4c3650e9d3b7f044219d43d28ce223c949481 -->

# Agents

[English](../../../../../docs/capabilities/subagents.md)

Agents 把有界工作委派给命名 child Agent，并通过一个 Tool 和 `/agents` dialog 提供完整生命周期。

## 前置条件

Agent 定义从以下位置发现：

1. 当前项目的 `.pi/agents` 目录；
2. 用户的 Pi `agents` 目录；
3. 已安装的 Pi Package。

名称冲突时，项目定义优先于用户定义，用户定义优先于 Package 定义。每次主运行前，`subagent` Tool 描述会列出
有效 roster 和每个 Agent 的用途。
Agent frontmatter 可以声明 `tools` 与 `excludeTools`；exclusion 对该 child 始终优先。

Pi settings 可以通过 `subagents.agentScanDirs` 增加递归扫描根。用户 settings 提供 user scope 根，项目
`.pi/settings.json` 提供 project scope 根。条目会展开 `~`，并可包含一个完整的 `*` 路径段，以扫描一层目录。
缺失的根会被忽略；symlink 目录只跟随一次；如果扫描根与固定 user 或 project Agent 目录发生同名冲突，固定目录优先。

## 快速开始

在后台启动一个 Agent：

```json
{
  "agent": "general-purpose",
  "description": "Inspect parser",
  "task": "Find the parser boundary and report exact source evidence."
}
```

后台是默认方式。完成结果会自动送达来源 main Agent；空闲时继续整合，忙碌时排队。只有当前 Tool call 必须等待结果时，才设置
`"foreground": true`。

## Tool 形态

每个 `subagent` call 只能使用以下一种形态。

### 单个 Agent

`agent` 和 `task` 必填。可选字段用于选择简短 `description`、工作目录、model、Skill、显式 Tool budget 或
逐 Tool timeout、context mode、isolation 和前台执行。

### 并行 Agent

```json
{
  "tasks": [
    {
      "agent": "general-purpose",
      "description": "Inspect API",
      "task": "Report the public API with source references."
    },
    {
      "agent": "reviewer",
      "description": "Check behavior",
      "task": "Independently verify the documented behavior."
    }
  ]
}
```

Grouped task 会在当前容量内并发运行。同一条 Assistant response 中独立的原生 `subagent` Tool call 也可以并发。

### 控制

```json
{ "action": "status" }
{ "action": "steer", "id": "agent-id", "message": "Check the fallback path too." }
{ "action": "stop", "id": "agent-id" }
{ "action": "resume", "id": "agent-id" }
{ "action": "resume", "id": "agent-id", "index": 0, "acknowledgeCost": true }
```

`status` 可以省略 `id`，获取一次性概览。`steer`、`stop` 与 `resume` 要求 `id`；grouped run 还可以用
`index` 选择 child。`agent` 只在 launch 时命名 Agent definition，`id` 标识已有 Agent Target；Todo 字段
`taskId` 不是 Agent 标识符。只有成本 guard 请求关注后，由用户直接发起的 resume 才能使用
`acknowledgeCost`。日常检查和控制请使用 `/agents`。

对终态 Agent 使用带 `id` 的 `status` 查询时，会在有界进展摘录之前返回保留输出的精确路径。
读取该路径即可取回完整报告。如果未保留输出路径，则返回 transcript 或 Session 路径；若均不存在，会明确说明没有保留引用。
正文仍保持有界并压缩其中的路径，取回引用则保留精确路径。

## 后台与前台

后台 launch 在 admission 和启动后返回。成功、失败或 partial 结果会生成紧凑、持久的 TUI result，并在原任务仍开放时送达来源 main Agent；空闲时继续整合，忙碌时等当前 turn 结束后排队处理。完整报告保留在 `/agents` 中。诊断事件日志仅保留有界尾部；滚动日志不会重复发送已观测的控制事件。

分组 TUI 结果描述整组的汇总状态和成员数。例如，`Agent group (2) failed` 表示至少一个成员失败；各成员的结果需要分别检查。
重新打开保留的 Session 条目时也使用相同文案。

delivery 绑定来源 Session/run 并去重。用户取消或显式结束任务会抑制迟到结果继续运行，但保留结果和规范引用供检查。活跃 Goal 使用其规范查询协调继续，避免同一结果产生竞争 continuation。

前台 launch 会等到结果就绪，再把它返回当前 Tool call。嵌套 fanout 始终归启动它的 child 所有，不能脱离该 owner。

## `/agents`

`/agents` 显示当前 Session 的 Agent 生命周期、保留结果、Result、Activity 与滚动有界 child transcript。
Transcript omission 会明确显示。
终态详情包括稳定的 outcome class 与原因、累计 turn、Tool call、input/output token、Provider 实际报告时的成本、
model attempt、resume 次数、Agent Target，以及是否支持 continuation。异常结束始终保持为 `incomplete` 或
`failed`；保留的 partial 证据不会被重新标成成功报告。

| 按键 | 操作 |
| --- | --- |
| Up / Down | 选择 Agent |
| Enter | 打开详情 |
| `x` | 停止 live Agent 或移除 terminal entry |
| `t` | 在详情中展开符合条件的 Tool 输出 |
| Escape | 返回或关闭 |

Footer roster 是紧凑生命周期视图。打开 Agent 管理时会替换 latest-prompt 行，让同一时刻只有一个界面负责控制。

## Context、model 与 Tool

Launch 可以请求 fresh 或 forked context、显式 model、一个 Skill，以及显式 Tool budget。Child 执行前会检查
容量、认证和 model 可用性。普通委派工作没有固定 turn 截止线，因此不会仅因 Agent 持续工作而终止仍有进展的运行。

每次 call 显式指定的 model 必须能在 Pi 当前 model registry 中解析。Agent 配置或 fallback 中不可用的 model
会被跳过并尝试下一个可用 candidate；当前 parent model 即使来自尚未注册的自定义 provider，仍会被信任。
包含 `owner/name` 的 model ID 只有在 `owner` 确实是已注册 provider 时才按 `provider/id` 解释。有 registry
证据时，child 报告的实际 model 还会与 launch candidate 核对。Provider failure 只会在 child 尚未产生有效活动时
轮换到 fallback，避免重复工作或外部 mutation。

`toolTimeoutMs` 为每个非等待型 Tool call 设置硬超时。task 级值覆盖 launch 值，launch 值覆盖 Agent frontmatter
与 `PI_SUBAGENT_TOOL_TIMEOUT_MS`。这些位置都未提供显式值时，普通 child Tool 不设隐式 deadline。本就需要
等待的 supervisor 与 intercom Tool 不受此限制。

`excludeTools` 从 child 的 ambient、显式、MCP 与 Suite 注入 Tool 中减去指定名称。排除 `subagent` 会关闭该
Agent 的嵌套 fanout；如果 Agent 的 Skill lazy loading 需要 `read`，则排除 `read` 会在启动前被拒绝。

每个 child 使用同一个 Pi Host binary，显式加载所属 Package，并关闭 ambient discovery。Context Management/Magic
拥有 child Context 压力和投影；Agents 保留 child protocol、Tool pairing 和可恢复证据。非 fanout child 不会得到
`subagent` Tool。

## 限制

默认 governor 限制为：

- 同时运行 20 个 Agent；
- 嵌套深度 3。

不设累计 launch 配额或默认总运行时间。调用者需要时，`timeoutMs` 可以设置显式 run deadline。

普通 launch 没有 turn 或 Tool-call budget。显式 `toolBudget` 可以限制 Tool call，`toolTimeoutMs` 可以限制单次
Tool call。

初始 child、model attempt、fallback 与 resume 共用一个持久 work unit。后续自动工作开始前，累计报告用量达到
1,000,000 个 input 加 output token，或 Provider 实际报告成本达到 5.00 美元时，governor 会请求关注。Provider
没有报告成本时，不会把估算值当成权威美元成本。guard 不会停止正在运行的 child。用户直接确认 resume 后，
会保留同一 Session 与累计总量。

显式 Tool 硬上限只阻止已配置的 Tool 名称。未配置的 Tool 与最终 Assistant 响应仍可使用，因此 Agent 能根据
已经收集的证据合成有界 partial 或最终结果。

## Artifact 与 isolation

Agent artifact 位于 Settings 管理的 Session root 中，与持久 Pi Session 相邻。普通委派不会创建项目
`.pi-subagents` 目录。

可选的逐 Agent worktree isolation 会保留已修改或状态不确定的 worktree，供后续检查。只有干净且归 runtime
所有的 worktree 可以自动移除。

更换或结束 parent Session 会安全取消进行中的 launch，并记录其最终状态。

冷恢复时，当前版本的生命周期 artifact 保持原有状态。无版本 legacy record 只有在当前进程或 writer 证据能
证明所有权时才保持 live；已有终态证明、进程已死、PID 已复用或所有权未知时，会投影为可移除的未完成 legacy
结果。恢复绝不会 signal 或 reclaim 未知 owner。

## 相关文档

- [Agents Module README](../../packages/pi-stuff/src/subagents/README.md)
- [命令参考](../reference/commands.md#工作控制)
- [Background Work](background-work.md)
- [Tool Display](tool-display.md)
