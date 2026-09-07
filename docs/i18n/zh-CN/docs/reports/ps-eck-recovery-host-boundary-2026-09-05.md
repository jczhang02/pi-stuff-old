<!-- translation-source: docs/reports/ps-eck-recovery-host-boundary-2026-09-05.md; translation-source-sha256: f2d85f84afd3d84b751b2860370c5da7d04cffa08dde79fae552d9ef87b305ff -->

# ps-eck：Magic 恢复与 Host 取消边界

日期：2026-09-05。状态：实现已提交，最终在线验收被 Provider 额度阻塞，尚不具备发布条件。

分支为 `fix/ps-eck-magic-recovery`，基线 `2610bd42`。签名检查点为 `e87a1e33`（身份）、`673e6a8b`（恢复）、
`c833a3fc`（失败 Worker 注册清理）、`143b7e5f`（增量身份清理与 no-op 记账）。均已推送，未合并或安装。
接受的契约见 [ADR 0031](../adr/0031-preserve-magic-context-behavior-through-suite-integration.md)。

## 根因和实现

固定版本的上游 Pi 适配器错误地把消息数量相同当作位置身份相同的证据。保留的旧压缩摘要与已持久化的失败 Assistant
回复会抵消数量差异，却使身份错位。补丁删除该捷径，每次使用 Magic 现有的引用和唯一指纹解析器。

此前因果 A/B 使用认证 Pi 0.84.4 与重建的事故状态。两组初始请求哈希相同；注入连接中断后，故障组重试从
371,210 膨胀到 5,397,756 字节，显示仍为 49.695%，远端真实拒绝。仅修正身份匹配后，重试保持 371,210 字节并成功。
这证明因果机制，不代表精确还原历史被拒载荷或数据库状态。最终发布认证另使用 Pi 0.85.0。

最终日志审计发现该捷径删除不完整：增量分支更新仍调用已删除的资格判断函数，并更新已删除的位置列表。补丁现已
同时删除这段失效更新。真实 Worker 的保留摘要回归还会拒绝任何分支投影失败，防止两次相同的降级结果掩盖增量路径错误。

之前的 Suite 策略又引入独立问题：原生兜底改变压缩责任方，95% 本地估算门槛则在没有实际 Provider 超限证据时拒绝
请求。新适配器坚持 Magic 独占，删除额外 Provider 投影复用缓存，估算仅供显示。小范围固定依赖补丁把既有 Historian
接到 Pi 自定义压缩钩子，返回真实摘要和持久化边界。

真实 Worker 终止测试还暴露了致命错误与压缩路径竞争清理的问题：一次清理会使替代 Worker 的 generation 失效。
现在致命通知只标记引擎不可用，有界关键恢复路径负责自动清理和替换。显式输入与新会话激活也必须先清理旧的已提交
注册，再替换失败的 Worker。回归测试从这两个入口复现旧 Worker 处理器残留，并验证修复后只有替代 Worker 收到
后续会话事件。不包含 Pi 或传输策略补丁。

## Host 证据

最终 Host 检查使用认证的 Pi 0.85.0 Linux x64 发布产物，源码提交
`107d79f11072bbc8a3a757ed7fd69596bee7d68c`，二进制 SHA-256 为
`0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072`。早期探索使用不同哈希的本地二进制，
不作为认证证据。新增恢复测试在执行前检查来源。

将 `PI_BIN` 指向核验后的可执行文件，运行：

```sh
bun test test/acceptance/context-management/magic-recovery-host.test.ts test/component-integration/context-management/magic-worker.test.ts test/acceptance/context-management/context-pty.test.ts
```

认证 Host 上 14 项 RPC/PTY 测试通过：12 项恢复场景与 2 项 Context TUI 场景。另有 8 项真实 Worker 回归在仓库
Bun 运行时通过。测试使用隔离的一次性会话与确定性 Provider，执行真实 Magic 压缩和真实 Worker 终止。
注入的超限消息证明控制流程，不证明远端容量上限。

| 场景 | 观察结果 |
| --- | --- |
| 直接运行带补丁 Magic 与完整 Suite | 一次真实钩子压缩，Pi 重试成功，接受输入只持久化一次。 |
| 已完成 Bash 工具 | 仅执行一次、产生一次副作用；重试上下文保留持久化结果。 |
| Historian 瞬时失败 | 现有 Magic 重试成功，无额外前台调度器。 |
| 压缩前 Worker 终止 | 一个替代 Worker，一次 Historian 结果。 |
| 持久化发布后 Worker 回执丢失 | 一个替代 Worker 复用完成状态，不重跑 Historian。 |
| 完成状态不确定或无进展 | 一次说明，不发送重试请求，保留输入。 |
| 第二次 Provider 超限 | 两次请求、一次压缩，不无限重试，保留输入。 |
| 有排队输入时显式取消 | Magic 停止；后续队列交付与仅 Host 对照一致。 |
| 真实 TUI 中 Context 不可用 | 当前输入持久化，显示原因，不发送原始 Provider 请求。 |

