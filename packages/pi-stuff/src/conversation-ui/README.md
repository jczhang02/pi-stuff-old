# Conversation UI

[Simplified Chinese](../../../../docs/i18n/zh-CN/packages/pi-stuff/src/conversation-ui/README.md)

The shared Pi Stuff presentation layer for the conversation, editor, Statusline, Welcome header, and focused Command
Dialogs.

<p align="center">
  <a href="../../../../docs/assets/readme/capabilities/conversation-ui.png">
    <img src="../../../../docs/assets/readme/capabilities/conversation-ui.png" alt="Conversation UI settings dialog in Pi" width="100%">
  </a>
  <br>
  <em>The UI dialog configures the Statusline, prompt, Welcome card, highlighting, completion, and timers.</em>
</p>

## Quick start

```text
/ui
```

Use the interactive list to configure the Statusline, latest prompt, Welcome header, input highlighting, inline slash
completion, and Tool running timer.

## Highlights

- Responsive Statusline with stable model, workspace, Context, usage, Goal, and Ponytail groups; context usage is read
  once per settled Session leaf and model, only while the Host is idle, so Tool and input repaints do not rescan it.
- Context shows a local percentage estimate or `unknown`; actual recovery displays `recovering` and its current phase.
  Estimate uncertainty does not interrupt an Agent run.
- One-line latest-prompt preview and compact Skill labels.
- Native-editor input highlighting and slash completion. Highlighting skips command-registry work when no rendered
  line contains `/`, without caching registry contents between redraws. Otherwise it recognizes complete invocation
  words and checks the live command set, without sorting names or rebuilding a command-specific regular expression.
- User Messages keep their native background and align `` and body text with Tool rows. Skill invocations, including
  Skill-only input, use one card; native `Ctrl+O` expands instructions after the prompt. The version-bound adapter
  preserves canonical messages and releases on Session shutdown/reload; exceptional presentation failure keeps native
  messages, disables further projection for that Session, and reports once through `/diagnostics`.
- Pi's spinner and working message remain embedded once in the top border. Pi owns thinking-level colors, clipping,
  animation, and cleanup; dialogs and reload preserve the editor.
- Host-owned Thinking shown as one latest native Markdown row or the hidden `• thoughts` label, preserving native
  mouse and keyboard visibility controls; plus `chart` or `tree` Markdown projections.
- Full-width Command Dialogs that restore the editor draft on close.
- Bounded Suite diagnostics through `/diagnostics`.

## Documentation

- [Conversation UI guide](../../../../docs/capabilities/conversation-ui.md)
- [Settings reference](../../../../docs/reference/settings.md#ui)
- [Command reference](../../../../docs/reference/commands.md#interface-and-inspection)
- [Shared UI contract](../../../../DESIGN.md)
