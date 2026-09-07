<!-- translation-source: docs/research/pi-085-compatibility-20260905.md; translation-source-sha256: 3147c497add8c1b0df98d073941eea25270bb5e507a4cc391b575502a00b2f61 -->

# Pi 0.85.0 兼容性评估

日期：2026-09-05。仓库快照：`2610bd42`。本次仅评估实现，未运行验收测试。

## 结论

Pi Stuff 已固定到 Pi 0.85.0。本次调查尚未证实存在额外的必修实现缺陷。
兼容性决定现在采用版本加行为：Pi 0.85.0 的公开 API 与真实 Host 能力验收通过后即可支持。已有测试定义和认证声明
不能替代本次实际运行证据；在声明某个安装通过前，仍应运行适用的验收检查。

| 可执行文件 | SHA-256 | 字节数 |
| --- | --- | --- |
| 本地 Host | `f5f6e08211f44c11f048aac4d3321a7922021fcb40a3952c2587fe2e0df46f49` | 94,672,072 |
| 先前仓库参考产物 | `0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072` | 105,764,992 |

这些测量只说明历史产物不同，不能作为当前准入条件，也不能直接证明源码不同。本地 npm 包与 Host 的更新日志一致，
无法据此确定是否存在额外源码修改。当前兼容性由受支持 Host 合同及其真实 Host 能力验收负责。

## 版本变化与应对

[官方发布说明](https://github.com/earendil-works/pi/releases/tag/v0.85.0) 和
[固定版本更新日志](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/CHANGELOG.md)
记录了相对 0.84.4 的变化，没有声明破坏性变更章节。

| 变化 | Pi Stuff 应对 |
| --- | --- |
| 默认编辑器内嵌运行指示器，并使用 thinking 等级颜色 | 可选接入。Suite 的 `InputEnhancementEditor` 没有暴露 `setWorkingStatusIndicator`，Pi 会按设计保留独立运行行。仅转发方法还不够，被包装的编辑器也需要启用对应渲染。 |
| 全屏跳转最新消息、搜索提速、拖选修复 | 保留 Host 行为；用真实 PTY 验证导航、搜索、选择、缩放及 Suite 编辑器共存。 |
| Anthropic effort 持久化及签名 thinking 恢复 | 保留 Provider 所有权；使用相关传输时，验证 effort 切换与恢复、委派 Session。 |
| 可恢复内存 Session、SDK client 入口恢复 | 增量 API，不需要另建 Session 层。 |
| fork 保留压缩边界、内存 fork 等待当前 turn 稳定、RPC abort 取消手动压缩、分支摘要输出额度增加 | 优先验证 Context/Goal 取消、fork/恢复及续跑。尚未接受的 Magic-only 恢复提案不能混同为已接受的 Host 兼容合同。 |
| 内置工具遵循 `ctx.cwd` | 验证子 Agent 与其他目录中的工具确实使用目标 cwd；本次没有证据支持添加推测性的兼容层。 |
| Bash-only Skill 发现与 Provider stream/tool delta 修复 | 验证受限工具发现与 RPC 流式 fixture；复用原生修复。 |
| Codex 终止 SSE、Copilot reasoning、Fireworks adapter、Baseten 图片元数据、Qwen 目录、Grok 移除 | 不替换 Suite Provider；仅受影响的用户模型配置需要调整。 |
| vLLM priority、Responses 输出限制、LaTeX join 符号 | 原生可选能力，不需要强制增加 Suite 功能。 |
| 代理/NO_PROXY、musl 工具下载、seccomp 启动、Zed 图片、EXIF、并发分享、导入文件名、write 字节统计修复 | 复用原生修复；检查 Suite 工具展示能接受新 write 结果。平台认证范围仍遵循现有基线。 |

队列清理、不触发 turn 的消息顺序、图片 MIME 检测、工具后的压缩阈值检查已出现在 0.84.4 日志中。
它们仍属于 0.85.0 兼容范围，但不是本次新增能力。

## 已有适配与剩余工作

[兼容性文档](../compatibility.md) 已记录依赖固定、仅开发环境的 `pi-server` 补充、Thinking MouseRegion、
RPC partial fixture、队列归因、原生 settings、PowerShell 名称策略与公开图片 MIME 接口。
源码检查确认已有相应实现，本次没有重跑验收。[输入包装器](../../../../../packages/pi-stuff/src/conversation-ui/input-enhancement.ts)
解释了为何仍显示独立 spinner。

1. 对最终选定的配置运行聚焦的真实 Host 检查，再运行 `bun run check`。优先覆盖压缩取消、Goal 续跑、
   Session fork/恢复、不同 cwd，以及普通/全屏 UI 的 spinner 活性。
2. 区分[合同目录](../capability-contract-catalog.md)中的 pending 项与已通过证据。本次评估既不能证明已有运行失败，
   也不能认证 pending 合同。
3. 澄清 [Context 上游说明](../../../../../packages/pi-stuff/src/context-management/UPSTREAM.md)中 Pi 0.84.4 的当前声明与历史证据，
   保留历史结果。
4. 仅在希望匹配新默认 UI 时接入内嵌指示器，复用 Host 机制与现有活性检查，不另写 spinner。
