# Continuous responsiveness observer and cold Ledger reproduction

On 2026-09-05, the repository observer reproduced a 198.672 ms Spinner hold before the first Code Mode/Bash Tool UI.
The same Suite without old Ledger records passed the frozen gates; native Pi with the same synthetic history shape
also passed. This is a reproducible remaining defect, not a completed fix or whole-Suite resource certificate.

Production source was unchanged from `c6b20efb599a953b0b03bc439aa0bee9ab5ea97e`, whose implementation matches
`main` commit `42ceceb8`. That version already folds new Ledger entries incrementally during ordinary branch
progress. The remaining reproduction concerns the first cold projection; it does not show that the warm fix is absent.

## Observations

Every row used the exact [certified Pi 0.85.0 executable](../compatibility.md), a 120×40 fullscreen terminal, fresh
private configuration/cache directories, one measured Tool call, and no profiler or injected block. Suite runs
exercised automatic Session Naming and one real HTTP usage refresh against a synthetic loopback account in an
isolated network namespace. No user Sessions, credentials, settings, or running Pi processes were used.

All native-parent samples (`suite: false` in the numeric evidence) use `PI_OFFLINE=1` and `--offline` with a
deterministic Provider. They exclude automatic Session Naming and usage refresh and cannot certify either path.
Suite parents use `PI_OFFLINE=0` without `--offline`; their Naming/Usage evidence comes from the synthetic requests
recorded for those runs, not from live account access. Ledger preparation is a separate offline process outside
the measured interaction and resource scope, regardless of whether the measured parent loads the Suite.

| Run | History and execution | Longest Spinner frame ms | Slowest input/setup ms | Slowest selection ms | Result |
| --- | --- | ---: | ---: | ---: | --- |
| `gjIpTt` | Suite, 24 historical executions, Code Mode → Bash | 198.672 | 39.360 | 14.410 | Spinner gate failed |
| `3QdOLF` | Suite, no old Ledger, Code Mode → Bash | 113.392 | 14.770 | 13.886 | Frozen gates passed |
| `8wCzGe` | Native Pi, 24 historical executions, Bash | 117.565 | 16.099 | 16.049 | Frozen gates passed |

The seeded Session contains 96 canonical Ledger entries, with a successful 800,000-character result in each of 24
executions and **zero saved snippets**. A preparatory native Pi process writes them through `CodeModeSessionLedger`;
the observed process reopens the resulting Session. The Suite still reads `ledger.snippets()` before execution even
when no snippet was saved. The native control preserves the history shape, while the no-history Suite control preserves
the Code Mode execution path.

In `gjIpTt`, the longest held frame spans +8,500.742 to +8,699.414 ms from observer start. The first
`Bash(sleep 2; printf PSYON_TOOL_RESULT)` frame appears at +8,751.383 ms. The stall therefore precedes Tool UI.
All three rows have continuous active Spinner observations and maximum capture gaps below 26 ms.

The [numeric evidence](suite-responsiveness-observer-2026-09-05.json) also retains excluded attempts. The earlier
two-Tool Suite run `lBK0DC` had a 47.225 ms observation gap and 60.353 ms startup feedback: it is inconclusive, not a
pass or attributed startup defect. Native run `qHKlIG` overlapped the preceding negative-control test and is diagnostic
only. No measurement was discarded merely because its result was unfavorable.

## Frozen gates and observer checks

The [locked gates](suite-responsiveness-gates-2026-09-05.json) were recorded at 2026-09-05 00:51:32 UTC, before
production optimization. Thirty fresh native samples rotated through 64×28, 120×40, and 180×50. The largest native
held frame plus twice the observed capture gap gives 164.767521 ms; native input/selection maxima plus one gap give
38.124123 ms for startup input, 40.465312 ms for later input, and 38.311641 ms for selection.
These are local fixed-Host comparison limits, not a portable guarantee that every shorter delay is imperceptible.

The observer captures every 10 ms plus capture/interaction cost, from launch through post-settlement input and
selection. Input begins when the first native editor is visible, before the fixture's ready notification. Typing and
autocomplete selection share the capture loop; waiting for their feedback never suspends capture. The final held frame
and capture-time uncertainty are included. Startup before Working and time after `agent_end` are not expected Spinner
intervals. Selection means command-autocomplete selection, not mouse text selection.

