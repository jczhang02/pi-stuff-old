# Pi Stuff reliability repair plan

[Simplified Chinese](../i18n/zh-CN/docs/research/pi-stuff-reliability-repair-plan-20260906.md)

**Date:** 2026-09-06

**Status:** Complete plan and testing boundaries confirmed; ready for independent implementation.

**Work:** `ps-8ew`, scheduled and verified as an independent repair workstream.

**Specification:** [ps-8ew / GitHub #239](https://github.com/jczhang02/pi-stuff/issues/239).

**Local evidence baseline:** `d620c43dba9f904e7c895c708a535ab5715fb4fc`, certified Pi 0.85.1.

This is a planning record, not a claim that the repairs are implemented or accepted. Record the final repair revision
and certified Host version used for acceptance.

## Confirmed direction

- **Q1 — Preserve useful capabilities; reconsider customization.** Interaction, module boundaries, and implementation
  may change. Existing ADRs, the one-Package structure, Effect adoption, and current ownership allocations are inputs
  to reassess, not reasons to retain broken behavior. A local deviation without demonstrated benefit should give way
  to the upstream behavior. Any resulting durable contract change must update its owning document.
- **Q2 — Repair the complete affected chain.** Start with Subagents and follow the relevant Context Management, Goal,
  Code Mode, Tool execution, and result-delivery paths. Add other forks when concrete failure evidence warrants it.
  Do not turn this repair into an unbounded whole-repository rewrite or audit.
- **Question format.** Every subsequent product decision must include relevant harness comparisons, primary-source
  links, and the distinction between verified behavior, inference, and unknown behavior. Ask only material product
  questions. Direct npm use, a thin adapter, or a retained fork is an evidence-based implementation choice.

## Q3 — Background completion and continuation

The confirmed decision is to return a background child's result automatically and let the main Agent finish the
original open task. A UI-only notice followed by a required user prompt does not satisfy this behavior.

| Reference | Established behavior | Limit of the evidence |
| --- | --- | --- |
| pi-subagents 0.65.1 | The notifier sends completion content with `pi.sendMessage`; `triggerTurn` defaults to true. | This requests a Host turn. Package-level completion batching does not establish Host busy/idle scheduling, and owner checks do not prove cancellation suppresses every late turn. |
| Codex | The main thread coordinates subagents and consolidates their results into its final response. | The cited product documentation does not specify idle-parent wake-up, busy-parent delivery priority, or late results after cancellation. |
| Claude Code | Background subagents run alongside the main conversation; results reach Claude as completion notifications in a later turn. Claude waits for the notification before reporting results. | This does not specify every idle wake-up or cancellation edge case. |
| Local Pi Stuff baseline | A custom Session entry records completion for UI display but is excluded from model context. The background launch receipt says completion will not start another main turn. | A visible completion row is not evidence that the main Agent received or integrated the child result. |

Sources: [pi-subagents release commit](https://github.com/nicobailon/pi-subagents/commit/83be9c3de2cde1553c0269f383efc1eb1194dc8b),
[notifier](https://github.com/nicobailon/pi-subagents/blob/83be9c3de2cde1553c0269f383efc1eb1194dc8b/src/runs/background/notify.ts#L373-L390),
[default turn request](https://github.com/nicobailon/pi-subagents/blob/83be9c3de2cde1553c0269f383efc1eb1194dc8b/src/runs/background/notify.ts#L639-L659),
[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[Claude Code subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background),
[local completion handling](../../packages/pi-stuff/src/subagents/src/extension/completion-handling.ts), and
[local launch receipt](../../packages/pi-stuff/src/subagents/src/extension/product-executor.ts).
Public documentation was consulted on 2026-09-06; it is not a local acceptance run.

**Confirmed decision:** automatically deliver a bounded result plus retrievable output references.
While the original task remains open, resume integration when idle and queue delivery when busy. A user-canceled or
explicitly ended task must not restart because of a late result; retain the result for inspection. Coordinate this
with Goal so one completion does not start duplicate continuations. Reaching idle or yielding a nonterminal update
does not itself discharge pending delegated work. These edge-case rules are the agreed local contract, not an
assertion that every reference harness implements them. The durable decision is recorded in
[ADR 0033](../adr/0033-continue-open-work-after-background-agent-results.md); implementation remains pending.

## Implementation sequence

1. Compare the relevant released upstream behavior with the integrated candidate on the same Host and scenario.
   Prefer direct package reuse when it satisfies the required behavior; add the smallest adapter or retained patch
   only for a demonstrated gap. Record the disposition of affected fork adaptations, including removed protections.
2. Repair the owning shared seams for the five recorded defects below, inspecting foreground, background, detached,
   resumed, nested, and Code Mode callers where they use the affected path. Preserve the ability to resume meaningful
   work; a short payload or a terminal status alone is not success.
3. Apply the agreed completion policy across main-Agent delivery and Goal continuation. Check actual model-visible
   results as well as UI state. Update the owning Module contracts and replace conflicting ADR decisions explicitly.
4. Integrate the reliability repairs and verify one repair candidate. Reuse valid checks for the same revision,
   identify the certified Host baseline, and keep heavy competing jobs out of any resource measurements.

## Acceptance targets

| Work | Required observable outcome |
| --- | --- |
| `ps-qbn` | Under child Context pressure, established findings, completed checks, and the next useful action remain available through retained context or explicit retrieval; the child can produce the requested final result. A preserved raw Session alone is insufficient. |
| `ps-81j` | Request admission uses the actual model/request constraints. A conservative serialization estimate alone does not incorrectly abort an otherwise viable child request; real overflow remains a truthful, recoverable failure. |
| `ps-q2k` | An isolated task started in a repository subdirectory runs and resumes in the corresponding worktree subdirectory, retaining its files and working state. |
| `ps-sfx` | A run-wide cancellation also governs children registering after cancellation; they do not execute work or report success after the canceled run has ended. |
| `ps-gaz` | When a foreground completion file is missing or unreadable, status recovery preserves the canonical final report instead of replacing it with later progress text. |
| `ps-8ew.3` | Background outcomes enter the main Agent's context and permit useful integration without another user message. Busy/idle delivery, concurrent completions, Goal coordination, cancellation, duplicate suppression, and originating-Session identity obey Q3. |
| `ps-8ew.1` | Every affected fork adaptation has a justified disposition and behavior evidence. Removed upstream protections and relevant integration seams are checked, rather than approved because they satisfy an old ADR. |
| `ps-8ew.2` | Real-Host daily coding, delegated work, pressure, stop/resume, and the agreed result-delivery policy pass on the integrated revision; live-model evidence and limitations are reported separately from fixtures and performance measurements. |

For Q3, explicitly cover Session switching, exit, and user termination during result delivery: no result may wake an
unrelated Session or resurrect closed/ended work. Verify useful model-visible result integration and the final
deliverable, not merely the existence of a notification or Session entry.

The initial audit combined source/history inspection, deterministic production-path probes, historical incident
evidence, and 15 passing local tests. Those establish specific risks and existing working surfaces; they do not certify
the repaired end-to-end workflow. Automatic parent notification also does not by itself repair evidence lost inside
an unfinished child. The maintainer confirmed the complete plan and testing boundaries on 2026-09-06.
Implementation and acceptance remain open under `ps-8ew`.
