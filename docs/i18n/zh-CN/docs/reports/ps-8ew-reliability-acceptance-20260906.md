<!-- translation-source: docs/reports/ps-8ew-reliability-acceptance-20260906.md; translation-source-sha256: 016e988184a52a64608e7e4b22d9c33ef2edd1fe26930c882770a8c56ebeea12 -->

# ps-8ew 可靠性修复验收

日期：2026-09-06。Beads：`ps-8ew`、其修复子项，以及最终认证项 `ps-8ew.2`。

基线：`d620c43dba9f904e7c895c708a535ab5715fb4fc`。运行时候选：`48a3de5072b2cb95e3e5b8320cbb29f297abdc67`。
分支：`fix/ps-8ew-reliability`。本报告记录本地证据；必需 CI 的结果单独关联到交付 PR 的 HEAD。
本地检查通过或保存了 Agent 报告，都不代表代码已经合并或安装。

## 修复

子 Agent 的 Context 现在只有一个投影所有者。Agents 不再删除工作历史，也不会仅因 token 估算拒绝请求。
Context Management 与现有 Magic Worker 负责投影和恢复；Pi 持久化已接受的输入及压缩边界。
Magic 补丁保留带签名的推理内容，并在压缩后重建投影前使缓存失效。这两个缺陷都通过真实子 Host hook 复现。

隔离启动按照相对于仓库根目录的位置映射任务目录。runner 在启动前将得到的 worktree cwd 写入恢复描述符，
冷恢复读取该描述符。缺失恢复数据会进入 runner 的普通失败和清理边界。
嵌套目录启动不再重复拼接子目录，也不会恢复到共享检出目录。

已锁存的 pause、stop 和 timeout 会作用于启动期间新注册的控制器，模型回退前也会检查这些终止原因。
完成文件缺失时，前台恢复优先使用权威最终报告。后台结果携带有界的权威发现和产物引用进入主 Agent；
交付由接收凭证和 Session 身份控制。主 Agent 可以无需用户再次发消息就完成原任务。
Goal 仍拥有继续策略；迟到结果不能重启已关闭、已取消、已替换或明确结束的工作。
一次真实 Provider 运行还暴露了 Session teardown 后的迟到 Goal settlement 回调；现有生命周期检查现在会拒绝它。

## 环境与证据边界

检查使用 Bun 1.4.0 和认证 Pi 0.85.1，其发布源代码提交为
`d981de1229ef899957bbe968bc8dcda02a21f477`。Package 认证使用官方 RTK 0.45.0，执行文件 SHA-256 为
`99e0cff729d52297a23eb832f809d9773ba7c32de818dfe76b2cdd900a951535`。
Code Mode 使用缓存的 `rust-v0.145.0` V8 Host，执行文件 SHA-256 为
`60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`。

下述确定性 Provider 场景运行真实 Pi 进程、Tool、Git worktree 和 Magic Worker。
注入的超限响应不能证明远端 Provider 的容量上限。在线运行使用经过认证的 `openai-codex/gpt-5.6-luna`；
公开 RPC 手动压缩与真实远端超限分开记录。临时认证副本和诊断 Session 不进入 Git。

## 决定性场景

