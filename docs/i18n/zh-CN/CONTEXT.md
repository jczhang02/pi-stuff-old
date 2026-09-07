<!-- translation-source: CONTEXT.md; translation-source-sha256: 2044c728bca869fdac4d91b0514f714881b5a80b949ad4bf02336a86f5cab845 -->

# Pi Stuff

Pi Stuff 为一组概念命名，用于在不取代 Pi 本身的前提下组合个人 Pi 能力。

## 语言

**Host**：
发现、加载并运行 Runtime Resource 的原生 Pi coding agent 进程。
_避免使用_：Suite runtime、custom agent

**Suite**：
被选择共同使用的一组紧密协作的个人 Pi 能力。
_避免使用_：agent、framework、platform

**Capability**：
Suite 中一项职责连贯、可独立理解的行为。
_避免使用_：feature bundle、miscellaneous extension

**Pi Stuff Package**：
向 Host 提供有序 Suite 的唯一一个本地 Pi Package。
_避免使用_：aggregate、launcher、wrapper CLI

**Capability Module**：
一个 Capability 在内部可独立理解的实现边界。它没有自己的 package manifest、版本、安装或发布生命周期。
_避免使用_：Capability Package、npm package、plugin fragment

**Repository-owned Source**：
由 Pi Stuff 仓库维护的代码，无论最初来自本地、fork 还是 vendored 上游材料，都承担相同架构、质量、兼容性
与认证义务。
_避免使用_：upstream exception、vendored exception、fork exemption

**Capability Contract Catalog**：
在认证 Host profile 内，Suite 所承诺的每一项用户或 Host 可观察行为的维护清单。每项 contract 标明所属
Capability、public seam、scenario、所需 evidence 与 acceptance status。一项 contract 表示一个稳定、可观察的
承诺，可以包含多个正常、失败、恢复、持久化或边界 scenario；私有 implementation function 与 scenario variant
不是独立 contract。
_避免使用_：Feature checklist、test list、function coverage

**Conditional Capability Contract**：
configured success scenario 依赖可选 executable、credential 或 external Service 的 Capability contract。它的
unconfigured behavior 仍是一项 unconditional contract；缺少所需 dependency 会阻塞 configured acceptance，
绝不能计为 passed、skipped 或 not applicable。
_避免使用_：Optional test、skipped feature、best-effort contract

**Capability Benchmark**：
针对单项或有限几项 Capability 的性能、资源使用或行为效果所做的专项评测，无论执行时是否使用完整 Host 或公开任务。它提供比较证据，不代替 Capability Contract Acceptance，也没有阻断 PR 的权利。
_避免使用_：Internal-only benchmark、correctness test、Suite Outcome Evaluation

**Suite Outcome Evaluation**：
在外部公开任务集上评测完整 Suite 的任务效果，并对比声明的配置，例如原生 Pi 与 Pi Stuff。它不证明每项 Capability 都已覆盖或通过验收，也没有阻断 PR 的权利。
_避免使用_：Pi Stuff score、harness certification、correctness test、Capability Benchmark

**Capability Contract Acceptance**：
使用每项所声明的 Acceptance Evidence Profile，在隔离 scenario 中验证每个适用的 Capability Contract Catalog
entry。deterministic 或 authenticated acceptance 可以认证 contract；Suite Outcome Evaluation 不可以。
_避免使用_：Feature smoke test、function coverage、benchmark pass

**Acceptance Evidence Profile**：
一个 Capability contract 所声明的执行边界：必须使用精确的真实 Host；当行为依赖 live Provider 或 live external
Service 时分别标明。fixture Provider 属于 deterministic evidence，不是 live evidence。
_避免使用_：Realness level、truth test、production-like test

**Diagnostic Record**：
供人检查的、有界且仅限当前进程的 Suite 问题记录。它绝不进入 Session 历史或模型上下文。负责该状态的
Capability 在自己的界面呈现普通状态；只有与用户有关的问题才可以触发共享单行提示，详细内容通过
`/diagnostics` 查看。
_避免使用_：console warning、transcript message、notification log

