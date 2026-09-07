<!-- translation-source: docs/troubleshooting.md; translation-source-sha256: 51da6132cfc6afda3689f4c69af5e08a9a64cf50b83030826256ee9410c4a3a7 -->

# 故障排查

[English](../../../../docs/troubleshooting.md)

先运行 `/diagnostics`。它会显示当前 Pi 进程记录的有界、脱敏问题；存在引导式恢复入口时，也会指出对应命令。

## 安装与启动

### Package 没有加载

1. 确认 `pi --version` 在已认证 Linux x64 路径上报告 `0.85.1`。
2. 在仓库根目录重新运行 `pi install ./packages/pi-stuff`。
3. 重启 Pi 并打开 `/diagnostics`。

如果编辑器就绪前就发生失败，请查看 Pi 输出的启动错误；Suite 初始化错误不会被转成不完整启动。

### 某个设置命名空间无效

Pi Stuff 设置是 `<agentDir>/pi-stuff.json` 中的普通 JSON。JSON 注释和尾随逗号无效。修正
`/diagnostics` 指出的命名空间，重启 Pi，再用所属交互命令保存已知有效的值。类型和默认值见
[设置参考](reference/settings.md)。

### 界面不完整或过于拥挤

运行 `/ui`，检查 Welcome、Statusline、密度、最新 prompt、输入高亮、行内 slash 补全和 Tool 计时器设置。
终端宽度不足时，自动 Statusline 会切换到紧凑形式。

## Context

### `/ctx` 报告 Context 不可用

确认启动 Pi 的环境能够解析外部 Context engine 和配置的 worker。然后重启 Pi，查看 `/ctx` 与
`/diagnostics`。未配置 Context 时，普通 Pi conversation 仍然可用。

### Context 维护失败

重试 `flush`、`wrapup`、`recomp` 或 `upgrade` 前先运行 `/ctx status`。请处理 `/diagnostics` 显示的具体
worker、数据或配置错误，不要针对无效状态反复执行维护操作。

## Web

### Web Tool 不可用

Web 配置位于 `web` 命名空间，由 provider 解释。确认所选 provider 所需的值和凭据已经提供，然后重启 Pi。
Provider 认证与服务错误会显示在 Tool 结果或 `/diagnostics` 中。

## MCP

### Server 已断开

运行 `/mcp` 查看状态。对已配置 server 使用 `/mcp reconnect <server>`；需要认证时使用
`/mcp auth <server>`；声明有误时使用 `/mcp setup`。

### Server 不应在启动时连接

使用 `/mcp on-demand <server>`。需要自动连接时使用 `/mcp auto-connect <server>`。

## RTK

本地测试预检失败时，检查报告的可执行文件路径与版本。将 `RTK_BIN` 指向已有受支持版本，或把它放到 `PATH`；同版本源码构建和 shim 不需要匹配官方发布哈希。`PI_BIN` 同样选择已安装的受支持 Pi。本地验证不下载或重装这两个工具。

### 命令没有被改写

运行 `/rtk`，检查 RTK 可用性与 `rewriteCommands`。启动 Pi 的环境必须能够找到 `rtk` 可执行文件。
如果希望使用普通 shell 命令，可在同一界面关闭改写。

### RTK 输出没有压缩

在 `/rtk` 中检查 `outputProjection`。命令必须先符合 RTK 改写条件；RTK 能力范围之外的命令会保留原输出。

## Codex 与 Code Mode

### `/codex` 没有活动控制

控制界面只为受支持的 Codex model 显示。确认 Pi 中的活动 model 及其认证，然后运行 `/codex usage` 刷新用量。

### Code Mode 没有使用预期策略

运行 `/codemode` 查看有效策略。受信项目的 `.pi/code-mode.json` 可以覆盖全局 `codeMode.enabled` 设置，
进程环境可以提供更低优先级的默认值。对当前项目使用 `/codemode on|off`，对全局默认值使用
`/codemode global on|off`。

### 某个 Code Mode operation 正在等待

运行 `/codemode pending`，再批准或拒绝显示的 operation ID。拒绝时使用界面显示的 sequence，避免过期决定
误中更新后的 operation。

## 通知

### 没有出现通知

用户启动的 Agent 工作结算、Agent Work Duration 达到 `minimumDurationMs`，并且配置的 `gracePeriodMs`
结束后，通知才会发出。在 `/notifications` 中检查 `enabled` 以及对应的完成或失败提醒，再从同一界面发送测试通知。

使用 `delivery: "auto"` 时，Pi Stuff 会选择：

| 终端 | 协议 |
| --- | --- |
| Kitty | OSC 99 |
| Ghostty | OSC 777 |
| iTerm2 或 WezTerm | OSC 9 |

无法识别终端时，自动 delivery 会退化为 BEL。

### tmux 内没有收到通知

配置 tmux 传递终端通知序列：

```tmux
set -g allow-passthrough on
```

`tmuxNotification` 控制 tmux attention BEL。开启后会保留受支持的系统通知并额外发送 BEL；无法识别的
`auto` delivery 只使用 BEL。关闭后，tmux 内的通知 delivery 会禁止 BEL，包括显式
`delivery: "bell"`。

这项设置不会启用 tmux 行内图像。图像渲染仍取决于 Pi、终端协议和 multiplexer。

### 通知包含太多文字

保持 `responsePreview` 关闭。它默认关闭，因为桌面通知历史可能在 Pi 之外保持可见。

### BEL 没有声音

在 tmux 之外，`terminalBell` 会为视觉通知额外发送 BEL。BEL 最终产生声音、视觉提示还是没有反应，由终端决定；
请检查终端的 bell 设置。

## 图像与图表

如果行内图像、`chart` fence 或 `tree` fence 无法渲染，先在 tmux 之外复现。确认活动 Pi Host、终端协议和
multiplexer 都支持该图像路径。通知 passthrough 与行内图像支持无关。

## 仍未解决

记录完整的 `/diagnostics` 条目、Pi 版本、终端与 multiplexer 版本，以及能够复现问题的最小命令。仓库 issue
流程见[贡献指南](../.github/CONTRIBUTING.md)。
