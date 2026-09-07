# Getting started

[Simplified Chinese](i18n/zh-CN/docs/getting-started.md)

This guide installs Pi Stuff, starts the Suite in Pi, and points to the first controls worth learning.

## Requirements

The certified Host is Pi `0.85.1` for Linux x64, built from upstream commit
`d981de1229ef899957bbe968bc8dcda02a21f477`. See [Compatibility](compatibility.md) for the full development
toolchain and certification scope.

You also need Git and a terminal with truecolor support. Ghostty is used for the project screenshots, but Pi Stuff
works with Pi's supported terminal surface.

## Install

```bash
git clone https://github.com/jczhang02/pi-stuff.git
cd pi-stuff
pi install ./packages/pi-stuff
```

Start Pi from the project where you want to work:

```bash
pi
```

Pi loads the Package on startup. Run `/diagnostics` after the editor appears to inspect any Suite problem reported by
the current process.

## Choose a theme

Open Pi's `/settings` menu and select one of the bundled themes:

- `catppuccin-latte`
- `catppuccin-frappe`
- `catppuccin-macchiato`
- `catppuccin-mocha`

The same choice can be stored as Pi's `theme` setting. See [Themes](reference/themes.md) for the names and palette
contract.

## First commands

| Command | Use it to |
| --- | --- |
| `/ui` | Configure the Welcome card, Statusline, prompt presentation, and live Tool timer |
| `/goal <objective>` | Keep a substantial objective moving across Agent turns |
| `/btw <question>` | Ask a side question without adding it to the main transcript |
| `/tasks` | Inspect Background Shells and Monitors |
| `/agents` | Inspect delegated Agents |
| `/ctx` | Inspect Context status and maintenance actions |
| `/notifications` | Configure and test completion and failure alerts |
| `/diagnostics` | Review current, redacted Suite diagnostics |

The complete syntax is in [Command reference](reference/commands.md).

## Optional integrations

Context, Web, MCP, RTK, Codex controls, and Code Mode can be configured independently. Start with the feature you need:

- `/ctx` opens Context status and maintenance.
- `/mcp setup` opens MCP configuration; `/mcp` shows configured servers.
- `/rtk` inspects RTK command rewriting.
- `/codex` shows Codex controls for a supported Codex model.
- `/codemode` shows the effective Code Mode policy for the current project.

Settings owned by Pi Stuff live in `<agentDir>/pi-stuff.json`. Use the interactive controls where available; edit JSON
only for advanced values documented in [Settings reference](reference/settings.md).

## Next steps

- [Package guide](../packages/pi-stuff/README.md) — Suite capabilities and package-level navigation
- [Architecture](architecture.md) — how the Host, Package, and Capability Modules fit together
- [Troubleshooting](troubleshooting.md) — installation, terminal, and integration recovery
- [Engineering documentation](README.md) — contracts, ADRs, research, and reports
