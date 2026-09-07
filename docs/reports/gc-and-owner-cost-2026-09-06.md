# GC observations and retained owner costs

On 2026-09-06, three diagnostic runs at `3789e99e` recorded natural garbage collection alongside the existing external
Spinner/input observer. They did not reproduce the earlier 270/489 ms holds. The largest logged GC pause was 20.157 ms;
that result does not identify the cause of a historical stall or prove its absence. No production code changed.

The [numeric record](gc-and-owner-cost-2026-09-06.json) retains Source and evidence hashes, GC counters, scoped resources
and separate Notification, Codex and Web owner measurements. This extends the
[resource inventory](suite-resource-inventory-2026-09-05.md); the full audit remains open.

## Natural GC in the fixed Host

All runs used the exact Pi 0.85.0 executable, SHA-256
`0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072`, embedded Bun 1.3.14, a 120×40 terminal and two
Tool requests. Runs were sequential, with fresh private configuration and temporary caches. The OS page cache and
ambient machine activity were not controlled. No local test, scout, profiler or other benchmark ran concurrently.

A temporary observer patch passed `JSC_logGC=1` to Pi, redirected its stderr to a separate file and read new bytes after
each external frame capture. This kept GC text out of the TUI. Read-arrival bounds share the observer's clock but do
not give exact GC-start timestamps. The slowest log read took 0.258 ms. No forced collection, heap snapshot or GC-policy
change was used. Logging overhead was not bounded, so these runs are diagnostics, not acceptance samples.

Bun's [1.3.14 build configuration](https://github.com/oven-sh/bun/blob/bun-v1.3.14/scripts/build/deps/webkit.ts) pins
WebKit `5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b`. Its
[Heap implementation](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/heap/Heap.cpp)
logs actual pauses as `p=` and the complete collection interval as `cycle`; those durations are different. The
[scheduler](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/heap/StochasticSpaceTimeMutatorScheduler.cpp)
uses `tp=` for a target pause, which the parser excludes. Its `ca=` value reads heap-accounted allocation at collection
start, divided by 1,024. It is not live heap size.

The table counts only the log prefix read before the last external capture, excluding shutdown's trailing bytes.
Pause sums can overlap across VMs; they are not CPU time or exclusive main-thread blocking. Parent stderr contained
one heap in the native run and two in each Suite run. It does not attribute those heaps to individual Capabilities or
include separately captured Agent-child stderr.

| Sample, in execution order | Workload | Logged cycles | Largest pause, ms | Sum of logged pauses, ms | Largest Spinner frame, ms |
| --- | --- | ---: | ---: | ---: | ---: |
| `aXfEfm`, 10:20:24.114 UTC | Suite, two foreground Agents | 1,494 | 20.157 | 4,140.769 | 148.428 |
| `Ea8bDB`, 10:22:10.606 UTC | Native, two Bash Tools | 447 | 7.342 | 837.914 | 117.622 |
| `lhPzrE`, 10:23:09.401 UTC | Suite, two Bash Tools | 638 | 20.031 | 1,681.854 | 112.480 |

Active observation lasted 37.649, 16.023 and 16.395 seconds respectively. Every sample had zero active Spinner absence,
and every capture gap was below 18 ms. Both Suite runs requested and persisted Naming once and refreshed Usage once;
the Agent run completed and reaped both children. All three resource scopes were unloaded afterward. The temporary
observer patch was removed, restoring its exact pre-probe SHA-256.

The Bash pair shows that frequent small collections also occur without the Suite. It does not make the Suite's extra
work free: scoped CPU was 3.013 seconds native versus 14.634 seconds with the Suite, and sampled RSS was 145,158,144
versus 591,310,848 bytes. The Suite run also executes automatic features absent from the native run. These single,
instrumented samples cannot classify that entire difference as waste or establish a stable CPU/memory delta.

