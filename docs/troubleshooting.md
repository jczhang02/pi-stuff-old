# Troubleshooting

[Simplified Chinese](i18n/zh-CN/docs/troubleshooting.md)

Start with `/diagnostics`. It shows bounded, redacted problems recorded by the current Pi process and points to the
owning command when a guided recovery path exists.

## Installation and startup

### The Package does not load

1. Confirm that `pi --version` reports `0.85.1` on the certified Linux x64 path.
2. From the repository root, run `pi install ./packages/pi-stuff` again.
3. Restart Pi and open `/diagnostics`.

If the failure happens before the editor is ready, use the startup error emitted by Pi; Suite initialization errors
are not converted into a partial startup.

### A settings namespace is invalid

Pi Stuff settings are plain JSON at `<agentDir>/pi-stuff.json`. JSON comments and trailing commas are invalid. Correct
the namespace named by `/diagnostics`, restart Pi, and use the owning interactive command to save a known-good value.
See [Settings reference](reference/settings.md) for types and defaults.

### The interface looks incomplete or crowded

Run `/ui` and inspect Welcome, Statusline, density, latest-prompt, input highlighting, inline slash completion, and
Tool timer settings. Terminal width can make the automatic Statusline switch to its compact form.

## Context

### `/ctx` reports that Context is unavailable

Confirm that the external Context engine and its configured worker can be resolved in the environment that started Pi.
Then restart Pi and inspect `/ctx` and `/diagnostics`. Ordinary Pi conversation remains available while Context is not
configured.

### Context maintenance fails

Use `/ctx status` before retrying `flush`, `wrapup`, `recomp`, or `upgrade`. Resolve the specific worker, data, or
configuration error shown by `/diagnostics` rather than repeating a maintenance action against invalid state.

## Web

### Web Tools are unavailable

Web configuration lives under the `web` namespace and is interpreted by its providers. Confirm that the chosen
provider's required values and credentials are present, then restart Pi. Provider authentication and service errors
appear through the Tool result or `/diagnostics`.

## MCP

### A server is disconnected

Run `/mcp` to inspect its state. Use `/mcp reconnect <server>` for a configured server, `/mcp auth <server>` when it
needs authentication, or `/mcp setup` to correct its declaration.

### A server should not connect at startup

Use `/mcp on-demand <server>`. Use `/mcp auto-connect <server>` when the server should connect automatically.

## RTK

For local test preflight failures, check the reported executable path and version. Point `RTK_BIN` at an existing
supported executable or put it on `PATH`; same-version source builds and shims do not need an official release hash.
Likewise, `PI_BIN` selects an installed supported Pi. Local verification does not download or reinstall either tool.

### Commands are not rewritten

Run `/rtk` and check both RTK availability and `rewriteCommands`. The `rtk` executable must be available in the
environment that launched Pi. Disable rewriting from the same screen if you want ordinary shell commands.

### RTK output is not compact

Check `outputProjection` in `/rtk`. A command must first be eligible for RTK rewriting; commands outside RTK's surface
keep their original output.

## Codex and Code Mode

### `/codex` has no active controls

The control surface appears for supported Codex models. Confirm the active model and its authentication in Pi, then
run `/codex usage` to refresh usage.

### Code Mode does not use the expected policy

Run `/codemode` to inspect the effective policy. A trusted project's `.pi/code-mode.json` can override the global
`codeMode.enabled` setting, and the process environment can provide the lower-priority default. Use
`/codemode on|off` for the current project or `/codemode global on|off` for the global default.

### A Code Mode operation is waiting

Run `/codemode pending`, then approve or reject the displayed operation ID. Use the displayed sequence when rejecting
so a stale decision cannot target a newer operation.

## Notifications

### No notification appears

Notifications are sent after user-started Agent work settles, its Agent Work Duration reaches `minimumDurationMs`, and
the configured `gracePeriodMs` completes. Check `enabled` and the matching completion or failure alert in
`/notifications`, then send a test notification from the same screen.

With `delivery: "auto"`, Pi Stuff selects:

| Terminal | Protocol |
| --- | --- |
| Kitty | OSC 99 |
| Ghostty | OSC 777 |
| iTerm2 or WezTerm | OSC 9 |

If the terminal cannot be identified, automatic delivery falls back to BEL.

### Notifications inside tmux do not arrive

Configure tmux to pass terminal notification sequences through:

```tmux
set -g allow-passthrough on
```

`tmuxNotification` controls the tmux attention BEL. When enabled, a supported system notification is preserved and a
BEL is added; an unidentified `auto` delivery uses BEL alone. When disabled, notification delivery suppresses BEL
inside tmux, including explicit `delivery: "bell"`.

This setting does not enable inline images in tmux. Image rendering still depends on Pi, the terminal protocol, and
the multiplexer.

### A notification contains too much text

Keep `responsePreview` disabled. It is off by default because desktop notification history may be visible outside Pi.

### BEL is silent

Outside tmux, `terminalBell` adds BEL to a visual notification. The terminal decides whether BEL produces sound, a
visual cue, or nothing; check the terminal's bell settings.

## Images and diagrams

If an inline image, `chart` fence, or `tree` fence does not render, reproduce it outside tmux first. Confirm that the
active Pi Host, terminal protocol, and multiplexer all support the image path. Notification passthrough is unrelated to
inline-image support.

## Still stuck

Capture the exact `/diagnostics` entry, the Pi version, the terminal and multiplexer versions, and the smallest command
that reproduces the problem. Follow [Contributing](../.github/CONTRIBUTING.md) for the repository's issue workflow.
