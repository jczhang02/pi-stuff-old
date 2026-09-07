# Agents cold loading and projector cost

On 2026-09-06, three uninstrumented full-Suite samples of the candidate passed the frozen responsiveness gates:
two direct foreground runs and one Code Mode run with an old Execution Ledger. Each launched two child Agents.
This is a verified checkpoint for `ps-yon.6` and `ps-yon.19`, not completion of the
[16-Capability resource audit](suite-resource-inventory-2026-09-05.md).

The [numeric record](agents-loading-and-projector-cost-2026-09-06.json) retains all 25 complete samples in this
investigation, including rejected intermediates, diagnostic runs, source and evidence hashes, resource snapshots,
and measurement limits. Raw Sessions, Provider logs, terminal frames and traces remain private.

## Two different costs

The base is `2428f1c1d1f24c6a91a3f26e387842e3259bffd3`. External scheduler sampling in `8UraCb` brackets its
224.319 ms cold Spinner hold with 234.525 ms elapsed and 221.773 ms of parent-main-thread CPU. This supports a
CPU-bound cold-loading investigation. In the earlier `5qyQdR` diagnostic, the correctly aligned 267.917 ms hold
contains 913 traced filesystem calls totaling only 6.629 ms. An initial analysis used the wrong time origin;
those discarded counts are not evidence. The trace excludes other syscalls and off-CPU causes.

A separate 10 ms CPU-sampling run, `ZvFFVd`, contains Babel/Jiti transformations across the foreground executor
and child task/process/protocol dependency chain. Its marked task-module import takes 98.293 ms. Profiling more
than doubles scoped CPU and increases memory substantially; sample occupancy is not exclusive CPU self-time.
The post-import native-event tail remains unassigned.

The candidate uses one Agents-local `deferredModule` helper to share a first-use import promise, with a zero-delay
timer turn before and after loading. Failed imports clear that promise; warm and concurrent callers reuse it without
additional timers. These are necessary dependency boundaries, not a delay before every Tool or speculative preloading.
Public executor, preparation/model planning, launch lifecycle, runner control/finalization, child engine and protocol
loads use their existing owners. Protocol loading finishes before spawning the child.

Trivial task-input helpers now live in the existing executor contract, and child-process input/control types have a
type-only contract. Test-only writer re-exports no longer make foreground execution load detached writer machinery.
Rejected launch inputs do not load builders. Directory claims, initial-status ownership, recovery, cancellation,
protocol validation, terminal draining and writer reaping retain their existing sequencing.

Narrower import cuts were insufficient: `0bVOtq` failed Spinner, `dyLBS2` failed selection, and `NNlRE0`
failed steady input at 40.990 ms against the unchanged 40.465312 ms gate. Later cold-chain cuts exposed a separate
270.053 ms late hold in `9LkXjG`, while the first child was waiting for its response. It preceded child settlement,
not a cold import. A passing retry would not resolve that failure.

## Repeated projector lock flushes

The 500 ms foreground heartbeat projects nested events before refreshing Current Agents. Its projector acquired a
stable-inode lock but also rewrote and synchronously flushed an unused diagnostic owner record on every acquisition.
None of the projector or retirement callers reads that record. The kernel already owns exclusion and process-death
release.

Targeted diagnostics used the same external per-capture scheduler reads and callback measurements before and after
replacing all four projector/retirement acquisitions with the existing `tryAcquireKernelClaim`.
No lock path, validation rule, acquisition retry, transaction, status/registry commit or retirement token changed.

| Parent diagnostic | Start, UTC | Heartbeats | Heartbeat total / maximum, ms | Projector owner fsync count / total / maximum, ms |
| --- | --- | ---: | ---: | ---: |
| Control `7YhlYi` | 08:41:05.932 | 49 | 547.724 / 50.959 | 53 / 510.847 / 49.670 |
| Candidate `6CBaI8` | 08:45:53.836 | 48 | 26.894 / 0.955 | 0 / 0 / 0 |

Nested projection itself fell from 531.871 ms total / 50.602 ms maximum to 16.059 / 0.832 ms. Current Agents
projection was at most 1.096 ms in the control; it was not changed. The three-second result safety scan saw empty
directories and was retained. Different heartbeat counts reflect operation duration, not a reduced refresh rate.

These timings identify removed synchronous owner-record I/O. They do not prove that the historical 270.053 ms hold,
or the earlier 489.594 ms `U4SAr9` hold, came from that I/O. Neither exact late hold has a matching causal trace;
GC attribution remains unproven. Both failures remain recorded.

## Uninstrumented native checks

All runs use the exact certified Pi 0.85.0 binary, embedded Bun 1.3.14, full Suite, 120×40 terminal, isolated
network/PID namespaces, fresh private settings and temporary caches. The kernel page cache is not reset.
The uninstrumented observer and frozen gate file are unchanged. No tests or profilers run concurrently.

| Sample | Start, UTC | Workload | Spinner maximum, ms | Steady input maximum, ms | Selection maximum, ms | Gate verdict |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Base `16AYGL` | 07:38:47.524 | Direct, twice | 258.466 | 78.354 | 15.628 | FAIL |
| Final `PaHqrD` | 08:47:17.205 | Direct, twice | 126.409 | 25.686 | 13.820 | PASS |
| Final `Rpps9R` | 08:48:26.348 | Code Mode + old Ledger, twice | 126.019 | 37.909 | 14.159 | PASS |
| Final `i21pqi` | 08:49:48.824 | Direct, twice | 137.184 | 25.971 | 25.956 | PASS |

All four complete and reap two children, request and persist automatic Naming once, and refresh Usage once.
Final samples have 37.0–37.4 seconds of active observation, at least 3,088 active captures, no active Spinner absence,
and capture gaps below 23 ms. Every owned scope was checked after shutdown and was not-found/inactive/dead.

The three final samples have identical 19-file source-diff SHA-256
`0e88e8a44e454ce01ed241eed1a98dd6584cdfcea6b1e0f2556d709786c7a5ae`.
Their scoped CPU totals are 22.536, 23.248 and 23.541 seconds; final aggregate RSS snapshots are 611.377, 653.545
and 603.226 decimal MB. The Code Mode snapshot includes its live helper. Neither the variable totals nor the
charged-memory peaks establish a stable whole-Host resource saving. Allocation, GC and complete wakeup accounting
remain unmeasured; final RSS is not peak process-tree RSS.

## Regression and remaining acceptance

The existing nested-projection regression failed before the lock change because projection replaced the established
owner record. It now verifies unchanged lock bytes and inode across new-event projection, authoritative projection,
failed unused-route retirement and terminal-root finalization with live descendants. Existing contention, draining,
recovery and process-death tests also pass: 37 tests / 152 assertions in four files. Cold-loading regressions cover
timer turns, concurrent reuse, retry and the actual import boundaries. Focused launch/lifecycle tests and
`bun run check:fast` pass; final review and same-revision delivery checks are tracked in Beads.

Changed production Source totals 4,225 → 4,272 lines; tests 965 → 1,061; the native-effect inventory adds one line.
The child engine shrinks 799 → 767 lines; its 59-line type contract permits callers to avoid loading the engine.
The 571-line task runner retains task-attempt/lifecycle cohesion; the 527-line nested-event test file retains the
shared public route fixtures and race/retirement scenarios. The numeric record lists every changed file and hash.

All temporary instrumentation is removed. These passes certify the listed workloads on this source, not absence of
rare stalls, complete resource dimensions, or the remaining startup/idle/long-Session/recovery paths across all
Capabilities. No user Host was restarted, no Package was installed, and no merge or epic closure is claimed.
