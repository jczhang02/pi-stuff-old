<!-- translation-source: packages/pi-stuff/src/goal/README.md; translation-source-sha256: 4da0432846b37bda4eef3f870e07160a87d6a9fdcaccc2de32e5e7e3f7767253 -->

# Goal

[English](../../../../../../../packages/pi-stuff/src/goal/README.md)

围绕一个 Session 目标持续推进、并由证据约束完成的工作方式。

<p align="center">
  <a href="../../../../../../assets/readme/capabilities/goal.png">
    <img src="../../../../../../assets/readme/capabilities/goal.png" alt="Pi 中的 Goal 管理器" width="100%">
  </a>
  <br>
  <em>Goal 管理器用于启动、编辑、暂停和恢复持续工作。</em>
</p>

## 快速开始

```text
/goal implement and verify the requested change
/goal status
```

使用 `/goal pause` 与 `/goal resume` 控制自动 continuation。不再需要保持目标时，使用 `/goal clear`。

## 亮点

- 持续推进结算工作，直到完成、暂停、budget、provider 限制或经过验证的 blocker。
- `goal_complete` 成功前要求逐项提供证据。
- 跨三个连续 Goal turn 审核稳定 blocker。
- 先持久化已接受的终止状态，再在预算边界内请求正常的 Goal Final Response。
- 在当前 Session 中保存目标、状态、budget 和可选队列。
- 跨 Pi 原生 compaction 生命周期保持 Goal identity。
- 向有界的后台结果投递暴露当前 Goal identity 与 continuation 权限，并在投递期间延后 continuation。
- Session teardown 后忽略 settlement notification，避免陈旧 Goal context 在已关闭 Session 中启动 continuation。
- 在共享 Statusline 中显示当前状态、用量、budget 和经过时间。

## 压缩后的继续执行

Pi 0.85.1 在清除手动压缩的忙碌状态之前触发 `session_compact`，之后不会触发 `agent_settled`。
Goal 保留继续执行意图或待处理的队列动作，复用由当前 Session 管理、可以取消的恢复任务，只在 Pi 真正空闲后发送。
该任务先让出一次执行机会；如果交接尚未结束，再每 10 ms 检查一次。发送、取消、用户排队输入、新一次压缩或 Session
退出都会结束这项等待。普通启动、空闲运行和 Tool 调用不会新增周期检查。Pi 原生自动重试和 Suite 压缩预检仍由原有模块负责。

## 文档

- [Goal 指南](../../../../docs/capabilities/goal.md)
- [命令参考](../../../../docs/reference/commands.md#工作控制)
- [设置参考](../../../../docs/reference/settings.md#goal)
- [架构](../../../../docs/architecture.md#生命周期所有权)