仅 Host 的取消对照加载支持信号的压缩夹具，不加载 Magic 或 Pi Stuff。Pi 先等待 `agent.prompt()`，再等待
`_checkCompaction()`，随后决定是否执行 `agent.continue()`。取消后的队列交付是维护者已接受的 Host 原生行为，
不属于本次修复。生产代码不清空、不重交队列。同一串行前台流程不会让投影与自身超限压缩并发；BTW/Agents 投影
不会清除前台恢复额度。

## Provider 证据和审查状态

现有真实 Provider 门槛已在认证可执行文件上通过，覆盖普通 Magic 压力/压缩及会话生命周期。专门的真实超限验收也已
通过：前台使用窗口 128,000 token 的 `openai-codex/gpt-5.3-codex-spark`，真实 Historian 使用
`openai-codex/gpt-5.6-terra`。自动构造 40 对已完成 artifact 消息，每条用户消息含 160 个确定性 SHA-256 校验串，
不发送私人会话内容。

| 真实执行 | 第一次请求 | 重试请求 | 结果 |
| --- | --- | --- | --- |
| 完整 Suite | 480,302 字节，远端超限 | 63,070 字节 | 成功继续，当前输入一次，无工具执行。 |
| 直接运行带补丁 Magic | 463,661 字节，远端超限 | 46,423 字节 | 同样成功继续，保留边界相同。 |

两次运行均持久化一次真实 Pi 钩子压缩，结束于 ordinal 78。载荷大小差异来自 Suite 提示和工具贡献。
同一恢复阶段产生八个持久化 compartment，之后 Pi 仅重试一次。初始 Host 估算为 105,351 token，但远端仍实际拒绝，
证明估算本身不能决定准入。真实 Historian 输出使摘要字节数有所变化。

验收发现并修复两项草稿缺陷：单个 Historian 分块不足以恢复；Historian 内外嵌套持久消息读取器时，内层清理使剩余
历史不可见。恢复现在连续处理可运行分块并核验进展，每次边界读取独立绑定读取器，实际超限使用 Magic 紧急尾部策略。
确定性 Host 的 `multi-step` 回归保护此行为。夹具本身不证明真实容量。

最终源码提交 `143b7e5f` 连续通过两轮独立 Astra 正确性与 Thermo-Nuclear 审查，范围为完整 diff 及受影响 Capability。
早期无发现结论在后续修改后失效；最终两轮包含增量身份修正及 no-op 记账修订，均无阻塞项。第一轮还运行了 136 项
Context 测试及 12 项认证 Host 恢复测试；第二轮独立审阅完整源码，避免与验收进程争抢资源。

最终日志审计还发现上游记账缺陷：三个分块前 Historian no-op 返回保留初始 `failed` 状态。补丁在这些分支完成清理后
将其记为 `noop`，实际失败分支仍保留失败。真实 Provider 的严格门槛没有放宽，也不忽略失败记录。此前验收已完成
压力、取消、会话切换、冷恢复和隔离流程，随后才因这些 no-op 记录被拒。

最新在线运行触及 Provider 额度上限。一次最终补丁运行完成真实 Historian 发布，随后连续性检索收到额度错误；
下一次在初始化阶段收到相同明确错误。因此最终源码 `143b7e5f` 上的完整在线门槛尚未通过。此前真实超限恢复和普通
验收成功仍属于有日期的证据，不代表最终源码在线认证。另一次真实模型切换探针从 Terra 切到 Spark 成功，两个模型的
出站请求均保留完整当前输入。请求观测只记录模型 ID、字节数和输入存在布尔值。

本地日志保留已知测试中断：依赖安装时 SDK 文件短暂缺失、重型验收并发时 PTY 进程失败、schema 夹具短暂遇到 SQLite
锁。失败的隔离测试在安装完成后串行复验，不通过放宽生产策略使夹具通过。Goal/Ponytail/工具分组夹具明确选择各自
原生 Context 范围；Goal 夹具使用既有固定 Code Mode Host 路径，不再为每个临时缓存重新下载。

最终离线结果：`check:fast` 通过。最后一次 `bun run check` 执行全部 294 个隔离测试文件，292 个通过；两个被中断
文件随后串行补跑通过。之后 Goal 检查、Tool Activity 基准和打包 Package 认证均在最终源码上串行通过。这是多次运行
合起来的完整组成项证据，不代表原先整条命令以成功状态退出。两轮最终无发现审查后没有再修改代码。

实际行数为 runtime 791 到 796、projection 346 到 282、Worker client 421 到 425、Statusline rendering 507 到 508。
原生预检（89 行）是提取出的仅原生策略；recovery（51 行）负责共享关键阶段额度。原生预检绝不作为启用 Magic 后的兜底。

身份修复子项 `ps-5r4` 已在 Beads 关闭。较大的 `ps-eck` 保持进行中，直到 Provider 额度不再阻塞最终在线验收且所有必需门槛均记录。
会话、载荷、凭据和私人运行路径不进入本报告或 Git；临时认证副本已删除。