The `ca=` observations provide a useful next boundary. Before the first visible Spinner, their sum was 78,599 KiB
native, versus 2,202,750 KiB for Suite Bash and 2,194,613 KiB for Suite Agents. That interval includes cold loading,
Session initialization and first-prompt preparation; it does not isolate imports. Totals during the Agent-run interval
were 107,271, 153,008 and 646,189 KiB respectively, classified by log arrival. Concurrent-cycle allocation, uncollected
tail allocation, native allocations and child heaps remain outside these sums. They are not complete allocation totals
or retained-memory measurements. The follow-up below separates the main startup boundaries.

## Cold-start boundaries

Three further full-Suite Bash diagnostics at `9a5c9730` reused the lifecycle observer's in-memory marks. A temporary
prelude was verified to run before the Suite import, and a postlude bracketed the ordinary Host event handlers after
the Suite and fixture Provider. Later runs added marks around the Agents root import and first-request owners, then
inside Context activation. The patches and raw traces are hash-bound in `coldStartAttribution` in the numeric record.
All temporary Source and observer changes were removed afterward; no production optimization was made in this step.

| Sample, in execution order | Source fingerprint, ms | Suite runtime import, ms | Agents installer, ms | Session-start handlers, ms | Before-agent-start handlers, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `3e2h9r`, 10:55:28.879 UTC | 25.338 | 4,131.331 | 960.159 | 57.188 | 1,333.697 |
| `OIq1QG`, 10:59:41.528 UTC | 20.370 | 3,285.994 | 741.724 | 35.576 | 1,184.381 |
| `s4V3Du`, 11:01:29.377 UTC | 16.976 | 3,299.364 | 769.196 | 50.927 | 1,134.303 |

Times in the first column identify the first external capture. Each run used the same exact Host, fresh private
configuration/caches, two successful Bash Tools and automatic Naming/Usage once. No local checks or scouts ran
alongside the probes. Instrumentation differs across the rows; their variation is not an optimization result.
Elapsed boundaries include scheduling and dependency work, not exclusive main-thread CPU.

The finer marks show where to investigate next. Agents' root import took 739.795 and 767.343 ms; actual root
registration took 1.907 and 1.837 ms. In those same runs, Context activation accounted for 1,168.706 and 1,113.019 ms
of the first-request wait. Prompt contributions took 0.465 and 0.498 ms, Agents discovery 2.724 and 6.404 ms, and
Code Mode project binding 0.171 and 0.178 ms. These results do not justify changing those small request-time paths.

The last run split Context activation further. Startup preparation deferred first-use configuration in 5.117 ms;
direct-input preparation then took 5.270 ms. The module facade loaded in 0.084 ms, while installation took
1,096.278 ms: 1.793 ms before bundle construction, 140.632 ms building it, and 953.853 ms between completed bundle
and installed module. The latter still combines Worker creation, module evaluation, initialization and Host-side
registration. Replaying Session start took 9.104 ms. Keep the direct-input authority and transactional registration
order; these measurements establish cost, not redundant work or permission to skip initialization.

GC log-arrival bounds also separate the large pre-Spinner interval. Read arrivals wholly within the Suite runtime
import contained `ca=` sums of 1,478,808, 1,439,905 and 1,487,884 KiB; arrivals within the Agents installer contained
377,057, 380,620 and 382,122 KiB. First-request-handler arrivals contained about 40,800–41,000 KiB. Values whose
read intervals crossed a boundary were kept separate. Allocation can precede collection and log arrival, so these
are arrival buckets, not per-module allocated bytes. They focus the next probe on module loading without attributing
all allocation to a named owner. Full allocation and Worker-specific CPU remain unmeasured.

