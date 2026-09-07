---
version: alpha
name: Pi Stuff
description: Conversation-first terminal capabilities that remain inside the native Pi Host.
omitted:
  - section: colors
    reason: Pi Host semantic theme tokens are normative; The inline Skill command palette is the sole fixed ANSI exception.
  - section: typography
    reason: The Host and terminal own the font family, size, and cell metrics.
  - section: rounded
    reason: Terminal surfaces use character-cell geometry and do not use rounded corners.
  - section: components
    reason: The current component token schema is CSS-shaped and cannot describe Pi TUI behavior faithfully.
spacing:
  dialog-gutter-cells: 2
  section-leading-blank-rows: 1
  internal-divider-cells: 1
---

# Pi Stuff Design System

## Overview

**Creative north star: “The Quiet Terminal Workbench.”**

Pi Stuff is a set of working surfaces inside Pi, not a second terminal application. The conversation remains the
place where work happens. Temporary surfaces appear only when the user asks to inspect or control something, preserve
the surrounding Host, and disappear without leaving duplicate state behind.

Claude Code is the primary reference for readable hierarchy, restrained density, and visible lifecycle. Pi remains
the authority for interaction grammar, focus, theme, editor ownership, and terminal behavior. Reproduce the useful
reading order and operational calm; do not copy Claude-specific colors, labels, paths, or shell structure.

The interface should feel dense enough for daily engineering work but never cryptic. A user should first see the
identity or outcome they came for, then status and metadata, then bounded detail. Internal protocol concepts appear
only when they help the user act or when an explicit raw/debug view is opened.

## Colors

Color comes only from the active Pi theme. Use semantic roles such as text, muted, dim, border, accent, success,
warning, and error. The sole terminal palette exception is inline Skill command decoration, which retains the
explicitly requested workflow demo rainbow colors. Other surfaces must not hard-code an ANSI palette
or choose values for one personal theme.

Accent identifies focus or the one active interaction. Routine information stays in ordinary or muted text. Success,
warning, and error colors reinforce explicit icons and words; color is never the only evidence of state. Every visible
surface must remain legible in both light and dark Host themes.

## Typography

The terminal owns type. Pi Stuff does not prescribe a font, font size, or weight scale beyond capabilities exposed by
the Host.

Create hierarchy with concise wording, bold only where identity or a primary heading needs it, semantic color, blank
rows, and stable alignment. Agent names, Tool Activity summaries, task identities, and the current Context usage are
stronger than section labels and metadata. Avoid decorative capitalization and dense runs of equally emphasized text.

All measurements and truncation operate on visible terminal cells, not JavaScript string length. CJK, emoji, ANSI
sequences, and wrapped continuation lines must retain correct alignment.

## Layout

The conversation document is primary. Focused Capability surfaces are full-width, non-floating Command Dialogs that
temporarily replace the editor region while leaving the conversation visible. Settings use Pi's native SettingsList.
Normal-screen Todo and Agent roster rows occupy only their owned space and collapse to zero height when absent.

Command Dialogs use a two-cell outer content gutter. Within that gutter, headings, body copy, Agent messages, Tool
rows, result previews, and wrapped lines share one content edge. Do not create another indentation level for every
section or event.

When peer items are inspected in one Dialog, keep the outer geometry stable so selection does not move the editor and
surrounding conversation. Long content scrolls inside the content window. At low height, preserve the Header, current
selection or first important detail, attached error, and Escape route before secondary counts, descriptions, hints,
or surrounding rows.

At narrow widths, remove information in this order: decorative wording, counts and ages, optional descriptions,
targets and previews, then secondary metadata. Preserve primary identity, useful summary, lifecycle state, selected
action, and the way back. Wrapping must not introduce extra indentation or repeat a section heading on continuation
lines.

A wide split view remains one Dialog surface. Its top structural rule is continuous across the full width; one internal
vertical divider separates navigation from detail. It must not look like two adjacent cards. Use this shape only for
`/tools` and `/tasks`, where the user repeatedly switches between peer rows and their details, and collapse to a single
column before either side becomes unreadable. `/agents`, `/diagnostics`, and `/btw` remain single-column at every width.
Show pane focus with the semantic accent on the active pane heading, not with another short vertical rail.

## Elevation & Depth

Pi Stuff is flat. It has no shadows, blur, floating cards, or decorative layers. Depth comes from ownership and
sequence: conversation, temporary focused surface, selected row, then detail.

Use one structural divider, restrained spacing, semantic contrast, and compact section headings to express that hierarchy.
Do not surround each section with another frame. The scrollable Welcome identity card is the sole confirmed bordered
exception because it belongs to the conversation document rather than the temporary Dialog system.

## Shapes