An empty/invalid trace, active coverage below nine seconds or 600 captures, a gap above 40 ms, or a missing expected
Spinner makes the sample inconclusive. A single frozen-gate breach fails. The script prints the summary and keeps raw
frames, actions, source snapshots, and limits in its private artifact directory even when validation fails.

The native negative controls inject 350 ms separately at startup, before Tool-call emission, and during settlement.
The regression test requires feedback above 100 ms **in the injected phase**; the pre-Tool case also requires a Spinner
hold above 350 ms. These detection floors validate the observer and are not product acceptance limits.
Pure tests protect the final held-frame interval and invalid/missing-observation accounting.

## Run the checks

Use the prepared executable from the compatibility contract:

```bash
bun test test/pty-observation.test.ts test/responsiveness-pty.test.ts
bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

To reproduce the remaining cold Ledger failure, set `PI_STUFF_CODE_MODE_HOST` to the prepared Code Mode helper and run:

```bash
export PSYON_PARENT_NETNS="$(readlink /proc/self/ns/net)"
unshare --user --map-root-user --net \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --code-mode --ledger \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

Remove `--ledger` for the Suite control. Remove `--suite --code-mode` for native Pi with synthetic Ledger history.
Each invocation creates its own Session; no existing Session path is accepted. Add `--snippet` to seed one saved
snippet or `--repeat-tool` to compare the first and subsequent Tool in the same process. `--columns` and `--rows`
select geometry. The helper's copied executable hash is recorded; this does not freshly certify its release archive.

`--block-ms 350 --block-phase startup|pre-tool|settlement` is an explicit negative control. `--cpu-profile` is a separate
diagnostic mode and cannot be combined with `--gates`. No profiler was active in the table above.

## Remaining scope

This checkpoint retains the reproducer and gates. It does not implement the cold Ledger fix. Observer CPU is reported
separately and must not be presented as Pi or Suite CPU. Complete process-tree CPU/RSS, allocation/GC, I/O, wakeups,
and largest main-thread-task accounting remain open. The [16-Capability source inventory](suite-resource-inventory-2026-09-05.md)
now records owners and measurement targets; full Context and recovery workloads remain open. The foreground and
background Agent scenarios below cover successful execution, not every Agent lifecycle or its complete resource cost.
Default-loaded Capabilities are not evidence that those paths executed.
The shared machine was not CPU-isolated; full responsiveness closure also needs longer repeated workloads.
Beads `ps-yon.3`, `ps-yon.4`, and `ps-yon.5` retain that work under
[ADR 0034](../adr/0034-remove-redundant-suite-work-without-feature-cuts.md).

## Foreground Agent extension

The observer now accepts `--suite --agent foreground`. It creates one private named Agent definition, invokes the
public `subagent` Tool with fresh context, and keeps capturing the parent TUI while a real child Pi executes Bash.
The child must return the expected Tool result and final marker. Each child Provider request is bound to its PID;
the observer requires the expected request sequence and verifies process exit against its recorded birth identity.
Parent automatic Naming and usage refresh remain enabled and must each execute once. `--code-mode` sends both parent
and child Tools through Code Mode; `--repeat-tool` launches a second child sequentially. The scenario timeout is
60 seconds to include child startup, without changing any feedback or Spinner gate.

On 2026-09-05, the first no-Code-Mode/no-history foreground sample held a Spinner frame for 888.131 ms before the
Agent row appeared; input feedback took 779.337 ms. Its lifecycle test passed because the observer captured the complete
run, not because responsiveness passed. A separate frozen-gate invocation failed again with a 188.750 ms frame and
40.660 ms startup input. Both children completed and exited, with no missing active Spinner samples or capture gaps
above 23 ms. The [Agent numeric evidence](suite-responsiveness-agents-2026-09-05.json) retains both failures.