The [Suite loader](../../packages/pi-stuff/src/suite-loader.ts) fingerprints entry paths and filesystem metadata,
including symlink targets; it does not read Source file bodies. Read-only enumeration after probe removal found
648 entries, 61 directories including the root and no symlinks. With this tree, the implementation makes 648 `lstat`
and 61 `readdir` calls per fingerprint, plus per-directory sorting. These are source-derived operation counts,
not intercepted syscall totals. Matching fingerprints reuse the module graph; every Capability installer still
runs fresh. Retain drift detection. The 16.976–25.338 ms measurements cover initial loading, not unchanged reload I/O.

All three samples observed more than 16.38 seconds of active work with at least 1,357 captures, zero active Spinner
absence and capture gaps below 19 ms. Spinner maxima were 116.553, 112.574 and 113.913 ms; largest logged GC pauses
were 18.631, 16.179 and 18.061 ms. Logging and mark overhead remain unbounded, so these are not frozen-gate acceptance
samples. The three resource scopes were verified unloaded. No Agent child, cold Ledger restore or live service was
exercised; the historical late holds remain unexplained.

## Retained owner behavior

A separate temporary Extension loaded production owner functions into the same exact Pi VM and asserted Bun 1.3.14.
It ran in a user/network/PID namespace with synthetic Host, clock and service callbacks. This is owner-seam evidence,
not full-Suite or live-Service acceptance. The first attempt used `PI_OFFLINE=1` and correctly hit Codex's offline guard;
the successful run used `PI_OFFLINE=0` inside the disconnected namespace and completed without Extension errors.

Notification's actual runtime was driven through 1, 100 and 1,000 qualifying settlements. Each settlement scheduled
and fired one grace timer and delivered one alert. An additional pending cycle was disposed in each case: it canceled
one timer and left none pending. Direct terminal input canceled delivery, automatic restart retained 35 ms of work
duration, and automatic-only or duplicate idle events scheduled nothing. Retain the grace timer; no recurring poll or
duplicate scheduling was found in these cases. The controlled clock does not measure OS wakeups or terminal output.

Web's installed factory registered the actual fetch/retrieval Tools and Session lifecycle hooks. Synthetic fetch
results contained 512 content characters each. The driver called those registered Tools, not a duplicate publication
implementation:

| Fetch publications | Canonical payload bytes counted by the fixture | Entries visited during expired restore | Retained after expired restore / shutdown |
| ---: | ---: | ---: | ---: |
| 100 | 66,890 | 100 | 0 / 0 |
| 1,000 | 670,890 | 1,000 | 0 / 0 |
| 10,000 | 6,728,890 | 10,000 | 0 / 0 |

At publication, the in-memory Map and synthetic `appendEntry` received the same `StoredSearchData` object. This rules
out another payload clone at that owner seam, not copies elsewhere or Pi's persistence cost. Registered retrieval
succeeded, a one-entry branch switch replaced the prior index, and shutdown released all indexed results. Live lookup
still returned an old result after the one-hour threshold; TTL applies on restoration, not live lookup. Pruning live
results would change that behavior. Retain publication, lookup and branch validation; these observations do not justify
a TTL change or establish a whole-Session heap bound. Search, DNS, extraction, remote HTTP and native Session writes
were outside this fixture.

The direct Codex usage function made one supplied fetch call and read its 71-byte response body once, producing the
expected weekly usage. It did not exercise the Extension's concurrent-refresh coalescer. The full Suite GC workloads
above separately verified one automatic HTTP refresh each, but do not settle concurrent-request costs.

The combined Notification/direct-usage fixture took 6.979 ms elapsed and 12,864 µs process CPU; the Web fixture took
90.754 ms and 248,129 µs. These single intervals include fixture construction, assertions and payload-byte accounting,
with imports completed beforehand. CPU includes all process threads. Their `getrusage` counters are retained in the
numeric record; context switches are not exact wakeups, and `maxRSS` is a lifetime process high-water mark. No per-owner
memory saving or before/after optimization claim follows from these timings.

Whole-process allocation, exact wakeups, module-evaluation detail, remaining owner/recovery workloads and the historical
late holds remain open under `ps-yon.3` and `ps-yon.6`.
