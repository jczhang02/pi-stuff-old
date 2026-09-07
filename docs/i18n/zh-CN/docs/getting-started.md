<!-- translation-source: docs/getting-started.md; translation-source-sha256: b116c407ed770d6584ec4a8454400e816e9a5cac4fa68d4a0d90bd3e746e9144 -->

# 入门

[English](../../../../docs/getting-started.md)

本指南介绍如何安装 Pi Stuff、在 Pi 中启动 Suite，并带你认识最值得先了解的几个控制入口。

## 环境要求

已认证 Host 为 Linux x64 上的 Pi `0.85.1`，构建自上游提交
`d981de1229ef899957bbe968bc8dcda02a21f477`。完整开发工具链与认证范围见[兼容性](compatibility.md)。

你还需要 Git 和支持 truecolor 的终端。项目截图使用 Ghostty，但 Pi Stuff 可以在 Pi 支持的终端界面中运行。

## 安装

```bash
git clone https://github.com/jczhang02/pi-stuff.git
cd pi-stuff
pi install ./packages/pi-stuff
```

在你准备工作的项目中启动 Pi：

```bash
pi
```

Pi 会在启动时加载 Package。编辑器出现后运行 `/diagnostics`，即可查看当前进程报告的 Suite 问题。

## 选择主题

打开 Pi 的 `/settings` 菜单，选择一个内置主题：

- `catppuccin-latte`
- `catppuccin-frappe`
- `catppuccin-macchiato`
- `catppuccin-mocha`

也可以把同一选择写入 Pi 的 `theme` 设置。主题名称与配色契约见[主题](reference/themes.md)。

## 首先了解这些命令

| 命令 | 用途 |
| --- | --- |
| `/ui` | 配置 Welcome 卡片、Statusline、输入呈现和 Tool 实时时长 |
| `/goal <objective>` | 让较大的目标跨 Agent turn 持续推进 |
| `/btw <question>` | 提出支线问题，而不把它加入主 transcript |
| `/tasks` | 查看 Background Shell 和 Monitor |
| `/agents` | 查看委派的 Agent |
| `/ctx` | 查看 Context 状态和维护操作 |
| `/notifications` | 配置并测试完成与失败提醒 |
| `/diagnostics` | 查看当前经过脱敏的 Suite 诊断 |

完整语法见[命令参考](reference/commands.md)。

## 可选集成

Context、Web、MCP、RTK、Codex 控制和 Code Mode 可以分别配置。先从你需要的功能开始：

- `/ctx` 打开 Context 状态和维护入口。
- `/mcp setup` 打开 MCP 配置；`/mcp` 显示已配置的 server。
- `/rtk` 查看 RTK 命令改写。
- `/codex` 为受支持的 Codex model 显示 Codex 控制。
- `/codemode` 显示当前项目的有效 Code Mode 策略。

Pi Stuff 拥有的设置位于 `<agentDir>/pi-stuff.json`。有交互入口时优先使用交互控制；只有
[设置参考](reference/settings.md)记录的高级值需要直接编辑 JSON。

## 接下来

- [Package 指南](../packages/pi-stuff/README.md)——Suite 能力与 Package 级导航
- [架构](architecture.md)——Host、Package 与 Capability Module 如何协作
- [故障排查](troubleshooting.md)——安装、终端和集成恢复
- [工程文档](README.md)——契约、ADR、研究与报告
