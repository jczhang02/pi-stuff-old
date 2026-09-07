---
status: accepted
---

# Remove redundant Suite work without reducing functionality

During integration, this accepted ADR was renumbered from 0030 to 0034 because main already owns ADRs 0030–0033;
the decision and its evidence references are unchanged.

## Context

The maintainer accepted these decisions on 2026-09-05 after repeated Vibe Line stalls remained outside the completed
Tool Display fix. Remove redundant Suite work without cutting functionality, and verify resource use separately from
interface responsiveness. Acceptance thresholds must be calibrated before optimization; this decision does not claim
completed implementation or Pi 0.85.0 certification.

## Decision

### Confirmed scope

Eliminate unnecessary duplicate work and internal resource overhead throughout Pi Stuff, and eliminate Suite-induced
interface stalls, especially Vibe Line Spinner stalls. The objective is not limited to the Tool Display paths covered
by ADR 0028.

Existing functionality is not a removal candidate in this work. Automatic Session Naming, automatic usage refresh,
and other functional behavior must not be removed, disabled, or converted to manual actions to reduce resource usage.
Costs inherent to those features are outside the removal scope; redundant implementation work remains in scope when
the same behavior is preserved. Safety, permissions, data integrity, and canonical Session records remain intact.

Moving unchanged computation to another thread does not by itself reduce total resource consumption. Resource
efficiency and continuous interface responsiveness are separate requirements; both must be demonstrated.

On 2026-09-06 the maintainer clarified that this distinction does not prohibit execution isolation. Prefer the smallest
existing Worker or subprocess boundary for necessary independent computation and dependency evaluation. Pi keeps input,
rendering and canonical Session commits; `async` or a timer yield alone is not parallel execution. Retain measured,
simple deduplication, but do not expand this effort into speculative caches or an unbounded micro-optimization audit.
An isolation change must separately verify input, cancellation, recovery and data consistency, and report its total
resource cost even when memory or elapsed time increases.

### Confirmed resource trade-off

A small, bounded amount of retained memory may replace repeated computation when measurements demonstrate a benefit.
Reuse existing state first. Any additional cache must have a capacity bound, correct invalidation, and a defined
release lifecycle; unbounded growth with Session history is not an acceptable way to avoid repeated work.

### Confirmed target Host

Final acceptance targets one fixed Pi 0.85.0 build and includes compatibility verification. Establish its exact binary
identity and align the repository compatibility contract as part of implementation. Run resource and responsiveness
comparisons against that same build; Pi 0.84.4 results or results from a different executable do not certify it.
This decision does not itself upgrade, restart, or replace any running user process.

### Confirmed stall responsibility

This work must eliminate stalls introduced or amplified by Pi Stuff. Suite-triggered repeated rendering or scanning
through native Pi APIs remains Suite overhead; calling a Host API does not transfer responsibility for the extra work.

Only paired evidence showing the same stall without Pi Stuff can identify a Host-only problem. Such problems must be
reported separately, and their presence prevents a claim that Pi as a whole is completely stall-free. Any additional
Suite contribution remains in scope even when the native Host also stalls.

### Confirmed responsiveness gate

One observed stall attributable to Pi Stuff blocks delivery, including an occasional stall during an otherwise smooth
run. Average or percentile improvements do not excuse an individual failure.

Measure the fixed native Host's normal cadence and observation error first, then lock the acceptance thresholds.
Check the longest visible spinner frame and slowest input and selection feedback, not only aggregate latency.
Do not reduce the refresh rate or relax thresholds to pass. Resource savings do not waive the responsiveness gate.

### Confirmed scheduling trade-off

After redundant computation is removed, necessary work may be split into bounded steps that let the interface respond
between them, even when that operation takes slightly longer to finish. This applies only to work that cannot be
eliminated while preserving functionality. Moving waste into the background is not an optimization, and inserting a
fixed wait before every Tool invocation is not an acceptable responsiveness mechanism.

### Confirmed completion conditions

Completion requires all of the following, not merely a fix for the observed Execution Ledger stall:

- Cover every Capability and the startup, idle, long-Session, Tool, Agent, Context processing, and recovery paths.
- Eliminate confirmed redundant work. Explain why retained overhead is necessary and provide before-and-after resource
  measurements. An unresolved investigation is not a completed item.
- Preserve functionality and pass real-Host acceptance on the fixed Pi 0.85.0 build without triggering the single-stall
  failure rule above.

Do not substitute an arbitrary percentage-reduction target for this closure, or treat focused test success as proof
that the whole effort is complete.

### Implementation constraints

The inventory follows every Capability in `packages/pi-stuff/suite.json`, including Agents lifecycle as well as Agent
Tool rows. Shared Package loading, registration, status projection, and cleanup are also in scope. For each path, record
its owner, trigger, input-size scaling, repeated work, measured cost, and either its removal or the reason it is needed.
An unmeasured suspicion is an investigation, not permission to delete behavior.

Prefer incremental updates at the existing owner over rebuilding a projection after unrelated changes. Execution
Ledger lookup is the first confirmed example: a new ordinary Session message must not force unchanged ledger events
through full normalization again. Preserve validation at external-data boundaries, correct branch and Session
switching, approval and replay safety, and canonical history. Unavoidable initial rebuilds still need responsiveness
coverage; a faster warm path does not excuse a blocking cold path.

Measure Host-thread work and total Suite cost, including Workers and subprocesses. Report CPU time, steady and peak
resident memory, allocation and garbage collection, I/O, wakeups, and operation duration with explicit measurement
limits. Before-and-after profiles must keep features, payloads, terminal sizes, cache conditions, and the Host build
comparable. Offline fixtures that omit a feature's execution do not certify that feature.

Observe the visible interface from outside Pi's event loop, continuously across pre-Tool processing, execution, and
settlement. Missing spinner observations or excessive observer gaps make a sample inconclusive, never a pass. Retain
individual maxima and failing traces; averages only summarize resource cost. Short baseline runs cannot establish the
final liveness limits or prove that rare stalls are absent.

## Considered alternatives

- Disable automatic features: rejected because it changes the product instead of removing duplicate work.
- Move the existing workload wholesale to Workers: insufficient because it can preserve or increase total cost.
- Reuse bounded projections, remove repeated work, then split necessary long operations: selected because it addresses
  both resource use and responsiveness while keeping current behavior.

## Consequences

The accepted work map is Beads epic `ps-yon`; detailed scope, blockers, and status stay in Beads. Coordinate the shared
Code Mode, Background Work, Agents, MCP, and Context seams with `ps-j3v` before implementation. The
[initial baseline](../reports/suite-resource-baseline-2026-09-05.md) records the first fixed-build measurements and
their exclusions. Existing certified contracts remain in force until the dedicated Host-upgrade work passes.