The shape language is terminal-native and rectilinear. Structural Dialog rules use heavy box-drawing characters; a
wide split uses a heavy `┃` divider beneath one continuous `━` top rule. Section headings use no icon. Ordinary
headings use bold accent text; Error uses bold error text; Rejection and Cancellation use bold warning text. One blank
row separates a section from preceding content, and its body begins on the next row at the same two-cell Dialog gutter.
Do not add a replacement symbol, colon, uppercase transformation, underline, or section frame.

`›` means the currently focused selectable row and nothing else. Lifecycle and severity use separate one-cell-safe
icons. The Conversation Transcript's small `•` marker remains unchanged. Ordinary Goal lifecycle info notices reuse it
as a Transcript-record marker; their complete action word and semantic color convey lifecycle. Dialogs inherit the
Transcript's restrained, semantic status language, but never reuse its generic message marker as a lifecycle icon.

Use icon families consistently: `●` for active work, `○` for queued or inactive work, `◐` for a transition such as
stopping, `↻` for resuming, `✓` for success, `!` for attention, `×` for failure, and `■` for a stopped or deliberately
disabled state. A compact list may omit the state word; a detail Header keeps the complete word.

## Components

### Command Dialog

One full-width top rule introduces the surface. The Header answers the surface's primary question before presenting
metadata. Escape returns exactly one level and eventually restores the captured editor draft, Footer, working indicator,
Todo, and Agent roster.

### Lists

Rows keep a stable domain order unless the owning ADR says otherwise. Live updates change rows in place and do not
steal focus. A row begins with optional `›`, then its primary identity or readable summary, with lifecycle icon and
low-priority timing or counts later. Overflow uses `… N earlier/newer` and `… N later/older` around a focused window.

`/tools` rows use Tool identity, bounded operation identity, optional verified non-state evidence, then an explicit
icon-and-word state. Omit generic outcomes such as `done`, `completed`, `finished`, `running`, `success`, or `error`
when they merely restate that state.

Resolve standard selection actions through Pi's injected keybinding manager. Up and Down move one row, with
Ctrl+P/Ctrl+N as read-only aliases. PageUp and PageDown move one visible page, with `b`/Space as compact-keyboard
aliases; Home and End jump to the first and last row. These aliases apply only to custom read-only lists and details,
never text input, Settings, or confirmation controls. Show page hints only when overflow exists, and expose the full
contextual map through `?` rather than crowding every Footer.

### Detail sections

Use concise headings such as `Task`, `Activity`, `Output`, or `Details` with the hierarchy defined above. Section sets
are specific to the job: `/agents` is organized around Agent identity, Task, optional outcome, and Activity; `/ctx`
begins with Context usage; `/diagnostics` begins with the problem; `/tools` begins with a readable Tool Activity. Do
not force every Dialog into the same field template.

`/btw` is a deliberate reference-matching exception: it shows the question followed directly by the Markdown answer,
with no generic state line or `Answer` section. Its history controls stay in the Footer rather than creating a second
pane or card.

Keep complete relevant event order but bound each expensive preview. Say how much was omitted. Raw identifiers,
arguments, and protocol content belong behind an explicit raw/debug action rather than in the default reading path.
`/tools` Formatted file-mutation detail may use syntax and semantic diff color only after Tool text is sanitized;
gutters remain low contrast, while Raw protocol detail remains unstyled.

### Wide work inspection

At terminal widths of at least 96 cells, `/tools` and `/tasks` may show a non-empty list and selected detail together.
Each remains one fixed 18-row Dialog, with one continuous heavy top rule and one heavy internal vertical divider.
Switching rows keeps this geometry fixed. Empty and narrow versions remain single-column list/detail flows.
Tab and Shift+Tab switch the focused pane; Enter moves from the list to detail, and Escape returns one level.

### Persistent and transcript surfaces

Todo, Agent roster, Statusline, Conversation Transcript, and Command Dialogs have different jobs. A state has one
visible authority; do not repeat it in a permanent dashboard. The shared Statusline's conditional Goal segment is the
current Goal's sole compact persistent authority, while Goal lifecycle notices remain chronological Transcript events
and Command Dialogs provide inspection and control. An accepted terminal Goal Tool row shows only the machine outcome;
the following Goal Final Response is the sole detailed result, and no terminal notification duplicates it. Ponytail
follows the same boundary: `󱖿 <mode>` is its only
persistent mode authority, the Host working indicator remains the only Agent-activity authority, and `/ponytail` provides control.
Its Dialog temporarily suppresses the composed Footer, preserves the editor draft, and keeps environment overrides
visible without presenting them as writable settings.

The native Vibe Line Spinner and working message appear once in the editor's top border, using Pi's thinking-level
colors, clipping, and animation. Conversation UI preserves that Host capability through its input wrapper; it adds no
second working row, timer, or status state. Completion, cancellation, Command Dialog restoration, and reload retain
Host lifecycle authority. Existing input highlighting, autocomplete, and draft behavior remain intact.