| 场景 | 证据与结果 |
| --- | --- |
| 子 Context 反复承压 | 真实 fresh 和 forked 子 Agent 通过实际 Magic Historian 处理两次注入超限。其间八次 Tool 调用、带签名的 Assistant 内容、配对 Tool ID、既有发现、两个已完成检查标识及 steering 在最终报告中仍可使用。child-pressure 与既有 recovery Host 检查合计 14 个测试、116 个断言。 |
| 嵌套隔离启动和冷恢复 | 真实后台、前台任务均在 `worktree/sub` 写入；暂停并关闭父进程后，重新打开父 Session，通过公开 Agent Tool 恢复。恢复后的写入仍位于保留目录，旧文件存在，共享检出未改变：2 个测试、14 个断言。 |
| 启动和回退取消 | 生产 runner 测试覆盖 pause、stop 和 timeout，检查终止结果及真实 writer 文件效果，并保留进程树清理和定向子任务控制。回退之间的三种控制通过 10 个断言。pause 阻止第二个 writer；异步 stop/timeout 在 inbox 消费请求前可能已分配 writer，但终止会阻止其后续文件效果和成功结果。 |
| 完成结果恢复 | 完成文件缺失时，恢复优先返回权威 `finalOutput`，而非之后的进度文本。失败和部分结果保留原分类。完成交付测试也将具体最终发现置于过时进度摘要之前。 |
| 主 Agent 结果整合 | 真实 PTY Provider 收到隐藏子结果，使用最终摘要生成 `FINAL_DELIVERABLE_FROM_BACKGROUND_RESULT`。busy/idle 批量交付、重复凭证、Goal 协调、取消、Session 替换和 shutdown 有定向回归。 |
| 在线有用交付物 | 在线 Luna 主 Agent 委派仓库审查，自动收到子结果，执行后续检查并写出所需报告，全程无需第二条用户消息。最终运行正常退出，extension error 为零。 |
| 在线手动 Context 压缩 | 十二次在线读取积累合成证据。公开 RPC 压缩持久化真实 Magic 边界（`tokensBefore=79939`，压缩后估算 22002，ordinal=19）；后续在线最终报告无需再次获知名称即可恢复两个既有事实／检查标识。这证明合成证据的手动恢复，不代表真实代码检查身份或远端超限。 |
| 在线代码审查经过反复压缩 | 全新在线子 Agent 用 14 次原生 read 读取 14 个不同源文件，并执行一次检查命令。两次公开 RPC 压缩持久化真实 Magic 边界，压缩前 token 分别为 41948 和 40810。最终报告保留两项最初代码观察、函数／路径证据、精确命令和 20 个测试通过的结果，没有重复读取或重复执行检查。原始 Tool 证据为 20 通过、0 失败、118 个断言；最终模型报告没有保留失败／断言总数。extension error 为零，stderr 为空。 |
| Code Mode | 显式真实 V8 执行通过 11 个测试和 41 个断言，覆盖嵌套 Tool 失败、图像验证、回放、审批及副作用后的持久化失败。 |
| 普通 Tool、reload 和 resume | 打包源码安装认证通过既有真实 Pi RPC／PTY 矩阵，覆盖成功和失败 Tool、Goal reload、冷 Tool resume、Agent 执行及共享可见界面。 |

## 检查与失败运行记录

`bun run check:fast` 通过格式、lint、严格类型、未使用代码／依赖、生成结果、仓库安全和 Capability 契约检查。
最终补充测试也通过类型检查。Tool Activity benchmark 验收通过。
`bun run pack:verify` 通过：一个本地 Package、600 个文件、Pi Host 0.85.1。

要求的完整测试命令运行了所有 298 个已发现的隔离测试文件。首次结果为 2,094 个测试通过、五个文件中的六个测试失败，
以及 13 个跳过。所有失败均已诊断：过时的投影／产品文本断言、worktree fixture 缺少已持久化的恢复描述符，
以及与 fixture 不符的 PTY 顺序／usage 预期。修正后相关场景通过。后来新增的隔离恢复 Host 文件单独通过。
Goal 独立 runner 通过 318 个测试及其运行时 smoke 场景。默认跳过的 11 个 V8 场景在显式开启后通过。
这些是多次已记录运行中的组件结果；首次完整命令并未以成功状态退出。

在线代码证据保存在 `.artifacts/ps-8ew-acceptance/live-coding-{session.jsonl,rpc.jsonl,final.json}`。
最终模型报告称缺失的测试总数没有显示，但原始 Tool 结果确实含有这些总数；额外总数由验证器确认，
不声称模型保留了它们。检查身份及通过结果得以保留。
较早的代码 harness 使用了错误源路径和旧 Session cwd；其中失败的检查及不一致的模型摘要被拒绝，随后才运行全新修正场景。

首次 Package 运行停止于本机 RTK 执行文件版本正确但认证指纹不符。
验证器保持严格，重跑使用已经存在的官方执行文件。
较早的在线诊断 wrapper 没有 `await` 异步 Extension factory，导致其自身加载失败。
修正 wrapper 后捕获了独立的生产 Goal teardown 缺陷；对应回归和最终在线运行均通过。

独立 Standards、Spec 审查及要求的维护性审查，在最终受影响范围中没有发现未解决的阻塞问题。
[fork 适配审计](../research/pi-stuff-reliability-fork-audit-20260906.md) 记录匹配的上游版本、保留的适配器、
被删除的保护和替代证据。源代码物理行数变化：删除的竞争投影器 546→0；completion handling 217→319，
另有 139 行纯报告投影；process engine 799→798；child task runner 567→591；background runner 421→463。

原始本地日志保留于 `.artifacts/ps-8ew-acceptance/` 及相邻的 `ps-8ew-*.log`。
本报告不声称完成在线远端超限验收、资源 benchmark、合并、安装或私有日志发布。
最终关闭 Beads 要求交付版本的 CI 和全部声明场景通过；失败或缺失的证据保持明确，不转换为通过。
