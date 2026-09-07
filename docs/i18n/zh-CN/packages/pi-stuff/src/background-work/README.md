<!-- translation-source: packages/pi-stuff/src/background-work/README.md; translation-source-sha256: bff55fa38d3d7f2feb93c38349f5f2b16ff96a0da52e739ccc1f55efb00744ed -->

# Background Work

[English](../../../../../../../packages/pi-stuff/src/background-work/README.md)

在主 Agent 继续工作时运行 Background Shell 与一次性 Monitor，并自动报告完成。

<p align="center">
  <a href="../../../../../../assets/readme/capabilities/background-work.png">
    <img src="../../../../../../assets/readme/capabilities/background-work.png" alt="Pi 中的 Background Work 任务对话框" width="100%">
  </a>
  <br>
  <em>Background Work 对话框让 Shell 和 Monitor 留在 Pi 内随时可查。</em>
</p>

## 快速开始

让 Agent 仅对独立 Bash 命令使用 `run_in_background: true`，或为 command、file、log、HTTP 证据创建
`monitor`。必需的 Bash 命令保持前台；稍后发生 handoff 时，命令结束会恢复 Agent。然后打开：

```text
/tasks
```

Dialog 列出当前工作、跟随有界输出，并停止当前 Session 拥有的 activity。

## 亮点

- 在启动时、通过 `Ctrl+B` 或前台运行两分钟后分离 Bash。
- 显式 background launch 保持独立，而 foreground handoff 会在 terminal outcome 时恢复主 Agent。
- 跨四种 source 监控精确 success 或 failure text。
- 自动送达最终结果，无需在 conversation 中轮询。
- 保留最新 64 个有界 completion receipt，供近期检查。
- 每个 Session 最多同时运行 16 个 Shell 与 Monitor。
- 跨过输出保留阈值时保留带 omission count 的滚动 tail，而不停止生产性工作。
- 根据是否发生滚动，将已完成输出路径明确标记为完整或保留。
- Shutdown 时停止所属进程树并记录经过认证的恢复 metadata。

Shell 启动时，最多等待十秒确认 supervisor 已就绪，随后才发布经过认证的命令。
三秒的命令确认期限从就绪后开始计算。启动失败会回滚；Session 关闭后，待启动任务不能再释放命令。

## 文档

- [Background Work 指南](../../../../docs/capabilities/background-work.md)
- [命令参考](../../../../docs/reference/commands.md#工作控制)
- [Tool Display 指南](../../../../docs/capabilities/tool-display.md)
- [Agents 指南](../../../../docs/capabilities/subagents.md)
- [上游参考](UPSTREAM.md)
