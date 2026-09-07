# Contributing

## Before starting

Follow the task-specific reading and engineering boundaries in [AGENTS.md](../AGENTS.md). Use Beads for accepted
shared work under the [issue-tracker contract](../docs/agents/issue-tracker.md); external requests are adopted by a
maintainer first.

## Development

Use the repository's pinned Bun version and [verification policy](../docs/code-quality.md#risk-based-verification),
including its documentation-only path and reuse of required CI evidence for the same revision. Ordinary automated
tests stay offline and credential-free; live Provider or external-Service acceptance requires explicit selection.

For local work, use `bun run check` for Static Checks, `bun run test` for offline Tests, and `bun run verify` for the
read-only Plan/Checks/selected-Tests workflow. See the [quality-assurance guide](../docs/quality-assurance.md) for
scope, source-install evidence, and migration status.

CI records `Plan`, `Checks`, `Tests`, and `Verify` for the exact revision. Plan owns the existing conservative scope
decision, Checks runs static verification, and Tests retains the disconnected test/benchmark/packed-Host sequence.
Verify fails closed on missing or unsuccessful required jobs; a skipped Tests job is valid only after an explicit
successful no-tests plan. Manual dispatch always requests full tests. Publication must use these current results,
not relabel historical Fast/Acceptance runs. See the [compatibility contract](../docs/compatibility.md).

For continuous native Spinner, input, and autocomplete-selection checks, use
`bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN"`. It creates an isolated synthetic Session and retains raw
observations outside the repository. The [observer report](../docs/reports/suite-responsiveness-observer-2026-09-05.md)
documents frozen gates, negative controls, and the cold Execution Ledger reproduction. These focused checks do not
replace complete resource or Capability acceptance.

When `PI_STUFF_UI_PTY_ARTIFACT_DIR` is set, the observer also copies its evidence JSON there after capture. CI retains
these synthetic frames, interaction timings, Provider event logs, Session records and Source snapshots in its existing
failure attachment, including when a scheduler workload fails. Host binaries and private fixture configuration are
not copied. Scheduler summaries are saved after each completed workload and uploaded even if a later workload fails;
an incomplete batch is diagnostic evidence, never successful acceptance.

Manual CI dispatch accepts `probe_kernel_events=true` for a scheduler-event positive control on a separate
GitHub-hosted VM, then seven diagnostic workloads before ordinary acceptance. The workloads reuse the responsiveness
observer for native Pi, Suite Tools, foreground/background Agents, Context, Goal, and a cold Ledger. Only the collector
uses host-root tracing access; workloads run as the ordinary runner user in private user/network/PID namespaces.
Owned tracefs instances use a global clock and reject loss, incomplete task lifetimes, ambiguous root identity, and
unsupported nonleader exec. Wakeups follow the target task across thread/child births, exit cleanup, and PID reuse.
Counts and kernel event formats are retained as a summary artifact; raw system-wide traces are never uploaded.
Set `scheduler_baseline` to a full repository commit SHA to compare clean Package trees in baseline/candidate/candidate/baseline
order on the same runner. Each batch runs all seven workloads with the current observer and records the selected
Package commit; fresh processes/configuration are used, but kernel page caches are not reset. The observer's `--package`
option also supports local comparisons and retains separate observer and Package commit/diff provenance.
These diagnostic runs do not certify liveness. Ordinary acceptance still runs without tracing; a dispatch requesting
the extra measurements receives 25 additional job minutes for the serial comparison.
The collector passes `--diagnostic`, which allows 75 seconds of observation and cannot be combined with `--gates`.
Results record that budget and their diagnostic purpose. Ordinary observation retains its 30-second budget, or
60 seconds for Agents and Goal; the collector's outer 90-second process limit and all responsiveness gates are unchanged.

## Package changes

Pi Stuff has one private local Package. Capability Modules are not independently versioned or published. When behavior
needs a durable user-facing record, update `docs/releases/`. For Suite composition changes, edit
`packages/pi-stuff/suite.json` and run `bun run suite:generate`. Verify source installation with the applicable
Acceptance test, `tests/acceptance/repository/source-install.test.ts`; there is no registry publication or Changesets
workflow.

## Commits

Use signed Conventional Commits:

```text
<type>(<scope>): <imperative subject>
```

Maintainers may push verified commits to `main`. External contributions use a pull request for delivery and review;
accepted scope and status remain in Beads under the [issue-tracker contract](../docs/agents/issue-tracker.md).
Force-pushing and deleting `main` are prohibited.
