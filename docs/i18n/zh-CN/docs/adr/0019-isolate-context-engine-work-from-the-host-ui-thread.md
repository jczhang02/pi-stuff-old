<!-- translation-source: docs/adr/0019-isolate-context-engine-work-from-the-host-ui-thread.md; translation-source-sha256: 56988636aeb25cbbb0cbfd7b48e645d6910b20b642a59ed1836c08d55df2a72f -->

---
status: accepted
---

# 将上下文引擎工作与宿主 UI 线程隔离

下文有关 Context 兜底、请求准入和恢复的条款已由
[ADR 0031](0031-preserve-magic-context-behavior-through-suite-integration.md) 取代，其余决策保持不变。

## 背景

Magic Context 投影可能执行足够多的 CPU 与模块加载工作，导致 Pi 输入绘制和“工作中”动画停顿。只在宿主事件循环上延后同一项工作，并不会改变这种争用。

## 决策

Magic Context 投影在一个上下文引擎 Worker 中执行。Pi 仍是宿主，继续负责输入、对话记录渲染、会话、模型请求和 Agent 生命周期。上下文管理不会渲染第二份已提交输入，也不会调用合成刷新 API。

适配器会延迟地把精确固定版本的 Magic Context 软件包及其 Worker 入口打包成一个内存中的 Bun 产物，再从 Blob URL 启动它。该过程发生在 ADR 0007 已规定的已配置上下文初始化期间。产物不会写入磁盘、发布或安装。上游软件包不做分叉；其精确固定的 npm 产物带有上下文管理 `UPSTREAM.md` 所记录的、临时且经过审查的分词器兼容依赖补丁。打包会保留上游软件包原始的 `import.meta.url`，使软件包相对资源和版本身份保持官方语义。

Pi 事件、工具和命令注册仍留在宿主中。每次调用都会发送不可变上下文快照，以及固定引擎实际读取的事件字段。Worker 边界只改变执行位置，不改变取消语义：已接受 prompt 的镜像生命周期工作归 Session 所有，不继承当前 Agent turn 的 signal。只有固定版本官方 handler 实际读取 signal 的 invocation 接缝才会转发取消。因此，中断 Agent turn 不会把健康的 Worker 误判为失败，也不能拥有其恢复过程。

该固定边界上的 Context snapshot 按需构造。Tool start 与 end handler 会收到 Session metadata，但不会收到未使用的 Host context-usage estimate；中间的 Tool-use `message_end` 先使用自身的 Assistant usage，直到随后的 Context refresh。Session mirror 同步同样会省略调用方不使用的 context-usage 字段。这可以避免 Host 仅为构造最终被丢弃的 snapshot 数据，就序列化完整的 in-flight Tool argument。

Worker 首次绑定会话时、变化后的叶节点不是镜像叶节点的直接后继时，以及执行三个显式历史重建命令时，完整会话分支会跨越边界。普通上下文投影和持久化至多发送一个新的叶条目。因此，快照回退能修复分叉、树、压缩和其他不连续情况，而无需每次按 Enter 都克隆无界会话。

Worker 到宿主的副作用仅限于 `appendEntry`、`sendMessage`、`sendUserMessage`、`notify` 和 `setStatus`，且绑定到发起操作的 Pi 会话。固定上游 API 唯一需要同步执行的 SessionManager 操作 `appendCompaction`，使用有界共享内存响应，并且只阻塞 Worker。宿主副作用、镜像同步或致命 Worker 错误一旦失败，会立即把上下文所有权交回 Pi 原生行为。关闭时先给官方处理器一个有界的宿主宽限期，然后独立于其串行请求队列终止 Worker，并撤销内存 URL。

## 被拒绝的替代方案

- 从适配器渲染或刷新已提交提示词会建立第二个可见权威，并已造成全帧刷新和“工作中”卡死回归。
- 用定时器延后相同的 Magic Context 调用，仍会让 CPU 密集型投影独占 Pi 的 UI 线程。
- 在 Worker 中直接加载外部模块图，无法在已验证的独立 Pi 二进制文件中可靠工作：裸导入无法在那里解析，而绝对外部入口 URL 会让独立 Bun Worker 路径崩溃。单个内存包是该边界上最小且确定的加载器。
- 分叉 Magic Context 会复制上游所有权，却不会改变面向 Pi 的接缝。

## 后果

已配置启动会承担一次 Worker 构建与启动、分词器预加载、编辑器就绪前的一次初始会话快照，以及上下文激活期间一个 Worker 的内存成本。作为交换，健康的 Magic Context 投影可以与 Pi 的原生输入绘制和“工作中”动画并发运行，且普通轮次无需再次克隆完整会话。验收必须使用真实 Pi TUI：恢复一个包含异常图像历史的长会话，要求已提交提示词从提交到 PTY 观测（包含 tmux 提交与捕获开销）不超过 150 毫秒出现在对话记录中，限制“工作中”帧的最大停顿，并确认预期标记位于发送给 Provider 的 Magic Context 历史投影中。同一门槛还必须中断一个已接受的 Agent turn，要求下一条 prompt 在 150 毫秒边界内进入 Transcript，并确认已中断的 prompt 仍存在于下一次完整 Provider payload 中。真实受支持模型的冒烟测试还必须成功运行一个 Magic Context 工具。
