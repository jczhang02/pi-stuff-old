<!-- translation-source: README.md; translation-source-sha256: 35a3ec9bb5cc0622b14d1c2f745d35a6769c9fdc9d420b20b834ddef2318a5fb -->

<div align="center">

# Pi Stuff

**让 Pi 编程工作流更安静，也更能干。**

Pi Stuff 为原生 [Pi coding agent](https://github.com/earendil-works/pi) 加入界面、工作、上下文和集成能力。

[English](../../../README.md) · [文档](docs/README.md)

[![CI](https://img.shields.io/github/actions/workflow/status/jczhang02/pi-stuff/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/jczhang02/pi-stuff/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/jczhang02/pi-stuff?style=flat-square)](../../../LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/jczhang02/pi-stuff?style=flat-square)](https://github.com/jczhang02/pi-stuff/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/jczhang02/pi-stuff?style=flat-square)](https://github.com/jczhang02/pi-stuff/network/members)
[![Last commit](https://img.shields.io/github/last-commit/jczhang02/pi-stuff?style=flat-square)](https://github.com/jczhang02/pi-stuff/commits/main)

[![Pi 0.85.1](https://img.shields.io/badge/Pi-0.85.1-89b4fa?style=flat-square)](docs/compatibility.md)
[![Bun 1.4.0](https://img.shields.io/badge/Bun-1.4.0-f9e2af?style=flat-square&logo=bun&logoColor=1e1e2e)](docs/compatibility.md)
[![TypeScript 5.9.3](https://img.shields.io/badge/TypeScript-5.9.3-3178c6?style=flat-square&logo=typescript&logoColor=white)](docs/compatibility.md)
[![Linux x64](https://img.shields.io/badge/Linux-x64-fab387?style=flat-square&logo=linux&logoColor=1e1e2e)](docs/compatibility.md)

</div>

<p align="center">
  <a href="../../assets/readme/root/hero.png">
    <img src="../../assets/readme/root/hero.png" alt="Ghostty 中的 Pi Stuff 欢迎卡片和 Statusline" width="100%">
  </a>
  <br>
  <em>Pi Stuff 在 Ghostty 中运行，使用 Catppuccin Latte 主题。</em>
</p>

## 关于

Pi Stuff 让日常工作留在 Pi 里，同时让对话更易读，长任务更容易持续推进。它提供四类实用能力：

- 安静、清楚的对话界面、Tool 活动和 Session 名称。
- Goal、后台任务、委派 Agent 和 Todo，让工作持续向前。
- 支线问题与通知，不打断主线。
- 按需启用 Context、Web、MCP、RTK、Codex 和 Code Mode。

<p align="center">
  <a href="../../assets/readme/root/architecture.png">
    <img src="../../assets/readme/root/architecture.png" alt="Pi Stuff Tool 活动与选中 Tool 的详情" width="100%">
  </a>
  <br>
  <em>Tool 活动让 Suite 的工作随时可查，不必离开对话。</em>
</p>

## 快速开始

安装 [Pi 0.85.1](docs/compatibility.md)，克隆仓库并安装 Package：

```bash
git clone https://github.com/jczhang02/pi-stuff.git
cd pi-stuff
pi install ./packages/pi-stuff
pi
```

运行 `/ui` 调整界面，用 `/goal` 开始持续任务，或用 `/btw` 提出支线问题。
[入门指南](docs/getting-started.md)介绍首次使用和可选配置。

## 使用

| 你想做什么 | 从这里开始 | 继续阅读 |
| --- | --- | --- |
| 让对话更清爽 | `/ui`、自动 Session 命名、紧凑 Tool 活动 | [界面指南](docs/README.md#能力指南) |
| 让工作持续推进 | `/goal`、`/tasks`、`/agents`、Todo Tools | [工作指南](docs/README.md#能力指南) |
| 在主线之外提问和接收提醒 | `/btw`、`/notifications` | [流程指南](docs/README.md#能力指南) |
| 接入更多上下文和工具 | `/ctx`、Web、MCP、RTK、Codex、Code Mode | [集成指南](docs/README.md#能力指南) |

[命令参考](docs/reference/commands.md)列出了全部 slash command。
[设置参考](docs/reference/settings.md)集中说明可选配置，安装时无需一次配完。

<p align="center">
  <a href="../../assets/readme/root/workflow.png">
    <img src="../../assets/readme/root/workflow.png" alt="带有四步 Todo 的 Pi Stuff 对话" width="100%">
  </a>
  <br>
  <em>Pi 继续对话时，实时 Todo 会把多步工作留在视野内。</em>
</p>

## 文档

| 指南 | 用途 |
| --- | --- |
| [入门](docs/getting-started.md) | 安装并开始第一次 Pi Stuff Session |
| [能力指南](docs/README.md#能力指南) | 每项能力的任务式说明 |
| [命令](docs/reference/commands.md) | 查询 slash command |
| [设置](docs/reference/settings.md) | 配置可选能力 |
| [主题](docs/reference/themes.md) | 使用内置 Catppuccin 主题 |
| [故障排查](docs/troubleshooting.md) | 处理常见安装与运行问题 |
| [架构](docs/architecture.md) | 了解 Suite 的组成方式 |
| [兼容性](docs/compatibility.md) | 查询已认证的 Host 与工具链版本 |

## 参与贡献

使用 `bun install --frozen-lockfile` 安装依赖，完成一项聚焦的修改，并在提交 pull request 前运行
`bun run check`。完整流程见[贡献指南](.github/CONTRIBUTING.md)。

## 安全

Pi Extension 以当前用户的操作系统权限运行。安装前请检查 Extension 源码；如发现安全问题，请按
[安全策略](.github/SECURITY.md)中的私密渠道报告。

## 致谢

### 产品与视觉参考

- [Pi](https://github.com/earendil-works/pi) 提供原生 Agent Host 与 Extension 接口。
- [Ghostty](https://github.com/ghostty-org/ghostty) 是文档截图使用的终端。
- [Catppuccin](https://github.com/catppuccin/catppuccin) 提供内置主题的调色板。
- [Best README Template](https://github.com/othneildrew/Best-README-Template) 为 README 结构提供参考。
- [Claude Code](https://github.com/anthropics/claude-code) 为 transcript 层级和后台工作界面提供参考。
- [`agent-first-screenshots`](https://github.com/different-ai/openwork) 为截图构图和展示方式提供参考。
- [OpenAI Codex](https://github.com/openai/codex) 为 Codex 集成和 Code Mode runtime 提供参考。
- [Cloudflare Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) 为 Code Mode 兼容性提供参考。

### 上游项目与 fork

- [`pi-background-tasks`](https://github.com/ismailsaleekh/pi-background-tasks) 为 Background Work 提供参考。
- [`rpiv-mono`](https://github.com/juicesharp/rpiv-mono) 为 BTW 和 Todo 提供参考。
- [`howaboua-pi-stuff`](https://github.com/IgorWarzocha/howaboua-pi-stuff) 为 Conversation UI、Codex 和 Code Mode 提供参考。
- [Magic Context](https://github.com/cortexkit/magic-context) 为 Context Management 提供引擎。
- [`pi-subagents`](https://github.com/nicobailon/pi-subagents) 为委派 Agent 执行提供参考。
- [`pi-rtk-optimizer`](https://github.com/MasuRii/pi-rtk-optimizer) 为 RTK 命令改写提供参考。
- [Ponytail](https://github.com/DietrichGebert/ponytail) 提供反过度工程工作流。
- [`pi-extensions` / `pi-goal`](https://github.com/narumiruna/pi-extensions) 为 Goal 提供参考。
- [`pi-tidy-tools`](https://github.com/mikeyobrien/pi-tidy-tools) 为紧凑 Tool 显示提供参考。
- [`pi-autoname`](https://github.com/ssdiwu/pi-autoname) 为自动 Session 命名提供参考。
- [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) 为 MCP runtime 提供参考。
- [`pi-web-access`](https://github.com/nicobailon/pi-web-access) 为 Web runtime 提供参考。

源码来源与许可证细节保留在各 Module 的 `UPSTREAM.md` 和 `THIRD_PARTY_NOTICES.md` 中。

## 许可证

本项目使用 [MIT License](../../../LICENSE)。
