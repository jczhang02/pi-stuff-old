---
status: accepted
---

# Keep productive work independent of internal retention quotas

The Context fallback, request-admission, and recovery clauses below are superseded by
[ADR 0031](0031-preserve-magic-context-behavior-through-suite-integration.md). Other decisions remain unchanged.

## Context

Several Pi Stuff safety bounds currently act as lifecycle decisions even though they measure only retained evidence or
elapsed time. Examples include the Code Mode Session-ledger byte ceiling and nested-call count, Background Work's
output ceiling, and Agents' cumulative protocol bytes, launch count, default run timeout, and default fast-Tool
timeout. A long but healthy task can therefore be stopped by Suite bookkeeping rather than by its owning lifecycle.
Raising those constants only postpones the same failure.

Not every bound is arbitrary. A model has a finite request window, concurrent processes consume real resources,
untrusted protocol records require validation, and cost or no-progress guards prevent runaway automatic work. Explicit
user deadlines and Session termination are also intentional lifecycle input. These boundaries must remain distinct
from limits on how much diagnostic or replay evidence Pi Stuff retains.

## Decision

Pi Stuff adopts the **Work Continuity Contract** for productive work in the current Pi Session. Suite-authored
cumulative ledger bytes, retained output, completed operation counts, completed Agent counts, and implicit wall-clock
thresholds must not by themselves terminate productive work. The Capability that owns a lifecycle remains responsible
for implementing this contract at its own boundary; Pi Stuff does not add a central work manager.

Retention is not lifecycle authority. Background output, Child Agent protocol diagnostics, Child transcripts, and Code
Mode traces may retain bounded tails or rolling evidence with explicit omission counts. Crossing a retention threshold
discards only non-authoritative evidence and does not signal or fail the producer. A malformed individual record may
still fail at its trust boundary.

Effect authority is stricter. Code Mode keeps its exact replay state in append-only Pi Session custom entries without a
cumulative byte quota. Inputs known before execution may retain per-operation validation. Once an effect may have
occurred, failure to append its canonical completion leaves the execution incomplete, stops later nested calls, and
must never cause automatic replay. Pi Session history remains the sole Code Mode ledger; Pi Stuff does not add a
sidecar database, payload-artifact store, or garbage collector without measured need and a Host-supported authority
model.

Agents have no default total runtime, default cumulative launch count, or implicit timeout for ordinary child Tools.
A caller may still request an explicit run or Tool deadline. Running concurrency, nesting depth, pre-launch model
capacity checks, cost attention, and safe protocol-frame validation remain enforced. Agent setup hooks likewise run
without an implicit deadline and may opt into one explicitly.

MCP Tool and resource requests have no default absolute request deadline because abandoning a mutation-capable request
can leave its effect uncertain. A configured positive deadline remains authoritative. Connection, authentication, and
metadata discovery retain their bounded setup behavior; Provider and read-only Web operations may retain call-local
no-progress or retryable-read deadlines.

Context Management does not mutate Host settings or take over Pi's native compaction. When Magic Context is active and
native compaction is disabled, the owned `/ctx` status surface reports that continuity has no native fallback and points
to the explicit Host setting that restores it.

The contract ends when the user stops work, the current Session ends, an explicit deadline expires, an owning safety
policy pauses automatic work, a trust boundary rejects one operation, or a real resource or persistence failure makes
continuation unsafe. It does not create a daemon or promise continuation across Session switching or Host restart.

## Rejected alternatives

- Increasing existing constants preserves hidden eventual failure and does not satisfy long-running work.
- Removing every bound would conflate arbitrary retention quotas with validation, concurrency, model-capacity, cost,
  and runaway protections.
- A central long-running-work manager would duplicate lifecycle authority already owned by Goal, Agents, Background
  Work, Code Mode, MCP, and Context Management.
- A Code Mode sidecar ledger or payload-artifact store would add another persistence path while append-only event
  metadata could still grow; physical Session compaction belongs in a future Pi Host seam if measurements require it.
- Automatically changing native compaction settings would violate configuration ownership and pure startup.

## Consequences

Capability-local implementations become simpler in the common case: producers continue, while existing output,
transcript, and trace seams bound only what they retain. Tests must prove that crossing each former cumulative bound no
longer terminates work, that omission is visible, and that explicit safety boundaries still behave as documented.

Session history and durable Agent state can grow until a real storage failure. Pi Stuff reports such failures rather
than predicting them with an arbitrary quota. If representative measurements later show unacceptable loading, memory,
or disk behavior, the next design must compact at the owning authority without changing settled effects or introducing
a competing lifecycle.