| Run | Workload | Longest Spinner frame ms | Slowest input/setup ms | Disposition |
| --- | --- | ---: | ---: | --- |
| `zmHdBv` | Suite foreground Agent → child Bash | 888.131 | 779.337 | Observer test; retrospective gate breaches |
| `KHWw6O` | Same foreground workload, fresh process | 188.750 | 40.660 | Frozen gates failed |
| `ewiJgE` | Code Mode → foreground Agent → child Code Mode/Bash, old Ledger | 194.857 | 97.208 | Frozen gates failed |
| `JN8MPG` | Suite Bash, no Agent or old Ledger | 111.590 | 15.067 | Frozen gates passed |

These runs narrow the investigation but do not establish the new stall's root cause or certify every Agent lifecycle.
The ordinary Bash control lacks child-process load, so it does not alone distinguish parent launch overhead from
resource contention. Diagnostic run `hQfUTb` completed two sequential foreground Agents with CPU profiling; it is not
a responsiveness acceptance sample. Parent and child profiles are separate. The parent samples include tokenizer
initialization during startup, which is not evidence that tokenizer initialization caused the pre-Agent-UI stall.
The observer also retains its time origin and first Agent-row timing for later diagnostic correlation.

Reproduce the foreground case in the same isolated network setup used above:

```bash
unshare --user --map-root-user --net \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --agent foreground \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

## Background Agent extension

Use `--agent background` in the same command to observe the parent after it settles while a child continues working.
Capture ends only after the visible completion rows, automatic Naming/Usage, and another input and selection complete.
The observer requires input and selection feedback between parent completion and the last child's completion. It reads
the synthetic parent's native Session file after capture to verify one canonical `pi-stuff-agent-outcome` per child,
with unique identities and completed status. Provider request counts reject an unsolicited parent turn during the
observed interval, and birth-bound exit checks cover each child Pi. They do not certify every helper's cleanup.

The background fixture waits six seconds before its final parent/child Provider response instead of four. This keeps
both the parent-active and parent-idle/child-active observation windows long enough for the existing checks; it changes
no production scheduling or responsiveness gate. No active Spinner is required while only the background child runs.

| Run | Background workload | Longest Spinner frame ms | Slowest input/setup ms | Disposition |
| --- | --- | ---: | ---: | --- |
| `eh1S2n` | One Agent → child Bash | 177.973 | 63.629 | Observer test; retrospective gate breaches |
| `H1NZud` | Same workload, fresh process | 183.665 | 17.929 | Spinner gate failed |
| `O2afCg` | Two Agent launches through Code Mode, child Code Mode/Bash, old Ledger | 232.401 | 53.915 | Spinner and input gates failed |

All three runs retained 11.8–13.3 seconds of observation after parent settlement, with complete expected Spinner
coverage and maximum capture gaps below 22 ms. Every child completed its Tool and exited; canonical outcomes numbered
one, one, and two respectively. Parent Naming and Usage each ran once. The two-child case verified that `--repeat-tool`,
`--code-mode`, and `--ledger` compose with background observation at 120×40. Other geometries remain to be measured.
The [Agent numeric evidence](suite-responsiveness-agents-2026-09-05.json) records each source snapshot. These failures
extend the investigation to background delegation; they do not prove it shares the foreground stall's root cause.

## Native resource scope

On Linux with cgroup v2 and a configured `DBUS_SESSION_BUS_ADDRESS`, add `--resource-scope` to either command.
The existing observer starts only the synthetic Pi command in a fresh transient scope. Unlike a service, the scope
keeps the caller's terminal and network namespace. The launcher receives the user bus environment; Pi and its children
retain the original isolated environment. The observer, tmux, and loopback Usage server remain outside the scope.

After capture and child completion checks, the observer verifies the parent PID belongs to that scope, then reads
`cpu.stat`, `memory.current`, and `memory.peak` before shutting the Host down. The summary's `resourceScope` records
user/system/total CPU in microseconds, current and peak **charged memory** in bytes, and the read interval on the
observer's clock. Cumulative CPU includes already-exited scoped children. These are scope counters, not parent-only
CPU, process-tree RSS, allocation totals, or shutdown-inclusive measurements. Counter reads are not an atomic snapshot.
Required counters or bus access missing is an error, never a zero-cost result or a silent fallback.

Normal teardown stops the exact owned scope and verifies it is inactive. A 90-second scope lifetime bounds the
synthetic process tree if its observer dies; this does not change any production Agent limit or responsiveness gate.
The scope method was first checked with a short-lived busy child: after it exited, scope CPU had grown by 155,364 µs,
including the child's 154,361 µs, while the inherited terminal and isolated namespace remained intact. The transient
scope was then confirmed unloaded. This validates the accounting seam, not the Suite's resource efficiency.

| Run | Scoped workload | CPU seconds | Current / peak charged MB | Longest Spinner frame ms |
| --- | --- | ---: | ---: | ---: |
| `mw5lh2` | Suite Bash | 7.520007 | 445.739 / 989.221 | 117.332 |
| `VjRlYe` | Native Bash control | 1.848497 | 138.158 / 154.403 | 115.950 |
| `xGbqRM` | Suite background Agent → child Bash | 18.242948 | 434.053 / 1477.685 | 177.025 |

The first two rows ran sequentially with the same Bash command, 120×40 geometry, fresh private directories, isolated
network namespaces, and final observer source. Both passed the frozen responsiveness gates. The difference is total
loaded-Suite cost, including necessary features, not a measurement of removable waste. The background row precedes
that pair and uses an earlier counter-reader snapshot; its child completed and exited but its Spinner gate failed.
MB here is decimal. The [numeric evidence](suite-responsiveness-agents-2026-09-05.json) retains exact counters/source
hashes and initial native integration run `Wq9PYe`. Every scoped run was verified inactive and unloaded after teardown.
These single runs establish working measurement, not a repeated before/after baseline or resource-efficiency closure.

## Active Context through native Provider requests

`--suite --context` now writes one project memory with `ctx_memory`, retrieves it with `ctx_search`, and checks three
real native Responses requests at the receiving loopback server. Each request must contain the compact Magic Context
instructions, the projected history block, and the tagged user input. The third must contain the retrieved evidence
in a Tool result, not merely echo the earlier write arguments. Public Tool-result events independently reject errors;
the observer requires the exact request/completion sequence, one retrieval, automatic Naming and Usage, and continuous
input/selection coverage. `--code-mode` wraps these same two Tools; `--ledger` adds the existing cold-history seed.
The server runs outside Pi and retains synthetic request bodies only in the private evidence directory. Its four-second
response waits provide observation time; no production wait or scheduling change was added.

This exposed two gaps in the earlier fixture. Its custom `streamSimple` never called Pi's final Provider-payload hook,
so it could not certify that boundary. Native serialization then revealed that Context had degraded: the pinned engine
refused to migrate a fresh private database while unrelated Pi processes were visible in the host process namespace.
An upstream buffered diagnostic established the refusal; the temporary diagnostic delay and status import were removed.
No database protection was bypassed and no existing Pi process was stopped. The earlier loaded-Suite samples remain
valid only for their recorded workloads; they do not establish active Context cost.

Use an isolated PID namespace and its own procfs as well as the network namespace. The shell keeps the observer above
PID 1, and `setsid` establishes a local process group, preserving the existing birth-identity watchdog checks. Namespace
exit kills its remaining descendants. Suite regression tests use this launch shape; every observer run also has a private
`TMPDIR`, so temporary caches and engine logs no longer share the machine default directory.

```bash
export PSYON_PARENT_NETNS="$(readlink /proc/self/ns/net)"
unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc \
  setsid sh -c '"$@"; exit $?' psyon-pid-init \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --context \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

On final observer source based on `a065ef14`, sample `9QTHUI` passed every frozen gate at 120×40: Spinner 136.050477 ms,
input/setup 26.604012 ms, selection 15.464966 ms, maximum capture gap 17.825732 ms, and no missing active Spinner.
It retained 1,005 active captures over 12.281 seconds. Sample `VazQZM` added Code Mode and the old Ledger: all Context,
Naming and Usage checks completed, but the Spinner held for 275.024555 ms and failed the unchanged gate. Its capture
gap was 18.455237 ms, so this is a captured stall, not a missing-observation pass.
The next run, `dQOsBi`, kept Code Mode and removed only the old Ledger; it passed with a 116.146204 ms Spinner frame,
26.595219 ms input/setup, 16.145855 ms selection, and 20.577305 ms capture gap. All three requests and the retrieval
completed in each run. This extends the cold-Ledger comparison to an active Context workload; it does not fix the stall.

