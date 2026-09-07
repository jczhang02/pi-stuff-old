# Matched Package resources and a retained input failure

Seven Suite workloads used less scoped CPU at `e7b1170e` than at the comparable pre-optimization Package `40101bb2`.
Their two-sample CPU medians fell 11.2–28.8%; every candidate value was below both corresponding baseline values.
One candidate background-Agent sample failed the frozen input gate: autocomplete appeared after 48.868 ms against
a 40.465 ms limit. The later passing sample does not erase that failure. Whole-Suite acceptance remains open.

The [numeric record](suite-comparable-resources-2026-09-06.json) retains all 32 samples, individual gate breaches,
Source identities and private-evidence hashes. Baseline and candidate use the same dependency lock and Package
dependency manifest. `40101bb2` already includes the certified Host adaptation, Work Continuity and Goal terminal
response semantics. The [earlier lifecycle comparison](suite-lifecycle-comparison-2026-09-06.md) used an older baseline
and cannot isolate this optimization's savings.

## Cost and visible feedback

All runs used the exact Pi 0.85.0 binary
`0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072`, embedded Bun 1.3.14 and a 120×40 terminal.
The observer used Bun 1.4.0. Measurements ran sequentially from 17:42:14 to 17:57:55 UTC on 2026-09-06,
on an i9-13900H with 20 online logical CPUs and Linux `6.19.10-jc-xanmod1`.

Batch order was baseline/candidate/candidate/baseline. Every batch ran Goal, native Tools, Suite Tools, foreground
Agents, background Agents, Context, cold Ledger Tools and cold Ledger foreground Agents, in that order. Each sample
used a fresh private profile and user/network/PID namespaces. No task tests, agents or other profilers ran concurrently;
ambient machine activity, CPU frequency and kernel page caches were not controlled. There were no discarded warmups
or retries. Two observations per variant are descriptive, not a distributional guarantee.

| Workload | CPU median, seconds: baseline → candidate | Charged-memory peak median, decimal MB: baseline → candidate | Largest Spinner frame, ms: baseline → candidate |
| --- | ---: | ---: | ---: |
| Goal continuation and terminal response | 12.809 → 11.114 | 990.6 → 923.3 | 114.9 → 111.6 |
| Native, two Bash Tools | 2.076 → 2.126 | 195.6 → 199.4 | 110.7 → 111.0 |
| Suite, two Bash Tools | 13.443 → 11.835 | 1,034.9 → 918.6 | 111.7 → 111.8 |
| Two foreground Agents | 29.535 → 25.152 | 1,596.0 → 1,513.0 | 473.5 → 123.1 |
| Two background Agents | 29.909 → 21.300 | 2,313.5 → 1,937.6 | 519.7 → 147.6 |
| Active Context write/search | 12.755 → 11.333 | 1,015.4 → 923.0 | 112.0 → 111.2 |
| Cold Ledger, two Code Mode Bash Tools | 14.184 → 11.854 | 1,033.5 → 896.3 | 183.8 → 133.2 |
| Cold Ledger, two Code Mode foreground Agents | 30.920 → 25.809 | 1,592.6 → 1,530.8 | 572.3 → 135.4 |

CPU and charged-memory counters cover the Host cgroup, including its Workers and reaped children, until final
observation before shutdown. The observer, tmux, synthetic HTTP server and Ledger seed creation remain outside it.
Cold replay is included. Moving foreground execution to a Worker did not merely move its CPU outside these counters.

Memory did not improve in every measure. Final live-process RSS medians rose from 645.4 to 663.9 MB for direct
foreground Agents and from 684.8 to 713.2 MB for the cold-Ledger foreground case. The other Suite final-RSS medians
fell. Final RSS is a snapshot, not peak process-tree RSS; charged-memory peaks include other charges and are not
cumulative allocation. Final-process I/O omits children that have exited, so it cannot establish total I/O savings.

Every Suite run requested and persisted automatic Naming once and performed one automatic Usage HTTP refresh.
Agent cases completed two child Tools and verified both child identities were reaped; background cases also persisted
two distinct completion outcomes while the parent finished independently. Context made three native requests and
retrieved its written evidence. Goal persisted completion and one final response after automatic continuation.
The cold Ledger contained 24 synthetic executions with 800,000-character results; seeding did not disable validation.

## Why this is not a pass