The Statusline is a Nerd Font-only surface. Its fixed grammar is `󱙺` model, `` Thinking, `` Fast, `󰉋` directory,
``/``/`` branch tracking, ``/``/`󰏫`/`󰝒` Git state, `󰌨` Context, `󰆼` cache, `󰊚` weekly
allowance, `` cost, ``/``/``/`` Goal state, `󱖿` Ponytail, and `` Prompt. Branch tracking and Git
file state form one visual group separated by spaces; middle dots separate that Git group from neighboring Statusline
groups. Every semantic icon and state marker in either row must use a Nerd Font glyph; do not add Unicode/ASCII
fallbacks, terminal detection, or an icon-mode setting. Separators and truncation marks such as `·` and `…` remain punctuation rather than semantic icons. Reuse a
Capability identity icon, such as Ponytail's `󱖿`, in its owning Dialog instead of introducing a second visual identity.
A Dialog redesign does not silently change transcript markers or Tool rendering.

User Messages retain the native full-width `userMessageBg` card, horizontal padding, and vertical whitespace. A single
`` occupies the Tool marker column; text and wrapped continuation lines align with Tool text at the certified
`outputPad=1` profile. The marker denotes a Provider Prompt, including automatic user-role submissions. It does not
assert human authorship. Other Host padding values remain configurable without an added alignment guarantee.

Ordinary prompts and Skill invocations share that card. A recognized Skill appears inline as `/skill:<name>` with
the static workflow demo rainbow palette before the prompt, without its own background, frame,
title, or expansion hint. Skill-only
invocations use the same layout. Inline `/skill:<name>` text throughout a User Message uses the same palette,
without changing invocation semantics or adding instructions for textual mentions. Block Markdown starts below the Skill identity; wrapping preserves native Markdown
hierarchy and terminal-cell alignment. Native `Ctrl+O` and the Host's current expansion state remain authoritative.
The Skill prefix joins the first native paragraph before wrapping; native hard breaks remain intact.
Expanded instructions use the same inline Skill decoration and follow the prompt under a low-emphasis `Skill instructions` label inside the same card, with no
duplicate marker or prompt. Live and restored regular/fullscreen TUI share this presentation; HTML remains native.

Thinking stays inside the Host-owned Transcript. When visible, every Host Thinking run occupies one row: `• thoughts: `
followed by the last terminal row from its current native Markdown rendering. Streaming updates replace that row, and
the settled run keeps its final row. When hidden, the run becomes `• thoughts`. The label uses the Host `thinkingText`
color and italic style, while its content retains native Markdown styling. If the combined row is too wide, it keeps the
content tail. One blank row separates adjacent Assistant prose and Thinking runs in either order, including within one
Host Assistant message. Pi Stuff does not merge runs, parse source into semantic fragments, add a timer, or own
visibility: Pi's setting and `Ctrl+T` remain authoritative. The version-bound component adapter fails outside the
certified Host layout, and it never changes the canonical message.

A valid `chart` or `tree` fence may become a Fenced Visualization Projection inside the same Transcript message. Keep
the result flat, monochrome, and terminal-native: inert borderless code-block text and Unicode plot or tree glyphs,
with no frame, ANSI, or new focus surface. Measure every row in terminal cells. Charts reduce within their bounded
plot grammar; trees
never truncate labels and fall back to their source fence when one complete row cannot fit. The outer Assistant `• `
remains the only message authority, and Thinking never becomes a visualization.

## Do's and Don'ts

### Do

- **Do** lead with what the user recognizes: Agent name, work identity, Tool Activity summary, problem, or Context use.
- **Do** keep focus, ordering, scroll position, and outer geometry stable across live updates.
- **Do** pair state color with a fixed icon, and retain the full state word where detail or risk requires it.
- **Do** honor Pi's configurable selection actions, preserve PageUp/PageDown, and provide `b`/Space as read-only
  compact-keyboard page equivalents.
- **Do** verify accepted surfaces in the real Pi Host at wide, narrow, and low terminal geometries, in light and dark
  themes; the native terminal is the final visual authority.
- **Do** keep content ownership and safety boundaries unchanged when presentation changes.

### Don't

- **Don't** create another CLI, TUI shell, floating modal system, or permanent Package dashboard.
- **Don't** hard-code colors outside the documented Skill palette exception, fonts, or a personal terminal theme.
- **Don't** make two columns look like two separate Dialogs; keep one continuous structural surface.
- **Don't** frame individual sections or add nested indentation to simulate hierarchy.
- **Don't** reuse `›` or the Transcript's `•` as lifecycle state. A Transcript notice may use `•` only as its record
  marker; don't use one universal circle for every state.
- **Don't** duplicate Todo, Agent, BTW, Permission, Tool, or diagnostic state outside its owning surface.
- **Don't** copy Claude-specific presentation when it conflicts with Pi's native behavior or Pi Stuff's domain terms.