The [numeric evidence](suite-responsiveness-observer-2026-09-05.json) retains these source snapshots and the earlier
functional sample `oxxuCd`, which preceded private `TMPDIR` and final wire-result validation. These cache/isolation
changes prohibit treating a difference from earlier rows as resource savings. No production optimization is in this change.
Full Historian/compaction, interrupt/recovery, configured adjuncts, longer repeated runs and other geometries remain open.
At `a1e4f9ae`, the direct resource-scope probe inside this PID namespace failed to connect to the user bus; the attempted
scope was verified unloaded. The following change resolves that measurement failure without changing Context.

## Scoped active Context

The observer now reaches the existing session bus by removing `XDG_RUNTIME_DIR` only from its `systemd-run` and
`systemctl` commands. With that variable set, systemd selects its private manager socket and rejects the invisible
peer PID in the child PID namespace. Without it, the existing `DBUS_SESSION_BUS_ADDRESS` selects the supported session
bus route. See the pinned [connection selection](https://github.com/systemd/systemd/blob/v261.1/src/shared/bus-util.c#L468-L496)
and [peer-credential check](https://github.com/systemd/systemd/blob/v261.1/src/basic/socket-util.c#L786-L806).
The Pi environment, PID/network isolation, database migration guard, scoped process tree and counter validation are unchanged.

The same `--suite --context --resource-scope --gates ...` command failed with `No data available` before this change
and passed afterward. A host-routing attempt with `--machine=<user>@.host` passed a simple inherited-environment probe
but timed out in the actual fixture (`bkb41L`); that route was removed. The engine's test-data-directory flag was also
rejected because it changes embedding-provider initialization, not just database isolation.

Add `--resource-scope` to the PID-isolated Context command above. The following runs were sequential on the same final
observer source based on `a1e4f9ae`, at 120×40, with fresh private directories and no profiler or injected delay:

| Run | Workload | CPU seconds | Current / peak charged MB | Spinner ms | Input/setup ms | Selection ms | Frozen gates |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `iJapzZ` | Context memory write/search | 17.197857 | 633.942 / 1092.932 | 117.574 | 27.504 | 14.959 | Passed |
| `9Llhi7` | Context through Code Mode, old Ledger | 19.729707 | 671.678 / 1042.964 | 224.959 | 40.879 | 40.681 | Spinner, input, selection failed |
| `oQNzsy` | Context through Code Mode, no old Ledger | 18.615428 | 653.771 / 1040.478 | 120.522 | 15.870 | 15.465 | Passed |
| `IXK028` | Native Bash, no Suite | 2.433290 | 167.727 / 194.744 | 118.313 | 15.229 | 15.335 | Passed |

Each Context run completed three verified native requests, one memory retrieval, one automatic naming request and one
usage refresh. Active coverage exceeded 12 seconds and 970 captures; maximum observation gaps were below 19 ms, with
no missing active Spinner. The native row checks the same resource route with the Suite absent; its one Bash Tool is
not an equivalent Context workload. All four exact scopes were verified inactive and unloaded after teardown.
The [numeric evidence](suite-responsiveness-observer-2026-09-05.json) retains counters, timing and source hashes.

These are pre-optimization measurements. The Code Mode pair changes only the old Ledger seed; a single pair does not
establish how much CPU is redundant. Charged memory is still not RSS or allocation, and shutdown is outside the counter
boundary. The cold Ledger still fails the locked responsiveness gates. Full resource dimensions, repeated workloads
and the remaining Capability/recovery paths stay open in `ps-yon.3`.

## Process RSS and I/O snapshots

`--resource-scope` now also records each live direct cgroup member's `/proc/<pid>/io` and `smaps_rollup` RSS after
the interaction observation ends. [HostResourceScope](../../scripts/host-resource-scope.ts) owns the native launch,
counter reads and teardown. The UI observer no longer owns bus commands or kernel-counter parsing. Its size changed
from 785 to 713 lines; the resource owner has 138 lines. The extra source provides I/O/RSS collection and validation.

Each record is bound to a process birth identity checked before and after its reads. Scope membership must match
before and after the collection, every recorded PID must belong to that scope, and missing or malformed counters
fail the run. `rssSnapshotBytes` sums the recorded RSS values; it is a post-settlement snapshot, not simultaneous
aggregate peak RSS. The read interval remains explicit, and no periodic resource poll was added to the capture loop.

Linux reports process I/O together with waited-for children; the process record also includes its threads. `rchar` and
`wchar` are read/write byte counters, including non-storage I/O, while `syscr` and `syscw` count calls. Storage counters
are `read_bytes`, `write_bytes` and `cancelled_write_bytes`; they are kept separately. See
[proc I/O semantics](https://man7.org/linux/man-pages/man5/proc_pid_io.5.html) and the
[thread-group reader](https://github.com/torvalds/linux/blob/v6.19/fs/proc/base.c#L2855-L2914).
A separate repository-Bun/Linux probe read and wrote 1,048,576 bytes in a child, then waited for it. The parent's
`rchar`, `wchar`, `syscr` and `syscw` deltas each included the child's recorded counters. This checks the OS accounting
rule; the exact Pi samples below exercise the real Host boundary.

| Run | Workload | Live processes | RSS snapshot MB | Sum of rchar / wchar MB | Spinner ms | Input/setup ms | Disposition |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `2FkYA6` | Native Bash | 1 | 154.579 | 0.746 / 0.147 | 117.865 | 16.403 | Resource integration check; no `--gates` |
| `ajuSTf` | Context through Code Mode | 2 | 621.543 | 53.158 / 24.712 | 117.425 | 25.963 | Frozen gates passed |
| `BDfa4J` | Same Context workload, old Ledger | 2 | 665.633 | 72.228 / 24.410 | 356.042 | 97.789 | Spinner and input gates failed |
| `VK9AFF` | Foreground Agent → child Bash | 1 | 634.978 | 162.115 / 26.622 | 865.904 | 586.320 | Spinner and input gates failed |

The rows ran sequentially on the same final source based on `9d892c4b`, with fresh private directories, PID/network
isolation, the fixed Host and 120×40 geometry. The Context pair completed three native projections, one retrieval,
Naming and Usage. It includes the still-running Code Mode helper's separate counters. The Agent completed its child
Tool and verified the child's birth-bound exit; its custom Provider does not certify the native Context payload hook.
All captures were complete, maximum gaps were below 26 ms, and all four scopes were verified unloaded. The
[numeric evidence](suite-responsiveness-observer-2026-09-05.json) retains per-process counters and source hashes.

The public CLI check below failed with missing process records before this change and passes afterward. Keep pipe
failure propagation so a producer failure cannot become a passing consumer assertion:

```bash
set -o pipefail
unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc \
  setsid sh -c '"$@"; exit $?' psyon-pid-init \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --resource-scope |
  bun -e 'import assert from "node:assert/strict";
    const {resourceScope: s} = await Bun.stdin.json();
    assert(Array.isArray(s.processes) && s.processes.length > 0);
    assert(s.processes.every(p => p.rssBytes > 0));
    assert(s.processes.some(p => p.io.rchar > 0 && p.io.wchar > 0));'
```

The table sums recorded process I/O, not an atomic or universally complete process-tree total. Unwaited/reparented
descendants and unenumerated nested cgroups can omit I/O; these records cannot certify those cases. Peak process-tree
RSS, allocation/GC, wakeups and complete per-owner workload attribution remain open. In particular, the fixed
[Bun 1.3.14 V8 compatibility implementation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/node/v8.ts#L54-L79)
has no cumulative `total_allocated_bytes` and supplies placeholders for several V8-shaped fields. It is not a solution
to the allocation gap. No production work was optimized in this checkpoint.

## Goal continuation with automatic Naming and Usage

At 07:38 UTC on 2026-09-05, the existing observer completed `/goal PSYON_MEASURE`: one incomplete Assistant response,
one automatic continuation calling `goal_complete`, and one Goal Final Response. The request sequence was `[0, 0, 1]`
completed Tools. It observed the successful Goal Tool row and verified that the canonical `goal-state` completion
preceded the single persisted final response. Automatic Naming and Usage each executed once. Intermediate Goal turns
do not publish the fixture's final-settlement marker; continuous observation spans the entire continuation.

| Run | CPU seconds | Charged current / peak MB | RSS snapshot MB | Spinner ms | Input/setup ms | Selection ms | Gates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `l2x3bg` | 20.398637 | 669.692 / 934.756 | 651.649 | 125.562 | 17.232 | 19.450 | Passed |
| `XRUCuA` | 19.062306 | 641.815 / 940.691 | 622.404 | 111.639 | 15.768 | 15.630 | Passed |

Both fresh 120×40 runs used the fixed Host, isolated PID/network namespaces and recorded source snapshots based on
`4f9f92f4`, without a profiler or injected delay. The final-source run `XRUCuA` at 07:53 UTC also directly verified one
successful persisted `goal_complete` Tool result between the canonical completed state and the final response. This
assertion was added after `l2x3bg`. Active coverage in `XRUCuA` was 12.206 seconds across 962 captures, with no missing
Spinner; the full-trace maximum observation gap was 25.783 ms. The first successful Goal Tool row appeared 18,763.326 ms
after launch, including startup and two synthetic four-second Provider waits. That elapsed time is not a measure of
redundant Goal work. The resource read took 35.448 ms after capture; both exact scopes were unloaded. Private caches
were fresh, but the shared kernel page cache was not reset. These are repeated baselines, not an optimization delta.

The `goalSamples` numeric evidence retains process counters, request counts and source hashes. This custom Provider
does not certify native Context payload projection or live account access. Goal replay, compaction and recovery costs
are still unmeasured. There is no native Goal control here and no claim that all recorded CPU or memory is redundant.

```bash
export PSYON_PARENT_NETNS="$(readlink /proc/self/ns/net)"
unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc \
  setsid sh -c '"$@"; exit $?' psyon-pid-init \
  bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --goal --resource-scope \
  --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
```

Goal is currently a separate workload, not combinable with Agent, Context, Code Mode or old Ledger. The public CLI
regression failed on the missing `--goal` option before implementation. Fixture development also caught insufficient
completion evidence, an incorrect `objective` field check (the canonical field is `text`), and submission while an
old autocomplete choice was still visible. The observer now waits for that choice to disappear before submitting any
measured prompt; no fixed delay was added. Those failed fixture attempts do not certify Goal performance. Reusing the
existing capture, Provider stream and Session reader adds no new benchmark platform: observer 713→774 lines,
Provider 316→369, and regression file 118→125. Production behavior remains unchanged.

The focused regression group passed eight tests; Context sample `v3bIJA` failed observer validation with a 62.069 ms
capture gap, including a 51.963 ms capture call. It remains inconclusive. The same-source isolated Context rerun passed;
the numeric evidence records both outcomes. These regression runs do not apply product performance gates.
After the persisted Tool-result assertion was added, the final-source Goal regression passed again (one test, four assertions).

## Foreground Agent execution isolation, 2026-09-06

The final direct-Agent sample passed the frozen interaction gates after the shared child engine moved into a
per-run Worker in the existing Pi process. The same-base in-process baseline failed the Spinner gate at 171.120 ms;
the final Worker sample measured 128.513 ms. Code Mode with an old Ledger also passed on final production Source.
These are individual samples on a shared machine, not a statistical guarantee or proof of lower total resource use.

The [Agents contract](../../packages/pi-stuff/src/subagents/README.md) owns this boundary. Pi retains input, rendering
and parent Session commits. The Worker runs the existing foreground/background child engine, preserving its stop
channel, writer identities, committed startup status and completion files. The parent waits for the actual Worker
close event before recovery reaps child writers. No second runtime, persistent worker pool or new dependency was added.

| Sample | Workload and revision | Spinner ms | Input/setup ms | Selection ms | CPU seconds | RSS snapshot MB | Peak charged MB | Frozen gates |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `sXzhdc` | In-process baseline, direct | 171.120 | 15.022 | 14.786 | 26.227454 | 593.441 | 1255.727 | Spinner failed |
| `9h9eie` | Worker candidate, before close join | 115.963 | 15.444 | 14.455 | 25.021220 | 679.383 | 1544.212 | Passed |
| `6udvaY` | Same candidate, Code Mode and old Ledger | 119.283 | 15.319 | 16.115 | 28.699533 | 705.307 | 1517.773 | Passed |
| `1fTkNY` | Final Worker, direct | 128.513 | 25.853 | 14.774 | 26.826419 | 658.158 | 1575.174 | Passed |
| `gjH5mJ` | Final Worker, Code Mode and old Ledger | 126.176 | 15.946 | 15.211 | 29.905843 | 724.828 | 1571.779 | Passed |

MB means 1,000,000 bytes. CPU covers the native resource scope, including threads and children; it is not main-thread
CPU. The final direct sample used 2.28% more CPU than the baseline, retained 64,716,800 more RSS bytes after settlement,
and reached 319,447,040 more peak charged bytes. Execution isolation has a measured memory cost. Charged memory is not
peak RSS; allocation, GC and wakeups were not measured for this change. There is no same-base Code Mode baseline.

Each row completed two real child Bash Tools, reaped both birth-identified child processes and persisted two successful
canonical parent Tool results. Automatic Naming requested and persisted one name; Usage refreshed once. Final direct
and Code Mode samples covered 38.075 and 39.098 active seconds, with 3,149 and 3,191 active captures. Their largest
observation gaps were 16.263 and 16.182 ms, with no missing Spinner. All resource scopes were verified unloaded.

Runs used exact Pi 0.85.0, embedded Bun 1.3.14, fresh private configuration, 120×40 geometry and isolated PID/network
namespaces. No profiler, GC marker or injected stall was active. The shared machine and kernel page cache were not
controlled. The [numeric evidence](suite-responsiveness-agents-2026-09-05.json) retains raw-artifact SHA-256 values,
source patches and observer snapshots by hash, exact metrics and failed candidates under `foregroundWorkerIsolation`.
Both final samples match the final production patch based on signed commit `c9582271`; later test and prose edits do
not change that production patch. Earlier candidates lack the final close join and do not certify its cleanup.

Three failed candidates remain evidence, not acceptance: `SX6bwV` and `iMPKpo` could not resolve `effect/Effect` when
building inside the complete Suite; `0E4M6y` selected a PATH wrapper because Worker argv no longer identified the
compiled Pi. The Host adapter now resolves the Package's Effect subpaths and passes the existing Pi launch metadata.
A regression also exposed that `Worker.terminate()` returns before the thread closes. The final implementation waits
for `close`; its test failed before that join and passed afterward. A separate interruption regression proves release
precedes writer reaping and checks the durable owner-exit marker and failed status.

After the final Code Mode capture, the existing lifecycle verifier passed Ctrl-C and shutdown on the same production
Source: editor return 122.67 ms, shutdown 111.16 ms. It verified that the tracked Agent, shell and grandchild exited and
the canonical Session retained the cancelled Tool-call receipt. It does not require a cancelled Tool result. The
existing exact-Host execution matrix then passed all eight single/parallel, fresh/fork and foreground/background
scenarios. These functional checks do not substitute for the separate interaction and resource measurements above.

```bash
bun scripts/benchmark-responsiveness.ts --pi "$PI_BIN" --suite --agent foreground --repeat-tool \
  --resource-scope --gates docs/reports/suite-responsiveness-gates-2026-09-05.json
# Add --code-mode --ledger for the second final workload; retain the isolation wrapper shown above.
bun scripts/benchmark-lifecycle.ts --variants suite --scenarios fresh --actions agent-exit \
  --sizes 120x40 --samples 1 --warmups 0
bun scripts/verify-agents-execution-matrix.ts
```

This checkpoint addresses the foreground execution boundary. It does not close the Suite-wide resource criteria or
certify Pi 0.85.1. The changed code still requires CI at its delivery revision; no merge or local installation is implied.