**Runtime Resource**：
Host 通过 Pi Package 契约发现的 Extension、Skill、Prompt Template 或 Theme。
_避免使用_：asset、plugin file

**Skill Discovery**：
由 Host 拥有、位于模型上下文中的已启用且允许模型调用的 Skill 目录，展示每项 Skill 的名称、描述和位置，
使 Agent 可以选择并读取匹配的 Skill。它只展示 Skill 元数据，不会预先读取 Skill 正文。
_避免使用_：Skill search、eager Skill loading

**RTK Runtime**：
独立安装并经过认证的 RTK 可执行文件。它的 CLI 负责 RTK 命令改写与输出优化；Suite 只适配 Host，不复制其
改写 registry 或安装生命周期。
_避免使用_：Embedded RTK、Pi Stuff command parser

**Session Name**：
由 Pi 拥有的 Session 元数据，为一段编码对话提供简短语义身份。Session Naming 可以在用户直接发起的工作
settled 后提议并持久化它，但它不取代 Session、task、Goal 或 Agent 名称。
_避免使用_：chat title、task name、autoname state

**Settings Layer**：
由用户拥有、用于为一次 Host 安装选择和配置 Package 与 Runtime Resource 的声明。
_避免使用_：Suite configuration、installer state

**Settings Namespace**：
`<agentDir>/pi-stuff.json` 中由一个 Capability 拥有的顶层对象。owner 可以读取和替换该对象，同时保留 sibling
namespace；合并文件、lock 与 atomic write 仍是共享基础设施。
_避免使用_：Capability settings file、global config

**Vibe Line Spinner**：
指示 Agent 工作正在进行的 Host 原生动画字符。它是活性信号，与运行提示、Thinking 对话记录内容及其他
Conversation UI 内容不同。
_避免使用_：Vibe Line、Working Row、Thinking 显示

**Logical Thinking Run**：
持续更新且可见的一段 reasoning，被视作一个 narrative unit。之后另行出现的可见 reasoning segment 是新的
run；streaming delta、终端换行和重绘都不是。
_避免使用_：Thinking row、terminal line、provider content index

**Narrative Boundary**：
把一个 Tool 执行阶段与下一阶段分开的可见事件：Assistant 正文、用户输入、模型上下文可见的 Custom Message，
或 Tool activity 之后的新 Logical Thinking Run。当前 Logical Thinking Run 内的更新、隐藏状态、branch 或
compaction 元数据都不会产生新边界。
_避免使用_：Assistant message boundary、API turn、physical terminal row

**Agent Work Duration**：
一次用户启动的 Agent 工作周期的墙钟时长，减去 Pi 等待 UI prompt 响应的区间。Notification 用它比较所配置的
最短时长阈值；Goal 的活跃 elapsed time 与 Host 生命周期计时不变。
_避免使用_：包含 prompt 等待的运行时长、Goal elapsed time、model latency

**Work Continuity Contract**：
Suite 的保证：当前 Session 所属工作不会仅因内部 accounting、retained evidence、completed-work total 或
productive elapsed time 跨过任意阈值而进入 blocked 或 terminal 状态。用户或 Host 的生命周期权威，以及可恢复的
cost、runaway、external-availability 和 integrity control 不受此保证约束。
_避免使用_：Unlimited execution、cross-Session daemon、no limits

**Tool Activity**：
只用于显示的单元，代表一次独立 Tool invocation 或一个 Retrieval Group。它的 projection 不合并或改变底层
协议事件、顺序或 Session 历史。
_避免使用_：Tool call、Tool row、Tool Activity Group

**Retrieval Group**：
对一段有界、连续的原生 Read、Grep/Find 或 List invocation 生成的仅显示摘要，但不包含 resolved basename
恰好为 `SKILL.md` 的 Read。更长的连续运行会显示为有序 continuation segment；Narrative Boundary、独立 Tool
Activity、automatic continuation 或 turn completion 会关闭这次运行。
_避免使用_：Exploration group、Tool batch、merged Tool call

