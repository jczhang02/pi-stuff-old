---
status: accepted
---

# Preserve Magic Context behavior through Suite integration

## Context

When Magic is enabled, it owns projection and all compaction. Pi Stuff must not substitute raw Session history or Pi
native summarization after a Magic failure. Pi owns foreground execution, Session persistence, retry, and queue delivery.
This decision supersedes ADR 0026 and the native-fallback clauses in ADRs 0007, 0019, and 0029.

## Decision

Use Magic's existing identity resolver on every projection; equal message counts do not prove positional alignment.
Every foreground Context event calls Magic, which owns its own projection state. The Suite keeps no additional reuse
cache. Local estimates remain display and proactive-compaction inputs, never grounds to interrupt an otherwise viable
Agent run. Optional maintenance failure alone does not invalidate a usable foreground projection.

On actual overflow, Pi's public custom-compaction hook invokes the existing Magic Historian. It commits a genuine
compartment and returns its durable summary and retained-history boundary. Pi persists the compaction and performs its
existing post-compaction retry. A second overflow ends that attempt under Pi's existing policy; the Suite adds no
foreground retry loop. Manual compaction also uses Magic. Full recomposition (`/ctx recomp`) remains explicit.

One fault-recovery phase has a shared ten-minute deadline and at most one automatic Worker restart. Historian work,
existing transient retries, backoff, and completion verification share that allowance. No forward progress stops
earlier. Healthy Agent execution, ordinary proactive compaction, and the subsequent normal Provider response are not
timed by this allowance. Restart reconstructs from the Pi Session and Magic store, preserving selected Tools.

After a lost acknowledgement, inspect durable completion before repeating work. Reuse a confirmed compartment and
pending Pi boundary. Retry only confirmed incomplete, safe work; uncertain completion stops with an explanation.
Cancellation must reach the compaction invocation and prevent late publication. Session changes invalidate old results
and effects. Accepted input and completed Tool results remain in their existing Session records; recovery never replays
completed Tools or resubmits input.

## Host behavior and presentation

Input during recovery follows Pi's compaction queues. Explicit cancellation stops Magic's invocation; Pi may then
deliver queued input, as it does without Pi Stuff. The Suite neither drains nor resubmits these queues and does not
patch Pi to impose a different terminal policy. WebSocket/SSE selection is outside this change.

Use the existing Context display for `recovering` and its current phase. Recovery success clears that state; an
unrecoverable failure explains the cause once and states that the Session and input are preserved. Technical diagnostics
stay outside model context. An unknown or high estimate does not itself report a recovery failure.

## Consequences

A native fallback changes the selected compression authority. Estimate-based request rejection cannot establish a
remote Provider limit. Merging the Host adapter and Magic's own Pi adapter would conflate UI/Worker integration with
upstream message and storage semantics. Keep those responsibilities separate and patch the pinned upstream artifact
only where its own behavior needs correction, with provenance and removal criteria in `UPSTREAM.md`.

Direct patched Magic and the full Suite must agree on input, compaction, and cancellation semantics except for explicit
Suite UI and bounded BTW/Agents reference projections. Validate recovery, exhaustion, completed Tools, Worker failure,
lost acknowledgements, Session isolation, and cold resume at the real Host seam. Fixture-injected overflow proves control
flow, not remote capacity; live Provider evidence must be reported separately. Existing user-visible capabilities remain.
