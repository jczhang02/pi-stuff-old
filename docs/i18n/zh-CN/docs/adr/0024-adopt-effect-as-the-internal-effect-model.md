<!-- translation-source: docs/adr/0024-adopt-effect-as-the-internal-effect-model.md; translation-source-sha256: 7ba799485e27c7d2b0ab2920c981b22291e616f42553cc7a04be3b70af557a00 -->

---
status: accepted
---

# 采用 Effect 作为内部副作用模型

## 背景

Pi Stuff 目前通过各能力自有的 Promise 与 `AbortSignal` 机制表达异步工作、取消、超时、重试、资源释放、
依赖提供和关闭。这些机制保留了正确的领域权威，但其执行语义在后台工作、Agents、上下文管理、
Code Mode、MCP、Web 及其他包含副作用的模块中反复出现。

本提案已在隔离 worktree 中以保持行为、达到可合并质量为目标完成评估。仅完成迁移并不等于提案被
接受：最终实现还必须完成仓库审查、认证和一次明确的 go/no-go 决策。

## 决策

Effect v4 是已批准的实现基线，可以直接用于生产实现，不是等待采纳的候选方案。这包括适用的公开
`effect/unstable/*` API 和官方 v4 平台适配器。根据功能适配程度及已验证的受支持 Host 兼容性选择它们；
RC、预发布或 `unstable` 标签本身不能成为推迟采用、要求 Effect v3 回退或等待稳定版本的理由。
相互兼容的依赖版本仍须精确固定，并遵循常规风险验证政策。本政策不承诺上游 API 稳定性，也不豁免
具体的兼容性失败。

在 Pi Stuff 软件包内部，将 Effect 用作每个包含副作用的生产函数的默认模型。I/O、失败、取消、并发、
时间、重试、资源、可变共享状态及有副作用的依赖提供均归入 Effect。确定性的纯计算、领域状态、
codec、格式化和投影继续使用普通 TypeScript，使模块接口中的纯度保持可见。这项要求适用于软件包的
生产运行时 Source，不包括测试工具、基准、构建工具、仓库检查或文档。这些 Source 仍遵守相同仓库质量
政策，但可以使用原生副作用来运行和观察公开运行时合同。
生产 Source 只通过公开的 `effect/<Module>` 子路径导入实际需要的 Effect namespace。由于套件直接执行
TypeScript 源码，根 barrel 与内部路径不属于生产合同。

Pi 仍是宿主。Effect 只拥有执行机制；Pi、Goal、Agents、后台工作、上下文管理及其他能力所有者继续
拥有既有的生命周期权威、持久状态、终止政策和可见结果。Pi、Bun、Worker、子进程、文件系统、网络
和第三方库通过能力自有的适配器与 Effect 衔接。Effect 取消仅表达取消意图，绝不替代实际停止或释放
外部资源的原生协议。

每个宿主事件总线（`pi.events`）为当前 Suite 安装 generation 持有一个 Effect foundation。建立在同一
事件总线上的所有 Pi facade 都通过既有宿主共享资源机制发现并共用它，而不会创建独立 runtime。
foundation 拥有一个根 Scope，每个 Pi 会话拥有一个子 Scope；每项能力可以为其长期存活资源再持有一层
Scope。由外部发起、包含副作用的 operation 仅在需要取消或资源所有权时获得 operation Scope；嵌套
helper 继承该 Scope，纯 helper 不创建 Scope。

替换会话时，旧 generation 先失效并开始关闭其 Scope，随后新会话成为当前会话，但不会强制一套全局
等待政策。每项能力保留既有合同：需要时，激活流程可以等待自己的旧资源清理；否则可让清理在后台
完成。foundation 会跟踪剩余 finalizer，使宿主最终关闭时能够在既有宽限期内汇合它们。generation
fence 阻止旧工作向新会话发布。Pi 无法注销的宿主注册留在资源获取之外，并继续使用这些 fence。

Suite composition 在 Capability 安装器之前注册 foundation 的 Session-start owner，随后在这些安装器的协议
处理器之后注册最终 Host-shutdown hook。因此，Capability 可以先完成既有的优雅原生关闭，再由 Scope
finalization 中断剩余工作并释放其资源。

任何 Fiber 都不得在没有明确所有者的情况下越过一次 operation 继续存活。有意在发起调用结束后继续
运行的工作必须 fork 到所属会话或能力 Scope，而不是脱离所有者的全局或 daemon Scope。既有生命周期
所有者仍负责取消、终止政策与 generation 有效性。

只有面向 Pi 的适配器可以执行 Effect 程序；更下层、包含副作用的模块返回 Effect 值，绝不启动逃离
其所属 Scope 的独立 runner。共享 foundation 仅负责 Scope 所有权、这个边界 runner，以及共用的关闭
和结果投影，并直接使用 Effect 原生资源原语。这里不建立统一的原生资源或 I/O 接口：文件系统、网络、
进程、Worker 与第三方桥接继续由各能力自有，因为它们的释放、错误与终止语义不同。