All samples had continuous observations: no active Spinner absence, at least 12.145 seconds of active coverage and
no capture gap above 24.608 ms. The candidate's only gate breach was `1-candidate-background`, evidence SHA-256
`d48fce849b085ef422a2360ccd5950faa97ae003f90121f202948d7f424141a7`.
Autocomplete setup began 10,639.420 ms after the observer's time origin. Three subsequent captures still showed no
completion list; the list and queued Agent roster appeared together at 10,688.288 ms. This establishes delayed
feedback around first Agent launch, not the responsible function. It is not discarded as an observer gap or attributed
to the native Host without a matching Suite-off reproduction.

The two baseline foreground and background runs each failed Spinner/input gates; both cold-Ledger Tool runs failed
the Spinner gate, and both cold-Ledger foreground runs failed Spinner/input gates. All failures remain in the record.
The [locked thresholds](suite-responsiveness-gates-2026-09-05.json) were unchanged. Passing candidate Spinner maxima
do not excuse the separate input failure or explain previously retained late holds.

An earlier local matrix against `6d0507c1` stopped at Goal before reaching the candidate: that Package's terminal Tool
semantics did not produce the current fixture's final response. Its partial samples are excluded here. Two separate
traced CI attempts at `e7b1170e` also stopped during baseline workloads before comparing candidates
([first](https://github.com/jczhang02/pi-stuff/actions/runs/34048786759),
[second](https://github.com/jczhang02/pi-stuff/actions/runs/34049432866)). Their final frames showed completed Tools
while Pi remained in recovery; those logs did not identify the cause. Traced runs are diagnostics, not liveness gates.

Allocation/GC, peak process-tree RSS, largest main-thread work intervals and the remaining owner/recovery cases need
separate evidence. The scheduler comparison below supplies wakeup counts. These measurements preserve automatic features;
they do not execute every configured external service or close the [resource inventory](suite-resource-inventory-2026-09-05.md).

## Config-directory follow-up

A background-Agent CPU diagnostic at `7fee89ed` sampled `realpathSync` through `getProjectConfigDir` during delayed
autocomplete feedback. The helper rediscovered Pi's immutable config-directory name from the executable and package
metadata on every call, including every project ancestor. It now uses the public Host constant already available
through its SDK import. The actual discovery regression changed from four synchronous realpath calls and 32 metadata
read attempts to zero for the same nested/root lookups. Existing path precedence, selected Skills and MCP checks pass.
The utility shrank from 510 to 441 lines; no cache or dependency was added.

Four unprofiled background-Agent runs compared clean `7fee89ed` with this one-file Package change in baseline/candidate/
candidate/baseline order. They reused the fixed binary, namespaces, terminal, fresh profiles, resource scope and frozen
gates above. Each completed and reaped two children, recorded two background outcomes and automatic Naming/Usage once.
The first setup attempt lacked the new baseline worktree's dependencies and failed before Session start; it produced
no workload sample. After frozen dependency installation, the four-run batch completed without discarded samples.

| Sample | CPU, seconds | Final RSS, decimal MB | Charged-memory peak, decimal MB | Longest Spinner, ms | Slowest input/setup, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline 1 | 20.995 | 587.5 | 1,950.5 | 160.455 | 37.473 |
| Candidate 1 | 21.267 | 597.3 | 1,959.3 | 123.937 | 72.710 |
| Candidate 2 | 21.255 | 595.5 | 1,916.8 | 111.618 | 14.059 |
| Baseline 2 | 21.237 | 589.1 | 1,938.2 | 114.089 | 14.183 |

This establishes removal of redundant operations, not a whole-workload resource saving or a stall fix. Candidate 1
still failed the 40.465 ms input gate; its evidence hash is
`72fa8cb1d855b1cec7e9b7315a523641f0e59cc3629175d363ea766deb397e5f`. Autocomplete setup began at 10,683.870 ms
and appeared with the queued Agent roster at 10,756.580 ms. All capture gaps were below 26.230 ms and no active Spinner
observation was missing. The profiler's earlier stack does not attribute this unprofiled failure, nor the original
48.868 ms event. The numeric record retains all four results and their Source/diff hashes.

## Traced CI deadline failure

The retained Provider and Session records from [run 34051108002](https://github.com/jczhang02/pi-stuff/actions/runs/34051108002)
identify why its baseline foreground observation was incomplete. Both children completed successfully. The parent
requested its final response at 2026-09-06 18:18:56.993 UTC; the fixture schedules that response four seconds later.
The last capture was at 18:18:58.831 UTC, 2,161.883 ms before the timer could fire. There was no Provider error in the
record. The 60-second observation budget ended before this traced workload finished; completed Tools were not evidence
of a Provider deadlock. Earlier failures without these records remain unattributed.

Scheduler diagnostics now request a separate 75-second observation budget. They cannot use acceptance gates, and their
results identify the diagnostic purpose and budget. Ordinary 30/60-second observations, the collector's outer 90-second
limit, isolation, completion checks and frozen responsiveness thresholds are unchanged. A successful future capture
would establish scheduler evidence, not excuse the retained input failures.

## Completed scheduler comparison

[Run 34052545498](https://github.com/jczhang02/pi-stuff/actions/runs/34052545498) completed all 28 scheduler observations
on kernel `6.17.0-1022-azure`, comparing Package `40101bb2` with `e51caab5` in baseline/candidate/candidate/baseline order.
All samples had zero lost events and complete task birth/exit accounting. The private trace instance tracked the
synthetic Host's threads, Workers and descendants through exit; the observer, tmux, HTTP fixture and Ledger seeding
were outside that boundary. No local permission change was needed.

| Workload | Median `sched_wakeup`: baseline → candidate | Change | Median `sched_wakeup_new`: baseline → candidate |
| --- | ---: | ---: | ---: |
| Native, two Bash Tools | 14,033 → 13,795.5 | −1.7% | 22 → 22 |
| Suite, two Bash Tools | 28,308 → 26,766.5 | −5.4% | 51 → 51 |
| Two foreground Agents | 77,201 → 82,507 | +6.9% | 122 → 128 |
| One background Agent | 45,936 → 40,887 | −11.0% | 89 → 89 |
| Context write/search | 24,096 → 23,637.5 | −1.9% | 25 → 25 |
| Goal continuation | 23,730 → 23,318 | −1.7% | 25 → 25 |
| Cold Ledger, two Code Mode Bash Tools | 28,730 → 27,274.5 | −5.1% | 61 → 60.5 |

Foreground isolation costs more wakeups in these samples. Its task count, including threads, rose from 122 to 128
while both implementations completed and reaped the same two child Agents. Internal task counts need not match when
comparing an isolation change; their full cost stays in the result. The Ledger baseline had 61 tasks in both runs,
while the candidate had 60 and 61. The summaries do not identify the source of that one-task variation.

The background scenario here uses one Agent, unlike the local two-Agent CPU batch. Each Suite observation retained
automatic Naming/Usage; foreground and background checks verified two and one child Tool completions respectively.
Context made three projections and retrieved its evidence; Goal completed after continuation. Artifact hashes and all
individual counters remain in `schedulerComparison` in the numeric record. Two observations per variant on a shared
runner do not establish a distribution or a causal explanation of the retained stalls. Traced timing is not ordinary
acceptance, and wakeups are not context switches.

## Targeted background-input diagnostics

Four separate diagnostics on `e51caab5` investigated the input failures without changing production behavior. The first
CPU profile observed 49.579 ms feedback, with 44 of 47 samples in that interval at native layout rendering. Sampling
also lengthened otherwise ordinary feedback, so those stacks do not establish the cause of either unprofiled failure.

Direct render timing in the next run recorded 430 paints: 360.564 ms total and 4.700 ms maximum. A separate mark around
the first FFI `flock` load measured 1.836 ms. Neither run reproduced the delayed feedback. A final file-syscall trace
recorded 18,039 completed parent-main-thread calls totaling 198.967 ms, with an 8.947 ms maximum while creating a Jiti
cache file during startup. Its slowest input/setup was 14.240 ms. These are observations from those runs, not bounds
on rare rendering or I/O delays.

All four workloads completed and reaped two child Agents, recorded two background outcomes and retained automatic
Naming/Usage. The render wrapper, FFI marks and strace command were temporary and are removed. The numeric record binds
the probes, profiles and observations to their hashes. No render rewrite, eager loading or filesystem change was made
from these non-reproducing probes. The next investigation measured the first-launch loading interval directly.

## Background cold-loading follow-up

Ten light-instrumentation runs at `f6a3285e` retained direct dispatch timing. Four initial runs measured roughly
147–160 ms in the first background execution call; one had 62.654 ms selection feedback overlapping its end.
Four finer runs measured 46.709–55.369 ms loading the background engine. In sample `HKOgzn`, autocomplete setup
started at observer-relative 10,904.078 ms and appeared 61.392 ms later. The import occupied 10,898.152–10,944.861 ms,
with 46.790 ms main-thread CPU and 0.048 ms scheduler wait. This identifies substantial Suite loading work during a
reproduced delay; it does not retrospectively attribute every earlier uninstrumented failure.

Two final probes explicitly loaded the already-required dependencies in sequence. Recovery-reader loading took
12.414/12.662 ms, runner-process loading 21.302/23.872 ms, and the remaining background module 12.855/13.136 ms.
These reordered imports are diagnostics, not acceptance samples. Main-thread CPU comes from `/proc` scheduler
accounting; its update granularity can exceed a short elapsed interval by about one millisecond. Awaited intervals
are not proof of one uninterrupted JavaScript task. All ten samples completed and reaped two children, retained two
background outcomes and automatic Naming/Usage once, and are bound to probe and evidence hashes in the numeric record.

The change separates publication of finalized recovery records from parsing retained recovery input. Both foreground
and background launch now use the same small writer; resume keeps the unchanged reader and full validation.
Necessary runner-process loading uses the existing first-use timer boundary after background launch preparation.
Import failure before spawn cleans the owned, unstarted directory. Test-only runner-control re-exports no longer pull
that stage into the launch module. No execution policy, refresh cadence, cache, dependency or permission was added.
The five production files and two tests total 1,758 lines, down from 1,761, including the new 18-line recovery writer.

Four uninstrumented runs compared clean `f6a3285e` with the complete retained change in ABBA order, under the same
fixed Host, features, namespaces, resource scope, terminal and frozen gates. No concurrent task tests, agents or
profilers ran. Both candidates passed every gate; baseline 1 reproduced a 73.002 ms autocomplete delay.

| Sample | CPU, seconds | Final RSS, decimal MB | Charged-memory peak, decimal MB | Longest Spinner, ms | Slowest input/setup, ms | Slowest selection, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline 1 | 21.464 | 600.3 | 1,922.9 | 147.954 | 73.002 | 14.036 |
| Candidate 1 | 21.552 | 582.9 | 1,948.0 | 113.064 | 13.821 | 13.788 |
| Candidate 2 | 21.503 | 588.8 | 1,939.8 | 124.125 | 13.962 | 14.933 |
| Baseline 2 | 21.373 | 605.4 | 1,930.1 | 136.869 | 25.202 | 13.698 |

CPU median rose 0.5% and charged-memory peak median rose 0.9%; final RSS median fell from 602.8 to 585.9 MB.
These totals do not establish a whole-workload resource saving for this follow-up. The removed recovery-reader work
is measured separately; two passing candidate observations do not prove that rare stalls cannot occur. Final RSS
and charged peak are not allocation or peak process-tree RSS. All four runs completed both children and background
outcomes, verified reaping and retained automatic Naming/Usage. Capture gaps stayed below 16.893 ms, with no missing
active Spinner. The original 60-second budget and thresholds are unchanged.

Three module-loading regressions failed before the change and passed after it. The focused loading, startup,
recovery and real-Host control checks passed 56 tests and 242 assertions; `check:fast` passed. An initial isolated
control-test invocation omitted its private state-root setting and failed three governor setup cases with `EACCES`.
Setting a fresh private state root fixed the harness; all four real-Host control cases then passed without a
permission change. That failed setup is not counted as an acceptance pass.

## Ordinary CI failure retained separately

The same `34052545498` run that completed the scheduler comparison later failed ordinary acceptance: 299 isolated
test files passed and `test/responsiveness-pty.test.ts` failed. Goal tests, the Tool benchmark and Package verification
did not run after that failure. Its one-Agent background sample `RRFa7j` had a 40.316 ms observer gap against the
40 ms ceiling, so the sample is inconclusive. A separate 238.574 ms Spinner hold ended before that gap began;
the observer gap cannot explain that held frame. Both remain recorded, without assigning the hold to a function.
This older CI result and the current local comparison do not close whole-Suite acceptance or the remaining resource
and recovery matrix.

## Recovery resource comparison

The next batch completed 52 verifier runs across 176 native Host lifetimes, from 20:04:35 to 20:41:27 UTC on
2026-09-06. Each workload used candidate/baseline/baseline/candidate order: Package `e43cc9e1` against `40101bb2`,
with the same current verifier, exact Pi binary and fresh private configuration. User/network/PID namespaces kept
the fixtures offline. No Host workloads or other profilers overlapped; ambient machine activity and kernel page
caches were uncontrolled. Existing recovery assertions stayed intact.

An external reader collected waited-process CPU, sampled process-tree RSS and I/O; the native Host emitted natural
GC diagnostics. The [GC interpretation](../research/ps-yon-profiling-permissions-20260906.md) defines the accepted
complete-cycle allocation lower bound and excludes ambiguous/interleaved records. These diagnostics add work and
are not ordinary responsiveness samples. Two observations per variant provide descriptive comparisons only.

| Workload | Native Hosts per run | CPU median, seconds: baseline → candidate | Maximum sampled tree RSS median, decimal MB: baseline → candidate | Captured GC allocation lower-bound median, decimal MB: baseline → candidate |
| --- | ---: | ---: | ---: | ---: |
| Work monitor cancellation and five completion/error paths | 1 | 13.705 → 11.887 | 942.0 → 944.1 | 1,304.5 → 620.4 |
| Goal normal, Code Mode, reload, compaction, blocker and retry | 7 | 38.281 → 27.540 | 944.6 → 891.4 | 6,792.5 → 2,013.4 |
| Context projection, persistence, resume and isolation | 8 | 33.826 → 21.298 | 827.9 → 709.7 | 7,609.4 → 2,125.5 |
| Context input and interruption | 2 | 13.133 → 9.825 | 889.9 → 827.3 | 3,075.0 → 1,763.0 |
| Tool historical rendering and resume | 5 | 27.799 → 20.275 | 852.9 → 739.4 | 4,967.1 → 1,534.6 |
| Tool grouping lifecycle, compaction, resume and tree | 5 | 40.776 → 31.775 | 1,121.1 → 992.3 | 5,679.1 → 2,048.5 |
| RTK execution and resume | 2 | 9.156 → 6.113 | 833.2 → 728.4 | 1,912.0 → 544.4 |
| MCP setup, connection, Tool and historical Session | 3 | 14.136 → 9.307 | 846.4 → 820.6 | 3,006.7 → 858.3 |
| BTW execution and retained history | 3 | 10.412 → 5.868 | 823.3 → 703.3 | 2,718.2 → 664.5 |
| Notification lifecycle | 2 | 14.678 → 11.641 | 828.6 → 748.1 | 2,106.2 → 730.1 |
| Ponytail mode and restore | 2 | 9.724 → 6.751 | 828.9 → 754.2 | 1,887.8 → 521.8 |
| Todo dependency completion and cold replay | 2 | 7.976 → 5.112 | 849.0 → 707.5 | 1,817.4 → 450.5 |
| Web search/fetch, continuation and cold replay | 2 | 9.492 → 5.315 | 850.8 → 713.0 | 2,094.8 → 494.5 |

CPU medians fell in all 13 workloads. Work's sampled peak RSS rose slightly. The GC column is not total allocated
bytes: coverage differs by run, and native allocations, uncollected tails, missing cycles and separate child logs
are absent. The reader accepted 17,770 of 18,740 observed GC starts across this batch. Per-Host counts, rejected starts,
pause sums/maxima, source and raw-evidence hashes remain in `recoveryResourceComparison` in the numeric record.
No total-allocation or universal GC improvement is inferred from lower captured values.

RSS is a sum of sequential per-process readings, not an instantaneous peak or a proved lower bound on that peak.
There were 44,373 retained samples and 630 process-read races; maximum scan time was 44.846 ms, including scans with
no surviving resident process. Last and tail-one-second median RSS are also retained, without calling them a
steady-state plateau. CPU sums sequential Host lifetimes; the RSS column takes the largest sampled sum across those
lifetimes, not the sum of their separate peaks. Workers share their Host's process RSS and are counted once.

Waited CPU includes kernel-accounted descendants; the external reader, tmux/Expect and sibling HTTP fixtures remain
outside it. Parent I/O maxima retain waited-child accounting where available, without adding child counters again.
Unavailable or unreaped descendant I/O can be missing. Block operations are not bytes, and context switches are not
wakeups. Output-block medians barely changed for Work and rose slightly for Context input and Notification. The
paired scheduler evidence above remains the wakeup measurement; it was not rerun for these diagnostics.

The two added fixtures exercise real native Tools and canonical Session replay. Todo creates two tasks, persists
their dependency, completes both and restarts the same Session; the replayed task state must equal the final native
Tool result. Web searches, fetches a document longer than 50,000 characters, retrieves an exact 2,000-character slice
and restarts the same Session. The slice must remain identical without refetching, while a localhost fetch is rejected.
Synthetic fetch responses and mount-private hosts/NSS files replace unavailable DNS inside the isolated namespace;
production SSRF checks remain enabled. These fixtures do not certify live search services or external credentials.
The feature-specific verifiers complement the separate full automatic Naming/Usage observations.

Setup failures remain separate. Eight initial Work/Goal runs had no complete resource record because Bun's usage
accessors were incorrectly serialized; explicitly reading those fields repaired the reader. The first grouping run
used a terminal wider than its clipping fixture allows. Its corrected run passed functionally but lost the last
reader record when the namespace exited; the harness now waits for its own final records. Two Web attempts retained
the unavailable system NSS resolver and failed before continuation; private NSS configuration fixed the fixture.
None of these incomplete attempts is included in the 52 comparisons, and no product assertion was weakened.

## Agent tree memory and main-thread interval bounds

Eight further runs, from 20:58:40 to 21:04:28 UTC, used the same two-child foreground-Ledger and background workloads,
Package revisions, 120×40 terminal and candidate/baseline/baseline/candidate order. The existing cgroup reader counted
Host, Workers and descendants; an external process sampled their RSS through shutdown. A private first Extension
recorded 10-ms timer callback starts in memory. Neither probe changed production Source, and neither ran with acceptance
gates. All eight completed and reaped both children, requested and persisted automatic Naming once and refreshed
Usage once; background runs also retained both completion outcomes while the parent continued independently.

| Workload | CPU median, seconds: baseline → candidate | Maximum sampled tree RSS median, decimal MB: baseline → candidate | Final live RSS median, decimal MB: baseline → candidate | Captured parent/Worker GC allocation lower-bound median, decimal MB: baseline → candidate |
| --- | ---: | ---: | ---: | ---: |
| Cold Ledger, two Code Mode foreground Agents | 35.358 → 29.859 | 1,631.9 → 1,621.4 | 667.1 → 718.0 | 4,070.3 → 3,055.5 |
| Two background Agents | 33.934 → 24.522 | 2,519.0 → 2,148.1 | 639.0 → 588.4 | 3,542.6 → 2,593.3 |

Foreground isolation still retains more final RSS. Its accepted GC pause-sum medians were 4,127.030 → 4,132.704 ms,
and captured cycle counts increased; a lower captured allocation value does not mean less collection activity.
Parent returned-read medians also rose from 270.1 to 299.6 MB. These counters include waited-child I/O and diagnostic
logging, not a claim about exact source-file reads. Background returned-read medians fell from 286.7 to 257.5 MB.
Child GC logs are not complete here, even though their CPU and sampled RSS remain inside the measured tree.

| Workload | Largest extension-loading callback interval, ms: baseline → candidate | Largest active-Agent callback interval, ms: baseline → candidate | Largest settlement callback interval, ms: baseline → candidate |
| --- | ---: | ---: | ---: |
| Cold Ledger foreground | 5,710.463 → 3,220.157 | 582.492 → 42.545 | 17.573 → 24.812 |
| Background | 5,874.372 → 3,641.249 | 542.673 → 41.691 | 24.183 → 31.689 |

A callback interval bounds the elapsed duration of any non-yielding main-thread task wholly inside it. It also
includes idle time, GC, scheduler wait and probe overhead; it is not an exact JavaScript-task duration. Coverage begins
at probe evaluation and ends at its shutdown callback. Earlier Host startup and later teardown are outside it, and
phase labels can straddle lifecycle events. Startup loading is reported separately instead of disappearing from the
active-Agent maximum. `agentResourceComparison` retains individual maxima, exact interval locations, sampling gaps,
process counts, GC coverage and evidence hashes.

The RSS sampler's largest scan was 44.237 ms and its largest start-to-start gap was 58.189 ms. Those gaps limit memory
resolution; they are not gaps in the separate terminal observer, whose maximum gap stayed below 28.473 ms with no
missing active Spinner. Candidate Spinner/input/selection maxima were respectively 132.582/36.740/25.733 ms across
these diagnostics. They do not replace uninstrumented frozen-gate acceptance or explain every historical hold.

## Completed ordinary CI at the retained code revision

[Run 34056256262](https://github.com/jczhang02/pi-stuff/actions/runs/34056256262) passed Fast and disconnected Acceptance
at exact commit `e43cc9e11d509d1c068c42f63faf52919f53263d`. The latter completed `test:ci`, the Tool Activity benchmark
and packed fixed-Pi verification. The optional scheduler probe was not requested; its earlier 28-run evidence remains
valid for the source it measured. The prior failed CI and held-frame records are unchanged. This success establishes
that revision's CI outcome, not retrospective attribution or completed whole-Suite acceptance.

## Current-source recheck and historical failures

Six uninstrumented Agent runs on `e43cc9e1` passed every frozen single-event gate from 21:20:05 to 21:24:36 UTC.
They used the original 60-second budget, exact Pi binary, private fresh configuration/caches, isolated namespaces and
120×40 terminal. The order was direct foreground, cold-Ledger Code Mode foreground, background, then the reverse.
There were no warmups, discarded workload samples, overlapping tests or agents, GC logging, CPU profiling or callback
marks. Only the existing external terminal and resource-scope observers ran. Ambient activity and kernel page caches
were uncontrolled.

| Sample | Largest Spinner, ms | Slowest steady input/setup, ms | Slowest selection, ms | Largest observation gap, ms |
| --- | ---: | ---: | ---: | ---: |
| Direct foreground 1 | 114.337 | 15.510 | 14.063 | 16.900 |
| Cold-Ledger foreground 1 | 124.291 | 14.020 | 15.638 | 16.869 |
| Background 1 | 123.633 | 25.376 | 14.056 | 16.112 |
| Background 2 | 136.609 | 25.441 | 14.020 | 16.096 |
| Cold-Ledger foreground 2 | 123.408 | 25.599 | 25.748 | 16.150 |
| Direct foreground 2 | 113.060 | 14.636 | 25.899 | 15.899 |

The gate file SHA-256 remains `db75fe458f275724b9a030c59395d888c0421d0515c4c6cca01c3e02ad39d677`.
Each run completed two child Tools, reaped both birth-identified children, requested and persisted Naming once and
refreshed Usage once. Both background runs retained two outcomes and independent parent completion. No active Spinner
observation was missing; all scopes were unloaded, inactive and dead after shutdown. The first collector stopped
after a valid native capture because it expected an empty whole-worktree diff and found the known report changes.
It then validated that same capture against the exact documentation-only allowlist and continued the remaining five
runs. The numeric record retains all six observations and the shared report-diff hash; no native sample was replaced.

Historical failures fall into different source periods. The unassigned 270.053 ms `9LkXjG` and 489.594 ms `U4SAr9`
holds occurred before [foreground execution isolation](suite-responsiveness-observer-2026-09-05.md#foreground-agent-execution-isolation-2026-09-06).
The old parent execution path has since moved to the per-run Worker; necessary parent UI and Session commits remain.
Neither trace can retrospectively identify its exact function, and neither is reclassified as Host-only. They remain
failures of the earlier source, alongside the matched boundary comparison and current direct/Code Mode checks.

The post-Worker CI foreground sample `Hpk3n9` at `e51caab5` must be distinguished from those older holds. Its slowest
input/setup was 46.587 ms with a 27.253 ms observation gap. This is a foreground input failure under the local frozen
gate, although that CI scenario only asserted functional completion. It is not the background probe's 46.790 ms CPU
interval. The separate 238.574 ms CI background hold and the 48.868/72.710 ms local input failures also remain intact.
The later background cold-loading change has its own reproduced loading interval and baseline failure, followed by
two uninstrumented passing candidates. The six current runs above cover both foreground paths as well as background
after that shared recovery-publication change; this is changed-source verification, not an unexplained retry of e51.

The finite current-source gate checks are complete. They support the tested execution paths, not a claim that every
historical delay has been causally explained or that rare stalls can never recur. A new attributable failure on current
Source would reopen the owning path. Whole-worktree checks, complete independent reviews and verified public delivery
remain separate from this dated measurement result.
