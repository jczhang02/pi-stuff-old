---
status: accepted
---

# Unify User Message presentation inside the native Host

## Context

Pi renders a canonical Skill invocation with an appended prompt as separate Skill and User Message components.
Conversation UI will present that single submission as one User Message while retaining Pi's Session, message role,
Provider content, editor history, and native Markdown semantics. This decision records the agreed UI and implementation
direction; it does not claim an implemented or certified contract.

## Decision

### Agreed presentation

- Ordinary User Messages, Skill invocations with a prompt, and Skill-only invocations use the same full-width
  `userMessageBg` card, retaining native horizontal padding and vertical whitespace.
- One `` occupies the Tool Transcript marker column. The prompt and wrapped continuation lines start at the Tool
  text column, retaining the relative indentation of Markdown lists, code, and quotes. The marker denotes a Provider
  Prompt, including automatically submitted `role:user` messages, rather than claiming human authorship.
- A recognized Skill invocation appears as ` /skill:implement <prompt>`. Its inline Skill command retains the native
  `/skill:<name>` spelling and uses the static workflow demo rainbow palette; the prompt keeps
  ordinary text styling. No separate badge background, title, or card is added.
- Ordinary paragraphs follow the Skill identity inline. Block Markdown starts on the next line within the card;
  narrow terminal widths wrap naturally. The prompt remains readable without expanding the Skill.
- Native `Ctrl+O` controls expansion. Expanded Skill instructions follow the prompt inside the same card under a
  low-emphasis `Skill instructions` label. Expansion never moves the prompt below the instructions or repeats it.
  The collapsed row omits the expansion hint. The Host's current expansion state remains authoritative.
- Live and restored regular/fullscreen TUI share this behavior. Alignment certification covers the existing
  `outputPad=1` profile; other Host padding values remain configurable without a new alignment guarantee. HTML export
  retains its native presentation.

### Implementation

Use one version-bound presentation patch owned by Conversation UI at the Host's message insertion seam. Call the
original method first, then validate only the components added by that call. Build the replacement completely before
atomically replacing the matched components, retaining the original outer message spacing. Never remove an unchecked
number of trailing children or scan the complete Transcript on each message.

Use the metadata produced by Pi's Skill parser and native User Message/Markdown components. Prefer a User Message subclass that preserves
native card geometry, terminal message markers, theme invalidation, and output-padding updates, while exposing native
`setExpanded()` behavior. Do not reproduce Markdown parsing, interpret textual Skill mentions as invocations, or introduce a
parallel custom-message stream. The exact composition must first pass real-Host verification; inheritance alone is
not evidence that those behaviors survive.

Determine inline Skill placement from the first non-space block type emitted by the card's native Markdown token
renderer. Observe that card-local method while passing every token and argument unchanged to Pi; do not patch the
Markdown prototype or maintain a second block classifier. Prepend the Skill label to the first top-level native
paragraph result before Pi wraps it; block content keeps a separate label row. Forward every native argument,
including nested style context, unchanged. Preflight this version-bound component signal as well as
the insertion seam, and route an incompatible runtime signal through the same native fallback.

Observe the card-local native `renderInlineTokens` result to color inline `/skill:<name>` text before native wrapping.
Decorate only completed outermost inline results so nested emphasis cannot invent command boundaries. Match the
visible text across ANSI controls, then map colors back to the original control stream. Apply this to the prompt
and expanded instructions. Forward arguments unchanged, validate the returned string, preserve terminal hyperlink
controls and restore the
preceding foreground after each command. Fenced code remains native. This is decoration only: no additional Skill
invocations, instructions, or Provider content are synthesized. The fixed ANSI 256-color ring follows
`pi-dynamic-workflows` commit `56489683`, `src/workflow-editor.ts`. Each command begins at violet (ring index 26),
advances one color per character, and stays static in the Transcript; no animation timer is installed.

Install only for TUI through the existing Session presentation lifecycle, following the ownership and idempotent
release pattern used by Thinking. Session switches, shutdown, and `/reload` release the patch. Restore the original
method only while the adapter still owns the patched method. Do not claim compatibility with another extension that
modifies the same private seam.

Pi 0.85.1 replays replacement Sessions before emitting `session_start`. Retain only a weak reference to the native
InteractiveMode across release, with no retained Session context or diagnostic channel. At the next TUI binding,
reconcile already-rendered native User and Skill components once through the same projection, only if the remembered
Host's current SessionManager is identical to the binding's SessionManager. Skip cards already
projected by this adapter. Stop the reconciliation loop immediately when a caught projection failure disables
the adapter, leaving subsequent native components untouched. This avoids keeping the patch installed after release or rebuilding other Transcript state.

### Reliability and failure policy

The target is reliable operation on the exact Host certified in `docs/compatibility.md`, currently Pi 0.85.1.
Existing executable certification remains authoritative; a matching version string alone does not establish support.
Validate required Host methods and component contracts before enabling the adapter. Initialization incompatibility
must propagate rather than leave a partially loaded Suite.

If a presentation-specific structural or rendering failure occurs during work, preserve the native representation,
disable further User Message projection for that Session, and report once through the existing diagnostic channel.
Do not interrupt the Agent or rewrite previously successful messages. An explicit `/reload` may attempt installation
again. Recovery must cover failures after insertion as well as replacement construction; it must not swallow errors
from the original Host method or turn a failure into an empty message.

Fallback is exceptional containment, not supported behavior for a normal input. Any unexpected fallback in a certified
acceptance scenario blocks completion. Deliberately injected incompatibility tests must prove safe recovery separately.

### Evidence required before implementation completion

Verify the actual shared Host class identity and insertion seam in the certified executable before expanding the
implementation. Cover ordinary, Skill-plus-prompt, and Skill-only messages; block Markdown, CJK/emoji, long prompts,
narrow widths, light/dark themes, expansion, theme/padding changes, replay, Session switching, and `/reload`. Confirm
that canonical Session content and Provider messages are unchanged, retained prompt placement is stable on expansion,
and repeated installation/release does not accumulate wrappers or stale Session ownership.

Reuse focused component tests and the real-Host PTY harness. Mock-only evidence cannot certify this private Host seam.
Run the required repository checks and independent completion reviews against the final implementation.

## Consequences

The public Markdown transformer cannot remove the Host's separate Skill component and spacer. Copying the full Host
message branch would duplicate history and layout behavior; rewriting canonical messages would change semantics for
a display concern. A narrow patch avoids both costs but requires recertification whenever the Host changes. ADR 0001 permits
this limited presentation exception. `DESIGN.md` and the owning Conversation UI documentation define the visual
contract and retain their Chinese mirrors.