调用方能够恢复的预期失败使用 typed error channel。既有能力领域错误保持权威；原生适配器负责转换，
只有调用方必须据此分支或展示时才新增 typed error。这里不建立 Suite 级错误层级。不变量破坏与程序
bug 仍是 defect，interruption 与二者保持区分。最外层适配器把这些结果投影成既有诊断、领域结果和
宿主合同。Context service 与 Layer 仅用于跨 operation 共享的 effectful 或 scoped 依赖，或确实具有
生产与测试适配器的依赖。纯 helper 与局部值继续使用普通参数。

当 Effect 生态模块能够在保持行为的同时完整替换一个现有机制时，采用该模块。仅在未变机制外再包
一层 Effect 并不充分。这些模块留在能力接口之后，不替代面向宿主的合同；该边界与其发布标签无关。

第一实施阶段保留所有用户和宿主可观察行为，包括工具和命令表面、设置与会话格式、诊断、取消、
超时、重试、恢复和终止结果。产品重新设计须在行为等价通过认证后另行决策。

迁移首先建立 Scope、runner、错误和适配器基础，随后用三种代表性流程验证这套基础：用
`fetchCodexUsage` 验证简单异步网络工作；用既有宿主共享资源与 Tool UI 清理路径验证长期存活的 scoped
资源，同时让同步资源发现继续使用普通 TypeScript；用 `MagicWorkerClient` 验证 Worker 取消与关闭。
只有三者都保留既有合同、通过聚焦检查、删除对应旧机制并避免仅加 wrapper 后，才把同一模型扩展到
每条包含副作用的生产路径。验证失败时，必须先修改 foundation，再继续迁移。已完成的迁移将 `effect`
精确固定为 `4.0.0-rc.112`，版本更新置于测量窗口之外。这一历史证据冻结要求不是持续的采纳门槛；
后续版本变更遵循上文已批准的 v4 政策。

后续扩展以完整的纵向能力切片推进。每个切片在同一个连贯检查点中替换并删除原 Promise、abort、timer
或资源生命周期实现，只保留操作外部系统所需的窄原生适配器。迁移不建立长期双执行轨道。

仓库检查必须使完整性可审查。扩展既有 repository-safety AST 检查，而不另建 lint 框架。Effect
runner 仅限于面向 Pi 的适配器，而直接 Promise 构造、abort controller、timer、网络调用、异步文件
系统调用、Worker 和进程启动仅限于一份精简、明确的能力自有原生适配器清单。清单之外的生产 Source
默认禁止这些操作。审计拒绝在完整保留原生命周期机制的情况下只包一层 Effect。

## 考虑过的选项

- **只在选定的复杂流程中采用 Effect：**本实验拒绝该方案，因为它无法确定一套连贯的内部副作用模型
  是否能产生 Suite 级复用价值。
- **把每个函数都包装进 Effect：**拒绝，因为这会隐藏纯计算与副作用执行的区别，却没有增加失败、
  依赖、取消或资源语义。
- **让 Effect 拥有产品生命周期政策：**拒绝，因为 Fiber 与 Scope 结果并不能定义 Pi 会话、Goal、
  Agent、后台工作或上下文的领域结果。

## 后果

所有权树依次为 Pi 宿主、Suite 安装 Scope、Pi 会话 Scope、能力 Scope，再到 operation Scope 和 Fiber。
Effect 类型留在软件包内部，不替代 Pi 的公开 Extension、会话、工具、UI、Provider 或 Agent 合同。仓库
检查把有副作用的执行限制在这套模型内，同时让纯计算和能力自有的原生适配器保持明确。

2026-09-01 的第一次预注册对比没有通过。后续发现 acknowledgement fixture 有两个边界错误，修正后又暴露
出真实产品问题：直接输入会在 Host 确认前激活 Context。fixture 已补回归测试，Context 激活已移到确认之后，
完整决策集也以干净、固定的试验臂重新前瞻运行。优化后的原生对照包含研究期间找出的全部可移植优化。

重新认证没有发现生命周期回退，所有筛查不确定项都由更高样本证据解决，归档、Source、依赖和 typecheck
增长也都低于冻结门槛。与优化后的原生对照相比，Effect 实现的冷 import 耗时改善约 13%，CPU 改善约 11%，
最大 RSS 改善约 9%。本决策自 2026-09-02 起正式 accepted，重新认证的 Effect 实现成为采用的主线。最终证据、
测量修正与有界残余成本见 [2026-09-01 主线决策](../reports/effect-v4-mainline-decision-2026-09-01.md)。
