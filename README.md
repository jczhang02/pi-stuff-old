<div align="center">

# Pi Stuff

**A calmer, more capable Pi coding workflow.**

Pi Stuff brings focused interface, work, context, and integration capabilities to the native
[Pi coding agent](https://github.com/earendil-works/pi).

[简体中文](docs/i18n/zh-CN/README.md) · [Documentation](docs/README.md)

[![CI](https://img.shields.io/github/actions/workflow/status/jczhang02/pi-stuff/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/jczhang02/pi-stuff/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/jczhang02/pi-stuff?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/jczhang02/pi-stuff?style=flat-square)](https://github.com/jczhang02/pi-stuff/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/jczhang02/pi-stuff?style=flat-square)](https://github.com/jczhang02/pi-stuff/network/members)
[![Last commit](https://img.shields.io/github/last-commit/jczhang02/pi-stuff?style=flat-square)](https://github.com/jczhang02/pi-stuff/commits/main)

[![Pi 0.85.1](https://img.shields.io/badge/Pi-0.85.1-89b4fa?style=flat-square)](docs/compatibility.md)
[![Bun 1.4.0](https://img.shields.io/badge/Bun-1.4.0-f9e2af?style=flat-square&logo=bun&logoColor=1e1e2e)](docs/compatibility.md)
[![TypeScript 5.9.3](https://img.shields.io/badge/TypeScript-5.9.3-3178c6?style=flat-square&logo=typescript&logoColor=white)](docs/compatibility.md)
[![Linux x64](https://img.shields.io/badge/Linux-x64-fab387?style=flat-square&logo=linux&logoColor=1e1e2e)](docs/compatibility.md)

</div>

<p align="center">
  <a href="docs/assets/readme/root/hero.png">
    <img src="docs/assets/readme/root/hero.png" alt="Pi Stuff Welcome card and Statusline in Ghostty" width="100%">
  </a>
  <br>
  <em>Pi Stuff running in Ghostty with the Catppuccin Latte theme.</em>
</p>

## About

Pi Stuff keeps everyday work inside Pi while making the conversation easier to read and longer tasks easier to run.
It adds four practical layers:

- A quiet, readable interface for conversation, Tool activity, and Session names.
- Goals, background tasks, delegated Agents, and Todo tracking that keep work moving.
- Side questions and notifications that do not interrupt the main thread.
- Optional Context, Web, MCP, RTK, Codex, and Code Mode integrations when a workflow needs them.

<p align="center">
  <a href="docs/assets/readme/root/architecture.png">
    <img src="docs/assets/readme/root/architecture.png" alt="Pi Stuff Tool Activities and selected Tool details" width="100%">
  </a>
  <br>
  <em>Tool Activities keep Suite work inspectable without leaving the conversation.</em>
</p>

## Getting started

Install [Pi 0.85.1](docs/compatibility.md), clone the repository, and install the Package:

```bash
git clone https://github.com/jczhang02/pi-stuff.git
cd pi-stuff
pi install ./packages/pi-stuff
pi
```

Open `/ui` to tune the interface, start durable work with `/goal`, or ask a side question with `/btw`.
The [getting-started guide](docs/getting-started.md) covers the first session and optional setup.

## Usage

| What you want | Start with | Learn more |
| --- | --- | --- |
| A calmer conversation | `/ui`, automatic Session names, compact Tool activity | [Interface guides](docs/README.md#capability-guides) |
| Work that keeps moving | `/goal`, `/tasks`, `/agents`, Todo Tools | [Work guides](docs/README.md#capability-guides) |
| Questions and alerts off the main path | `/btw`, `/notifications` | [Flow guides](docs/README.md#capability-guides) |
| More context and connected tools | `/ctx`, Web, MCP, RTK, Codex, Code Mode | [Integration guides](docs/README.md#capability-guides) |

The [command reference](docs/reference/commands.md) lists every slash command. The
[settings reference](docs/reference/settings.md) covers optional configuration without turning installation into a
configuration project.

<p align="center">
  <a href="docs/assets/readme/root/workflow.png">
    <img src="docs/assets/readme/root/workflow.png" alt="Pi Stuff conversation with a four-step Todo" width="100%">
  </a>
  <br>
  <em>A live Todo keeps multi-step work visible while Pi continues the conversation.</em>
</p>

## Documentation

| Guide | Use it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | Installation and a first Pi Stuff session |
| [Capability guides](docs/README.md#capability-guides) | Task-oriented guides for every capability |
| [Commands](docs/reference/commands.md) | Slash-command lookup |
| [Settings](docs/reference/settings.md) | Optional configuration |
| [Themes](docs/reference/themes.md) | Bundled Catppuccin themes |
| [Troubleshooting](docs/troubleshooting.md) | Common setup and runtime problems |
| [Architecture](docs/architecture.md) | How the Suite fits together |
| [Compatibility](docs/compatibility.md) | Certified Host and toolchain versions |

## Contributing

Install dependencies with `bun install --frozen-lockfile`, make a focused change, and run `bun run check` before
opening a pull request. See the [contribution guide](.github/CONTRIBUTING.md) for the complete workflow.

## Security

Pi Extensions run with the current user's operating-system permissions. Review Extension source before installation
and report vulnerabilities through the private channel in the [security policy](.github/SECURITY.md).

## Acknowledgments

### Product and visual references

- [Pi](https://github.com/earendil-works/pi) provides the native Agent Host and extension surface.
- [Ghostty](https://github.com/ghostty-org/ghostty) is the terminal used for the documentation screenshots.
- [Catppuccin](https://github.com/catppuccin/catppuccin) supplies the palette behind the bundled themes.
- [Best README Template](https://github.com/othneildrew/Best-README-Template) informed the README structure.
- [Claude Code](https://github.com/anthropics/claude-code) informed transcript hierarchy and background-work UI.
- [`agent-first-screenshots`](https://github.com/different-ai/openwork) informed screenshot framing and presentation.
- [OpenAI Codex](https://github.com/openai/codex) informed Codex integration and the Code Mode runtime.
- [Cloudflare Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) informed Code Mode compatibility.

### Upstream projects and forks

- [`pi-background-tasks`](https://github.com/ismailsaleekh/pi-background-tasks) informed Background Work.
- [`rpiv-mono`](https://github.com/juicesharp/rpiv-mono) informed BTW and Todo.
- [`howaboua-pi-stuff`](https://github.com/IgorWarzocha/howaboua-pi-stuff) informed Conversation UI, Codex, and Code Mode.
- [Magic Context](https://github.com/cortexkit/magic-context) powers Context Management.
- [`pi-subagents`](https://github.com/nicobailon/pi-subagents) informed delegated Agent execution.
- [`pi-rtk-optimizer`](https://github.com/MasuRii/pi-rtk-optimizer) informed RTK command rewriting.
- [Ponytail](https://github.com/DietrichGebert/ponytail) supplies the anti-overengineering workflow.
- [`pi-extensions` / `pi-goal`](https://github.com/narumiruna/pi-extensions) informed Goal.
- [`pi-tidy-tools`](https://github.com/mikeyobrien/pi-tidy-tools) informed compact Tool display.
- [`pi-autoname`](https://github.com/ssdiwu/pi-autoname) informed automatic Session naming.
- [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) informed the MCP runtime.
- [`pi-web-access`](https://github.com/nicobailon/pi-web-access) informed the Web runtime.

Source provenance and license details remain in Module-local `UPSTREAM.md` and `THIRD_PARTY_NOTICES.md` files.

## License

Distributed under the [MIT License](LICENSE).