**Skill Tool Activity**：
针对 resolved basename 恰好为 `SKILL.md` 的原生 Read 所形成的独立 Tool Activity。它从 resolved parent
directory 派生 `Skill <name>`，同时保留底层 Read protocol，并形成 Narrative Boundary。
_避免使用_：Native Skill row、Skill Retrieval Group、Skill registry result

**Operation Block**：
一种只用于 Transcript 显示的独立、证据丰富 Tool Activity projection，在 invocation 的原始位置展示有界的
`Tool(operation identity)` parent 与缩进的 child outcome evidence。它是封闭 family，只包含 Bash、Write、
Edit、Patch、Background output 和没有匹配 owner 的外层 Code Mode issue；它不是通用 Tool card 或 grouping rule。
_避免使用_：Tool card、Universal Tool Block、Command Block
**Bash Operation Block**：
Operation Block 的 Bash 特化，展示一个有界 command identity 与 child output preview。call 内部的 shell
composition 仍是一项 operation，底层 Tool result 与 Session record 不变。
_避免使用_：Command group、parsed subcommand、Retrieval Group

**Envelope Fallback Row**：
只有当没有 nested operation 或 media projection 负责用户可见结果时，才用一条普通 Tool Activity 表示
envelope；它也覆盖没有匹配 owner 的外层 error、rejection 或 cancellation。有效 nested activity 仍是唯一
可见权威；缺失的历史 definition 与 presentation failure 改为在原始 source position 使用 generic activity。
_避免使用_：Envelope chrome、raw Tool result、duplicate error row

**Control-only Execution**：
只携带 Host scheduling 或 continuation signal、没有用户相关工作结果的 Code Mode execution。它作为诊断证据
保留，而不是 Conversation Transcript 事件。
_避免使用_：Internal wait、empty Code Mode call、no-op Tool

**Execution Ledger**：
存放在 Pi Session custom entry 中的 Code Mode 权威 append-only replay 与 recovery 状态。它保存准确的 canonical
completion payload，不施加累计 work quota，并把 effect 后的持久化失败视为 incomplete；它不是第二个数据库或
面向模型的 transcript。
_避免使用_：Code Mode database、recovery log

**Tool Discovery**：
面向模型、在当前 active Package-owned Tool catalog 上执行的搜索。它返回有界、排序后的匹配来帮助调用相关
Tool；当 catalog 没有匹配时，绝不替换成无关 Tool。
_避免使用_：Tool recommendation、Tool activation

**Agent Context Usage**：
一个 Child Agent 当前 Provider payload 的 token 估计值，以所选 Child Host model 报告的 Context window 为
基准。权威 Assistant usage 会替代估计值；之后的 Tool result 与其他尾部 message 增加有界 Host-equivalent
估计。Parent Host 的 model metadata 只在 launch 时临时备用，直到 Child Host 报告真实选择。它不是累计 run
usage。Context Management/Magic 拥有 child pressure 处理；Agents 不会依据本地估算终止 child 或替换 Provider request。
_避免使用_：Agent tokens、total Agent usage、Context budget

**Agent Target**：
Agent control action 使用的公开二元组：稳定 Agent run ID 与 child index。模型可见 status 会分开暴露二者；
内部 roster row key 是显示身份，不是 Agent Target。
_避免使用_：Agent key、child address

**Agent Lifecycle Row**：
一次 Agent Tool lifecycle event 的仅显示 Transcript projection。Background launch 与 completion 保持为分开的
chronological event。Agents 拥有 lifecycle 和 protocol evidence；Context Management/Magic 拥有 child pressure 投影，delivery 将有界结果返回来源 main Agent。
_避免使用_：Agent Operation Block、Subagent Row、Agent roster row
**Context Activity**：
一次由用户发起的 Context maintenance operation 所对应的、模型不可见且持久化的 Session record。一条可见
Pi Stuff row 投影其 anchor，并在 resume 后继续更新。它不是 Tool call、Diagnostic Record 或 Statusline item。
_避免使用_：Context Tool Activity、Context notification、Context status

