# Conversation UI

[Simplified Chinese](../i18n/zh-CN/docs/capabilities/conversation-ui.md)

Conversation UI keeps Pi Stuff's current state readable inside Pi. It owns the Welcome header, responsive Statusline,
input and User Message presentation, Thinking labels, fenced visualizations, shared Command Dialog, and Suite diagnostics.

## Quick start

Start Pi, then run:

```text
/ui
```

The interactive settings list applies changes immediately and stores user changes in the `ui` or `tools` namespace of
`<agentDir>/pi-stuff.json`.

## UI settings

| Setting | Default | Effect |
| --- | --- | --- |
| Statusline | On | Shows the current model, workspace, Context, usage, and selected capability state |
| Statusline density | Auto | Switches between full and compact content as terminal width changes |
| Latest prompt | On | Shows one bounded line for the most recent submitted prompt |
| Welcome header | On | Shows the Suite's startup overview |
| Input highlighting | On | Highlights recognized slash commands and input structure |
| Inline slash autocomplete | On | Completes command and Skill names in the native editor |
| Tool running timer | On | Adds elapsed time to long-running active Tool rows |

The Tool timer is owned by Tool Display but appears in `/ui` so presentation settings stay together.

## Statusline

The Statusline uses one status row and an optional latest-prompt row. The status row keeps a stable order as space
allows: model and Thinking, Codex Fast mode, working directory and Git, Context, cache or usage, current Goal, and
Ponytail mode.

Context usage is read once per settled Session leaf and model, only while the Host is idle. During active Agent or Tool
work, the Statusline keeps the last settled value instead of asking Pi to rescan the conversation on every repaint.

`auto` density first shortens fields and then removes lower-priority groups. It does not wrap or leave partial fields.
The model and Context remain visible longest. Goal and Ponytail appear only when their current state calls for a
persistent indicator.

The latest-prompt row is one terminal line. Skill invocations are reduced to the submitted task and compact Skill
labels; expanded Skill instructions and local paths are not shown.

During Context projection, the Context group shows `recovering`. If the Provider boundary cannot safely measure or
bound the request, it shows `unknown` and the request is aborted. After boundary validation, the validated percentage
replaces stale Host usage. The snapshot clears only after a successful assistant completion or a Session lifecycle
event.

## Welcome header

The Welcome header gives a compact startup view of the active model, project, and Suite entry points. It disappears
when disabled and yields to focused Command Dialogs. `/ui` is the only place that changes this presentation choice.

## Input presentation

Input highlighting and inline completion extend Pi's native editor without replacing its keybindings or draft
handling. Slash completion covers registered commands and inserts the canonical `/skill:<name>` form for Skills.

Focused dialogs temporarily take the editor surface. Closing a dialog restores the exact draft and normal Pi chrome.

## User Messages

User Messages retain Pi's full-width card background and spacing. One `` aligns with the Tool marker, with prompt and
continuation text aligned to Tool text at the certified `outputPad=1` setting. This marks a Provider Prompt, including
automatic user-role messages, rather than asserting human authorship.

Submitting `/skill:implement <prompt>` shows `/skill:implement` and the prompt together in that card. Skill-only
invocations use the same presentation. The Skill command uses the static workflow demo rainbow palette; lists, quotations, and code
blocks begin below it where necessary to retain native Markdown structure. Native `Ctrl+O` expands full Skill
instructions after the prompt under `Skill instructions`, without repeating the prompt or creating another card.
Inline `/skill:<name>` text throughout the prompt receives the same colors in its original position. This decoration
does not invoke Skills or add instructions for textual mentions. Expanded instructions share the inline decoration; fenced code and hyperlink targets remain native.

Live and restored regular/fullscreen TUI share the same rendering. Session content, Provider input, editor history,
and HTML export retain their native semantics. The version-bound adapter is released on Session switch, shutdown,
and `/reload`. Initialization incompatibility fails clearly; an exceptional presentation failure during work retains
native messages, disables further User Message projection for that Session, and reports once through `/diagnostics`.
Use `/reload` to attempt installation again. Unexpected fallback in normal certified scenarios fails acceptance.

## Thinking labels

Pi owns Thinking content, visibility, and run boundaries. With Pi's native **Hide thinking blocks** setting disabled,
each streaming or settled Thinking run occupies one line: `• thoughts: ` followed by the last terminal row from its
current native Markdown rendering. Streaming updates replace that line, and a settled run keeps its final line. If the
combined line is too wide, the content tail remains visible. With the setting enabled, the Host replaces each run with
the italic `• thoughts` label. One blank row separates adjacent Assistant prose and Thinking runs in either order,
including within one Host Assistant message. `Ctrl+T` continues to toggle the Host setting.

This is display-only. Pi Stuff uses no semantic parser, source truncation, timer, model classification, or merged run
state. It preserves the native Markdown styling of the selected terminal row and never changes Session records,
Provider context, copy, or export source. Pi currently exposes no public post-render Thinking hook, so the adapter is
bound to the certified Host component layout and fails clearly when that layout is unavailable.

## Charts and trees

Complete Markdown fences tagged `chart` or `tree` can render as terminal visualizations:

````markdown
```tree
Pi Stuff
  Work
    Goal
    Agents
  Context
    Search
    Compaction
```
````

Projection is display-only. Stored Markdown and provider messages keep the original fence. Incomplete, malformed,
unsafe, nested, oversized, or too-narrow visualizations remain ordinary code. One Assistant message may project up to
16 visualization blocks, each with at most 12,000 source characters.

## Command Dialogs

Pi Stuff commands use a shared full-width, non-floating Command Dialog. It provides stable focus, responsive layout,
semantic state rows, and one Escape route back to the editor. Only wide inspection workflows such as `/tools` and
`/tasks` use split panes; other dialogs remain single-column.

Blocking permission or confirmation work takes precedence over ordinary inspection and restores the previous view
after it closes. Shared geometry and interaction rules are defined in [DESIGN.md](../../DESIGN.md).

## Diagnostics

`/diagnostics` lists bounded, redacted problems from the current process. Each entry identifies the owning capability
and the action to take when a guided recovery path exists. Opening the dialog acknowledges visible notices; diagnostics
do not become conversation messages.

## See also

- [Conversation UI Module README](../../packages/pi-stuff/src/conversation-ui/README.md)
- [Command reference](../reference/commands.md)
- [Settings reference](../reference/settings.md)
- [Troubleshooting](../troubleshooting.md)