**Bounded Context Projection（有界上下文投影）**：
Context Management 按请求方用途生成的派生上下文。本地容量估算用于显示和主动压缩，不能证明 Provider 会接受请求，
也不能授权取消前台执行。启用 Magic 时，前台使用 Magic 投影；BTW 和 Agents 保留各自的有界引用契约。
投影无法恢复时保留输入并停止，不替换成原始历史。
_避免_：安全上下文、已验证容量保证

**Prompt Contribution**：
由 marker 包围、属于 Capability 的 system-prompt fragment。Context Management 在每次 Provider activation
时排序并协调它，而不改变 Session 历史。它不是独立生命周期，也不是替代 system prompt。
_避免使用_：Prompt injection、appended system prompt、context patch

**Ponytail Mode**：
Session 选择的 `off`、`lite`、`full` 或 `ultra` 实现纪律级别。它持久化在模型不可见的 Session entry 中，并
在 delegated Agent launch 时建立 snapshot；`review` 是 Skill，不是 Ponytail Mode。`off` 是硬模型边界：
Ponytail 不贡献 standing instruction 或模型可见 Skill catalog，但显式 Skill command 仍可用。
_避免使用_：Review mode、Agent mode、global mode

**Context Engine Worker**：
Context Management 内部的 Bun Worker，使完全相同的 Magic Context derived-state engine 离开 Pi UI 线程运行。
它接收不可变 Host snapshot，并通过窄 adapter 返回 Context 结果；CLI、TUI、Session、model request 与 Agent
lifecycle 仍由 Pi 拥有。
_避免使用_：Context Host、Context runtime、transcript worker

**Fenced Visualization Projection**：
在 Conversation Markdown seam 上，把完整且有效的 `chart` 或 `tree` fenced code block 转换为宽度有界终端
文本的仅显示 projection。canonical message text、Session record、copy/export source 与 Provider context
保持不变；验证失败时保留原始 fence。
_避免使用_：Fenced Block plugin、visualization runtime、transformed Session content

**Todo Task**：
由 Suite Task Tool 与 checklist 维护的一项计划工作。它描述意图；不是正在执行的 process、wait 或 Agent。
_避免使用_：Background task、job

**Background Work**：
当前 Session 中不占用 main Agent、可继续运行的 activity，包括 Background Shell 或 Monitor。它是实时管理
状态，不是 Todo Task、Agent projection、Tool invocation 或 durable history。
_避免使用_：Todo、daemon、scheduler

**Background Shell**：
由 Host Session 拥有的操作系统命令，在显式 background launch 或 foreground detach 后独立继续。它随当前
Host Session 结束，绝不会变成跨 Session daemon。
_避免使用_：Job、service

**Foreground Handoff**：
仍在运行的前台 Bash invocation 转换为 Background Shell 的过程，无论它由 `Ctrl+B` 请求还是由 runtime
阈值触发。它改变执行位置，但保留当前用户工作接收并处理 terminal outcome 的义务。
_避免使用_：Implicit background launch、fire-and-forget

**Monitor**：
在 Background Work 中对一个明确可观察条件进行的一次性等待，例如 command result、log match、file state
或 HTTP response。它不是 polling conversation、recurring loop 或 schedule。
_避免使用_：Watcher、cron、polling task

**Completion Report**：
面向用户的 Assistant response，说明请求的工作是否完成，给出决定性的 terminal evidence，并指出任何剩余
工作。原始 Background Work outcome notification 或紧凑 Goal 终止 Tool result 是 delivery 或 status input，
不是 Completion Report。
_避免使用_：Completion notification、Background command row、Goal Tool summary

**Goal Final Response**：
在接受 complete 或 blocked 终止状态后，预算或其他强制停止边界未阻止 follow-up 时请求的 Goal 专用
Completion Report。它负责 Conversation Transcript
中面向用户的详细 Goal 结果，并在同一次前台 Agent run 中完成；它不是紧凑终止 Tool result、Goal 状态、通知
或合成的 Session message。
_避免使用_：Goal completion message、Goal Tool summary、completion notification
