# Suite resource source inventory

This 2026-09-05 inventory covers the 16 Capabilities in [suite.json](../../packages/pi-stuff/suite.json) and shared
loading/status/registration paths at `07d2f473`. It records investigation targets, not permission to remove features.
The [continuous observer](suite-responsiveness-observer-2026-09-05.md) and the samples below record workload
costs; the dated sections below distinguish measured operations from remaining source-level targets.
The [matched Package comparison](suite-comparable-resources-2026-09-06.md) adds 32 full-workload observations against
the comparable pre-optimization tree, including a retained candidate input failure and foreground RSS increases.
Repeated source operations are not automatically redundant: discovery, validation, recovery and visible refresh may
require them. Beads `ps-yon.3` owns the missing measurements under [ADR 0034](../adr/0034-remove-redundant-suite-work-without-feature-cuts.md).

The [2026-09-06 Agents follow-up](agents-loading-and-projector-cost-2026-09-06.md) records first-use loading changes,
measured projector-lock I/O removal, three passing final native samples, and retained unresolved late holds.
The [Naming and Goal follow-up](history-selection-cost-2026-09-06.md) measures early-exit history selection on the
same exact Host, with unchanged outputs and a passing normal Goal continuation sample. It does not measure Host
branch construction, Goal accounting or the remaining allocation/GC and recovery costs.
The [paired lifecycle comparison](suite-lifecycle-comparison-2026-09-06.md) adds 48 fixed-Host runs across fresh/long
Sessions, prompting, unchanged reload and idle shutdown. The six CPU medians fell 21.4–33.6% from the original Package;
that baseline predates intervening compatibility and Work Continuity changes, so the totals do not isolate `ps-yon`
savings. Offline feature exclusions and non-process-tree memory accounting remain explicit.
The [GC and owner-cost follow-up](gc-and-owner-cost-2026-09-06.md) adds natural-GC observations on native/Suite
workloads and measured Notification/Web retention behavior. Lifecycle marks separate cold module loading from
registration and first-request Context activation; total allocation, exact wakeups and the remaining owner/recovery
audit are still incomplete.

## Owners, triggers and scaling

`B` means Session branch entries, `T` means Tools or tasks in the indicated owner, and `P` means payload bytes.
The retention column describes observed safeguards; it does not certify a complete memory bound.

| Capability / source owner | Trigger and work to measure | Scaling; existing reuse or release |
| --- | --- | --- |
| Conversation UI — [SessionStatusSource](../../packages/pi-stuff/src/conversation-ui/statusline-session.ts) | Statusline repaint reads Session/leaf; a changed leaf walks ancestry to a cached entry. | Same leaf returns cached state; new tail costs its entry count. Session change resets the ancestry cache. Measure long-Session retention. |
| Session Naming — [controller](../../packages/pi-stuff/src/session-naming/controller.ts) | Settlement/manual naming gets the branch and selects messages; initial naming can scan the full branch. | O(B); later selection uses six messages. Prompt text is capped per message and model attempts have timeouts. Automatic naming remains enabled. |
| Tool Display — [ToolGroupProjection](../../packages/pi-stuff/src/tool-display/group-projection.ts) | Structural Tool/transcript changes rebuild envelope/group indexes; member-only updates also have an incremental path. | Bounded transcript projection; measure rebuild frequency and copied payload, not only final row count. |
| Tool Display — [activity clock](../../packages/pi-stuff/src/tool-display/activity-clock.ts) | Active timers update markers and reconcile leaders every 600 ms. | O(active timers), explicit 768-state bound; stops with no timers. Animation is functional cost, not a removal candidate. |
| RTK — [RtkRuntime](../../packages/pi-stuff/src/rtk/runtime.ts) | Every eligible rewrite calls `assertStable`, resolving/statting and hashing the executable after certificate lookup. | O(executable bytes) per command. Certificate reuse does not remove this read. Drift detection must survive any optimization. |
| Codex — [automatic usage](../../packages/pi-stuff/src/codex/index.ts), [HTTP reader](../../packages/pi-stuff/src/codex/usage.ts) | Settled direct-user work refreshes account usage; response text is read and parsed. | O(P); concurrent refreshes coalesce. Network behavior remains functional cost; measure any duplicate work separately. |
| Goal — [accounting](../../packages/pi-stuff/src/goal/src/accounting.ts) | Usage updates obtain and scan the full branch across settlement, command, menu and compaction paths. | O(B) per update; no incremental usage cache observed. Correct token accounting remains required. |
| Goal — [persistence](../../packages/pi-stuff/src/goal/src/persistence.ts) | Session start/reload selects the latest canonical or legacy Goal entry and normalizes it. | O(B + queue); bounded Goal queue. Replay is necessary; measure repetition separately. |
| Context Management — [projection](../../packages/pi-stuff/src/context-management/projection.ts) | Context/provider activation projects messages; concurrent requests for the same key share work. | O(message payload); provider cache matches model and ordered message identities. Invalidation clears projections/flights; measure retained maps and cold rebuilds. |
| Context Management — [worker snapshots](../../packages/pi-stuff/src/context-management/magic-worker-host.ts) | Activation and event dispatch serialize Host context and Tool metadata for the worker. | O(P + Tool schemas); execution-end result/details are omitted and Tool-call arguments are filtered. Measure repeated schema transfer. |
| Ponytail — [instructions](../../packages/pi-stuff/src/ponytail/instructions.ts), [state](../../packages/pi-stuff/src/ponytail/state.ts) | First Skill use reads the canonical body; Session start restores mode and settings; prompt generation filters the Skill catalog. | Canonical body cached once, owners use a WeakMap. Inspect the Session-identity notification Set's lifetime; retained identities are not yet a demonstrated leak. |
| Web — [storage](../../packages/pi-stuff/src/web/runtime/storage.ts) | Search/fetch persists results; Session start/tree restores stored references from the branch. | O(B + P); one-hour TTL and shutdown clear. TTL alone does not establish peak retained bytes. |
| Web — [implementation](../../packages/pi-stuff/src/web/runtime/implementation.ts) | Each search/fetch snapshots settings and publishes its result; retrieval slices stored content. | O(query/result size); settings snapshots may support live configuration. Measure normalization and publication separately. |
| MCP — [metadata cache](../../packages/pi-stuff/src/mcp/runtime/metadata-cache.ts), [initialization](../../packages/pi-stuff/src/mcp/runtime/init.ts) | Startup reconstructs cached metadata; metadata settlement serializes and writes Tools/resources. | O(metadata bytes); cache version, configuration hash and seven-day age invalidate stale data. Connection/disconnect execution still needs separate measurement. |
| Background Work — [runtime](../../packages/pi-stuff/src/background-work/src/runtime.ts), [storage](../../packages/pi-stuff/src/background-work/src/storage.ts) | Active-task heartbeat persists recovery metadata; recovery enumerates owned directories and verifies process identities. | O(active tasks/owned directories); production heartbeat is five seconds and stops when inactive/disposed. Atomic writes and ownership checks are required. |
| Background Work — [Tasks dialog](../../packages/pi-stuff/src/background-work/src/tasks-dialog.ts) | Open dialog receives changes and refreshes each second. | O(tasks); timer is canceled on disposal. This dialog is not a permanent 250 ms poll. |
| Agents — [discovery](../../packages/pi-stuff/src/subagents/src/agents/agents.ts) | Startup/refresh and launch discover definitions using awaited directory operations and file reads. | O(files + Markdown bytes); repeated discovery has no cache here. Async I/O may cost resources without synchronously blocking the UI. |
| Agents — [public execution](../../packages/pi-stuff/src/subagents/src/extension/public-agent-execution.ts), [result watcher](../../packages/pi-stuff/src/subagents/src/runs/background/result-watcher.ts) | First execution imports the foreground executor; background results use filesystem events plus a three-second safety scan. | Import Promise reused; result work deduplicated and watcher state cleared on stop. Measure launch, settlement and recovery independently. |
| Todo — [replay](../../packages/pi-stuff/src/todo/state/replay.ts), [store](../../packages/pi-stuff/src/todo/state/store.ts) | Startup/tree/compaction replay scans branch candidates and validates snapshots/dependencies; mutations replace Session-owned state. | O(B + tasks); no replay cache observed. Session shutdown evicts its store. Validation is functional cost. |
| Todo — [overlay](../../packages/pi-stuff/src/todo/todo-overlay.ts) | Changes and rendering filter/count task arrays and retain recent completions. | O(tasks); timed completion retention and disposal cleanup. Repeated scans need timing evidence before consolidation. |
| BTW — [context](../../packages/pi-stuff/src/btw/btw.ts), [history](../../packages/pi-stuff/src/btw/btw-history.ts) | Invocation converts the effective branch; overflow retry refits it. Hydration scans entries; exchanges copy/filter and bound retained history. | O(B + P); context fitting budget and 1,000-exchange/8 MiB history bound. Session shutdown releases history. |
| Notification — [runtime](../../packages/pi-stuff/src/notification/runtime.ts) | Qualifying settled work starts one cancellable grace timer; state changes cancel it. | No recurring poll found; delivery reads in-memory settings and emits terminal output. No redundant hotspot established. |
| Code Mode — [Ledger](../../packages/pi-stuff/src/code-mode/ledger.ts), [normalization](../../packages/pi-stuff/src/code-mode/ledger-state.ts) | First lookup normalizes canonical records and restores values; ordinary branch progress folds only new entries. | Cold O(Ledger bytes), warm O(new tail). Direct event-kind dispatch removes repeated schema cleaning; the dated comparison below measures cold-read savings. One TypeBox clone preserves unsafe-key filtering. Residual stalls and complete resource acceptance remain open. |
| Code Mode — [host client](../../packages/pi-stuff/src/code-mode/host/host-client.ts) | Execution builds a Tool map and sends definitions to the shared helper. | O(Tool schemas); one shared startup Deferred. Measure repeated definitions separately from helper execution. |

## Shared paths

| Owner | Trigger and work | Existing safeguard / measurement gap |
| --- | --- | --- |
| [Suite loader](../../packages/pi-stuff/src/suite-loader.ts) | Load/reload fingerprints entry paths, metadata and symlink targets before import-cache lookup; no Source-body reads. | Cost grows with entries/path metadata plus directory sorting. Matching fingerprints reuse the module graph; installers run fresh and failed promises are removed. [Initial measurements](gc-and-owner-cost-2026-09-06.md#cold-start-boundaries) cover 648 entries in 16.976–25.338 ms; unchanged reload I/O remains unmeasured. |
| [Shared status channel](../../packages/pi-stuff/src/conversation-ui/statusline-channels.ts) | Publication normalizes and serializes old/new snapshots before listener fan-out. | Small fixed schemas; equality avoids unchanged notifications. Frequency/cost unmeasured. |
| [Tool registration](../../packages/pi-stuff/src/tool-display/registration.ts) | Final registry coverage validation enumerates Tools; reload handoff restores missing historical definitions. | O(T); early returns and missing-only recovery. Coverage and historical rendering must remain correct. |

## Evidence still required

This completes a source inventory pass, not the complete resource audit. For each owner, run the applicable startup,
idle, long-Session, Tool/Agent, settlement and recovery workload. Record measured cost and disposition; source inspection
alone cannot close a suspected hotspot. Include child processes and Context workers, not only the parent Pi process.

Continuous foreground and background Agent observation now reaches real child Tool results and verifies birth-bound
process exit. Both modes expose gate failures without Code Mode or old Ledger. Background observation also checks
parent-idle input/selection, canonical completion records and two launches through Code Mode. Native Context request
projection and memory write/retrieval now have scoped CPU and charged-memory measurements, including a Code Mode pair
with and without old Ledger. The resource observer also records live direct cgroup members' RSS and I/O, including
still-running Code Mode helpers; waited-child I/O follows the kernel's aggregation rules. These snapshots do not
establish cumulative allocation, peak process-tree RSS or each owner's repeated work. Recovery, complete resource
dimensions and before/after closure remain open; see the [observer report](suite-responsiveness-observer-2026-09-05.md).

Normal Goal continuation now also has two scoped real-Host samples with automatic Naming/Usage, successful Goal Tool UI,
and canonical completion preceding the final response. Both passed the frozen gates. Their whole-process counters do not
isolate Goal accounting cost or certify Goal replay, compaction and recovery; those investigations remain open.

## Existing MCP and RTK verifier measurements

At `02547c8b`, the unchanged [MCP verifier](../../scripts/verify-mcp-pty.ts) and
[RTK verifier](../../scripts/verify-rtk-pty.ts) both passed on the exact certified Pi 0.85.0 executable. An external
Bun 1.4.0 reader inherited the PTY descriptors, waited for each Pi child to exit, then read `child.resourceUsage()`.
Existing verifier, continuous-observer and product Source were unchanged. The
[numeric record](suite-resource-inventory-2026-09-05.json) binds the samples
to executable, verifier, fixture and reader hashes. The first attempt failed before Pi started because GNU `time`
was absent; it produced no resource sample. The installed Bun API supplied the counters instead.

The two commands were `bun scripts/verify-mcp-pty.ts` and `bun scripts/verify-rtk-pty.ts`, with `PI_BIN` pointing to
the external reader around the certified Host and `RTK_BIN` selecting certified RTK 0.45.0. Each verifier ran under
`unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc`; MCP enabled only the new namespace's
loopback interface. Their private configuration and synthetic Sessions did not touch the running user Pi.

| Workload, in execution order | Start, UTC | CPU seconds | Child lifetime seconds | Bun maxRSS, decimal MB |
| --- | --- | ---: | ---: | ---: |
| MCP light setup | 08:26:44.840 | 6.279 | 7.808 | 734.966 |
| MCP dark setup | 08:26:52.707 | 5.011 | 6.521 | 737.624 |
| MCP connection, Tool and historical Session | 08:27:05.025 | 10.384 | 12.831 | 835.863 |
| RTK fresh execution | 08:33:18.935 | 20.309 | 14.027 | 927.912 |
| RTK restart and resume | 08:33:33.042 | 7.201 | 7.204 | 687.849 |

RTK's separate `--version` preflight used 0.498 CPU seconds and did not load the Suite. All six Pi children exited
with status zero. MCP exercised local stdio Tool execution, HTTP discovery and graceful termination, a failed
connection, confirmed configuration changes, and display of a seeded historical Tool result after Session switching.
It also asserted that opening the dialog did not connect either server. The resumed history was seeded, not a
crash-recovery trace. RTK executed three rewritten Bash commands and one 1,600-line ANSI-output command, then started
a new Host on the same Session and verified unchanged raw history and identical bounded model projection.

These are whole-Host workload counters, not MCP/RTK attribution or optimization comparisons. The
[Bun API](https://bun.sh/docs/runtime/child-process#resource-usage) reports CPU microseconds and maxRSS bytes.
Native waited-descendant accounting can include child work; the reader, Expect, `script` and sibling HTTP fixture
server are outside this boundary. maxRSS is not aggregate peak process-tree RSS, filesystem counters are operations
rather than bytes, and context switches are not wakeups. The [Linux accounting contract](https://man7.org/linux/man-pages/man2/getrusage.2.html)
describes these limits. Wall time includes deliberate verifier interaction waits and is not an interface-stall metric.

Both verifiers use offline Providers; RTK additionally disables Naming explicitly and uses preapproved Bash. They
do not certify automatic Naming/Usage, live OAuth, native Context payloads or continuous Vibe Line/input/selection
gates. MCP uses fresh private HOME/XDG/Agent/project/Session directories; its ambient temporary and source caches
were not reset. RTK uses a fresh private HOME/XDG/TMPDIR, but fresh/resume share their fixture state. The kernel page
cache was not reset for either verifier. Different themes and fresh/resume workloads are not paired optimization
samples. Per-owner repetition, scale, crash recovery, allocation/GC and complete resource dimensions remain open.

### RTK executable-read attribution

A separate diagnostic launched at 08:51:10 UTC on `dee4f81b` repeated the unchanged RTK verifier with strace 7.1
following the exact Host and filtering file operations to the certified RTK executable. Fresh and resumed verification
passed. The fresh trace contains five complete reads of the 10,326,432-byte binary: 51,632,160 bytes returned to user
buffers, through ten positive `read` calls and five EOF reads. Five additional `O_PATH` opens inspect identity without
reading content; counting every open as a full read would double the result. The parser joined the one interrupted
read with its resumed return. Trace/source hashes and counts are retained in `rtkIdentityTrace` in the numeric record.

The [runtime owner](../../packages/pi-stuff/src/rtk/runtime.ts) explains the count: `certify()` reads once, and
`assertStable()` reads before each of the four rewrite requests, including the command for which RTK returns no
replacement. There were one version probe, four rewrite executions and three resulting RTK command executions.
Opening the already-ready dialog added no read. The resumed fixture performed no tracked RTK executable read or
execution. This rules out extra certification in this measured sequence, not in every possible concurrent workload.

Retain these identity checks under the current [drift-detection contract](../capabilities/rtk.md#runtime-verification).
The existing runtime and certified-executable tests passed on repository Bun 1.4.0: 14 tests, 60 assertions, including
cached verification, concurrent verification deduplication, path changes and in-place binary changes. The evidence
does not justify weakening the contract to avoid its reads. It also does not establish that the complete RTK
implementation has no removable work.

strace changes scheduling. Its read durations are not hashing CPU time, main-thread blocking or Vibe Line liveness;
returned bytes are not physical storage reads or total allocation. Those dimensions and RTK projection/savings costs
remain open. No production or verifier change was needed for this attribution.

## First cold Ledger reductions

At `fbc9c5dd`, two repeated operations were removed from `ledger-state.ts` after the `40101bb2` baseline. `eventFrom()`
let TypeBox clean the fresh JSON parse without an additional `structuredClone`; that clone added no isolation from
the original Host record. `restoreValue()` returns validated JSON scalars directly because they cannot contain binary or bigint envelopes.
Objects and arrays still pass through the storage codec. External JSON validation, canonicalization, schema checking,
branch invalidation, approval and replay policies are unchanged. The existing public Ledger tests now also cover
cleanup ownership, JSON negative-zero canonicalization and cold recovery of a 1,000,001-character result.

The unchanged observer ran sequentially with `--suite --context --code-mode --ledger --resource-scope` and the
frozen gates. Every run used the certified Pi 0.85.0 binary, 120×40 terminal, 96 canonical Ledger entries with
24 results of 800,000 characters and zero snippets, fresh private configuration and temporary caches, and isolated
network/PID namespaces. Each completed three native Context projections, one memory retrieval, and automatic Naming
and Usage once. No artificial delay or profiler was enabled; the kernel page cache was not reset.

| Candidate, in execution order | Observer start, UTC | Spinner max, ms | Input max, ms | CPU seconds | RSS snapshot, decimal MB |
| --- | --- | ---: | ---: | ---: | ---: |
| Baseline `kwhsxh` | 09:18:46.863 | 215.330 | 88.673 | 14.930017 | 671.064 |
| Clone removal `2HKgJF` | 09:21:49.629 | 192.117 | 64.111 | 15.479745 | 643.138 |
| Also restore non-null scalars directly `hDcxWB` | 09:25:19.480 | 191.045 | 25.992 | 15.040566 | 651.637 |
| Include null, before formatting `dLPNEC` | 09:27:13.690 | 178.254 | 100.154 | 15.060555 | 660.881 |
| Final formatted source `uqLq5D` | 09:30:05.839 | 177.180 | 26.218 | 14.892743 | 680.739 |

All five failed the unchanged 164.768 ms Spinner gate; three also failed the 40.465 ms input gate. Each had over
12 seconds and 1,000 captures of active coverage, no missing active Spinner, and no capture gap above 21 ms.
The numeric record binds each sample to its raw evidence and source diff; it retains selection, startup-input and
charged-memory measurements as well. The final source only reformats the preceding candidate's return expression.

The following same-source control `tOUNIh` removed only `--ledger` and passed: Spinner 114.642 ms, input 26.275 ms,
selection 14.286 ms, gap 16.772 ms and zero active Spinner absence. Context, Code Mode, Naming and Usage remained
active. This isolates the old-Ledger workload, not its exact remaining blocking operation. All six resource scopes
were checked after shutdown and reported not-found/inactive/dead.

This is a partial removal of redundant work, not a cold-path fix or demonstrated total resource saving. CPU and RSS
vary across single samples; the final RSS snapshot and charged-memory peak exceed baseline. Snapshots are not peak
process-tree RSS, charged memory is not allocation, and the existing I/O/GC/wakeup limitations still apply. Remaining
cold work needs attribution and bounded scheduling without weakening validation. `ps-yon.3`, `ps-yon.4` and the
separate Agent stall remain open; complete resource measurements and real-Host gates still block final acceptance.

## Dispatch cold Ledger normalization by event kind

The next candidate selects the schema from the existing `LEDGER_EVENT_SCHEMA` using the record's declared `kind`,
then cleans and checks that member. The `fbc9c5dd` native CPU profile `t0ss9o`, started at 09:45:56 UTC, led back to
`execute → snippets → loadSnapshot → eventFrom → TypeBox Clean/Check`. TypeBox 1.3.10's `FromUnion` clones and
cleans a record for each attempted member before checking it. The discriminator already identifies the required
member, so the other attempts serve no purpose. No new schema registry, cache or asynchronous interface was added.

Removing all TypeBox cloning was not equivalent: its clone also recursively filters `__proto__`, `constructor` and
`prototype` keys. The public Ledger ownership regression failed when the first candidate omitted this filter and
passed after retaining one `Value.Clone` before cleaning. Unknown kinds and invalid known records remain rejected;
JSON canonicalization, Host record isolation and storage decoding remain. TypeBox returns primitive strings directly;
this finding does not imply that every candidate clone copies the large result's string bytes.

A temporary diagnostic in the existing seed Provider measured ten public `snippets(context)` reads per phase inside
the exact native Pi 0.85.0 preparatory Host. Each iteration created a new Ledger, read it cold, read it again with the
same leaf, appended one ordinary non-Ledger entry, then read again. All calls returned zero snippets. Baseline
`OxWe4P` ran first at 10:10:52 UTC; candidate `mAKiLe` followed at 10:12:24 UTC. Both used the same diagnostic Source
and the 96-record, 24×800,000-character seed. All ten samples, including the first, are retained in the numeric record.

| Read window | Baseline duration median / max, ms | Candidate duration median / max, ms | Baseline / candidate CPU median, µs |
| --- | ---: | ---: | ---: |
| Cold Ledger | 112.715 / 146.546 | 16.305 / 31.919 | 199,063 / 45,172.5 |
| Same-leaf cache hit | 0.008418 / 0.025429 | 0.006720 / 0.015312 | 9 / 7 |
| After one ordinary entry | 0.016171 / 0.156661 | 0.012640 / 0.113763 | 16.5 / 13 |

Cold-read CPU summed over ten windows decreased from 2,535,762 to 547,807 µs. `performance.now()` measured elapsed
time; `process.cpuUsage()` measured all threads in that native seed process during each synchronous read, so CPU can
exceed wall time. These are within-process cache states, not ten independent cold Host starts. The sequence was not
randomized and the kernel page cache was not reset. These windows do not measure total Suite CPU, allocated bytes,
exclusive main-thread CPU or UI liveness. Earlier native TypeBox counter probes produced no usable record; no clone
count or allocation saving is inferred from that absence. The probe and its observer log-copy code were removed.

With the original observer and seed restored, three same-source runs passed all frozen Spinner, startup-input,
steady-input and selection gates. They used the previous section's full Context/Code Mode workload and unchanged
geometry, isolation and gates, with no profiler or injected delay. The third ran after diagnostic cleanup.

| Run | Observer start, UTC | Spinner max, ms | Input max, ms | Selection max, ms | CPU seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| `yzKC8H` | 09:58:14.680 | 146.922 | 17.121 | 17.727 | 20.312882 |
| `gMlYCT` | 10:00:09.398 | 150.136 | 16.808 | 17.814 | 18.420312 |
| `gUqIgL` | 10:15:13.689 | 142.529 | 16.763 | 19.199 | 20.594374 |

Each had over 12 seconds and 950 captures of active coverage, zero active Spinner absence and capture gaps below
20 ms. Whole-run CPU does not demonstrate a reduction against the earlier checkpoint; the measured saving is the
cold-read window above. The diagnostic candidate's subsequent UI run still held a Spinner frame for 167.931 ms,
above the unchanged 164.768 ms gate. That run had ten extra ordinary seed entries and no gate assertion, so its zero
command exit is not a gate pass or an equivalent ordinary sample. Its breach is retained and remains unexplained.
The CPU-profile run is also diagnostic only because profiling changes scheduling.

The numeric record binds production, test, dependency and diagnostic Sources to raw evidence hashes. All nine owned
profile/probe/UI scopes were verified not-found/inactive/dead after shutdown. Production `ledger-state.ts` grew from
363 to 367 lines; its public regression file grew from 601 to 615, with no new test framework or production state.
This is a cold-normalization optimization, not completion of `ps-yon.4`. Agent Tool gates, remaining resource dimensions,
recovery workloads and attribution of the residual stall still block final acceptance.

## Resolve imports directly to shipped Source

On 2026-09-05, native-bundle inspection found a repeated loading cost: the Host resolver tries nonexistent relative
`.js` paths and extension candidates before falling back to the actual `.ts` file. Constructing and catching those
resolution errors includes another caught, unsupported Bun V8 snapshot probe. This is unnecessary path lookup,
not evidence that every module is compiled twice. A separate-Extension loading-only probe has a different module
graph from real Agent execution and is not used as the production comparison below.

The candidate changes 1,383 module specifiers across 412 Package files to their existing TypeScript targets. An AST
comparison against `bd095042` verifies that all other production text is unchanged; physical lines stay at 116,365
across those files. Real JavaScript targets remain unchanged. The existing composition generator emits exact Source
paths, and the existing repository import audit rejects missing relative targets, including type imports, re-exports
and dynamic imports. No new runtime state, preload, delay, dependency or Host-loader modification is introduced.

An initial Agents-only experiment changed 208 specifiers. Alternating control/candidate/control/candidate runs
`ByJ2gp`/`KRwpGS`/`7vr5kE`/`8J3ShW` measured Spinner maxima of 210.213/174.840/244.813/174.682 ms.
All failed the frozen Spinner and input gates. The subsequent full-Package comparison used the unchanged observer
with `--suite --agent foreground --resource-scope` and the frozen gates:

| Variant, in execution order | CPU seconds | Charged-memory peak, decimal MB | Editor-ready ms | Spinner max, ms | Steady-input max, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Candidate `bMyejB` | 16.918412 | 1,281.737 | 4,580.923 | 209.014 | 85.629 |
| Control `vHqx4o` | 21.707431 | 1,577.697 | 6,073.108 | 222.030 | 158.163 |
| Candidate `9vUUxp` | 16.888435 | 1,279.054 | 4,640.689 | 211.430 | 86.543 |

Each fresh Host used the same certified Pi 0.85.0 binary, offline Providers, 120×40 terminal, private HOME/XDG/TMPDIR
and isolated network/PID namespaces. Each completed and reaped one real child Tool run and performed automatic Usage,
Naming request and Name persistence once. Active observation exceeded 20 seconds and 1,700 captures, with no Spinner
absence and no capture gap above 23 ms. Tests and other benchmarks did not run concurrently; the kernel page cache was
not reset. All three scopes were verified unloaded after shutdown.

These samples demonstrate lower total scoped CPU and charged-memory peaks in this workload, not a completed liveness
fix: all three still fail the unchanged 164.768 ms Spinner and 40.465 ms steady-input gates. Charged memory is not
allocated bytes or peak process-tree RSS; the final RSS and I/O snapshots do not isolate individual import costs.
Allocation/GC, wakeups, scale, recovery and every-Capability execution remain separate acceptance work. The numeric
record's `explicitSourceImports` section retains all seven samples, raw evidence and Provider hashes, source-diff
identities, exact maxima and measurement limits. `ps-yon.11` owns this optimization; `ps-yon.6` and final acceptance
remain open.

## Command highlighting without rebuilding the matcher

`ps-yon.12` removes repeated catalog preparation from `invocationRanges`. The editor already accepts only command
names matching `[A-Za-z0-9][A-Za-z0-9:._-]{0,127}`. A fixed expression can recognize complete invocation words, then
check the current `Set`; sorting, escaping and joining every name on each rendered line are unnecessary. Registry
reads remain live. No cache, wrapper, cadence change or feature removal is needed. Production Source shrinks from
84 to 77 lines; the existing editor regression file grows from 441 to 456 lines.

The new lookup-count regression fails on `683cdf76` and passes on the candidate. A temporary, source-hashed Bun 1.4.0
diagnostic also compares the complete old and new `styleKnownInvocations` functions: all 16,400 boundary and seeded
random cases produce identical styled output. It transpiles both Sources and redirects their unchanged shared import
to the same file. With 256 commands, 1,000 warmup calls per variant and 15 alternating trials of 1,000 calls, median
elapsed time falls from 16.980 to 3.338 ms; process CPU falls from 20,284 to 4,593 µs. Catalog enumeration per call
falls from one to zero. These are warm helper measurements, not native Host latency or allocation measurements.

Fresh native foreground-Agent runs used the unchanged observer, certified Pi 0.85.0 binary, full Naming/Usage,
120×40 geometry, private directories, network/PID isolation and frozen gates. Only this production helper changed
between variants; tests and other benchmarks did not run concurrently. Times below are on 2026-09-05 UTC.

| Variant | Observer start | Spinner max, ms | Steady-input max, ms | Selection max, ms | CPU seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| Candidate `lJGBaK` | 21:37:24.225 | 257.834 | 98.234 | 13.871 | 17.113473 |
| Control `dnwjry` | 21:38:14.577 | 256.925 | 109.554 | 13.961 | 16.751658 |
| Candidate `p7qDxP` | 21:39:02.186 | 233.101 | 169.959 | 14.324 | 17.647674 |

All three complete and reap one child Tool run, perform Naming and Usage once, and retain over 20 seconds of active
observation with zero Spinner absence and gaps below 17 ms. All scopes are unloaded after shutdown. All three still
fail the 164.768 ms Spinner and 40.465 ms input gates. This sequence does not establish a whole-Host CPU, memory or
latency improvement; the measured saving is the helper work above. The exact native integrated UI and focused editor
checks pass. `commandInvocationMatching` in the numeric record retains the trials, Source and evidence hashes, resource
snapshots and limits. First-Agent import stalls and the remaining whole-Suite acceptance stay open.

## Reuse the committed foreground start

On 2026-09-06, `ps-yon.6` removes duplicate foreground startup work from `e48a6c4f`.
The foreground lifecycle already committed a writer registry and initial status before binding its run directory.
Its in-process runner then initialized the same registry, recreated the status and wrote it again.
The [historical regression at the tested revision](https://github.com/jczhang02/pi-stuff/blob/f5438e8ae009471309465c8cc5efcfbae371ca1a/test/agents/foreground-initialization.test.ts) exercises both real startup stages and queues a
stop before child dispatch. It observes actual atomic publications: the old source writes each initial artifact twice;
the candidate writes each once and still delivers the first running/pending observer notification with zero counters.
The final regression fails on the old production source and passes on the candidate. Seven focused files pass
76 tests and 315 assertions, including startup, cancellation, persistence failure, completion and recovery cases.

The lifecycle now hands its committed status to the runner through an in-process parameter, outside serialized runner
configuration. Initial counts are explicit zeroes, so the runner can notify without another projection or write;
the first notification keeps the committed timestamp. No clone is added: the previous observer already shared the
runner's nested status objects after that first notification, before control installation can mutate them.
Detached and revival starts still initialize their own registry and status. The redundant directory creation inside
the work runner is also removed; initial atomic publication already creates its parent directory.

Four sequential native runs used exact Pi 0.85.0, the complete Suite, 120×40 geometry, two fresh-context foreground
children and unchanged frozen gates. Code Mode used the prepared certified helper. Each run had fresh private
configuration and caches on the ordinary filesystem; the kernel page cache was not reset. No checks, scouts or
profilers overlapped these samples. Observer time origins below are on 2026-09-06 UTC.

| Variant | Invocation | Observer origin, UTC | Spinner max, ms | Input max, ms | Selection max, ms | Scoped CPU, seconds |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Control `TVrDGm` | Direct | 05:45:53.598 | 286.535 | 15.717 | 15.244 | 26.615752 |
| Candidate `BlA6hk` | Direct | 05:47:06.535 | 200.347 | 99.017 | 15.211 | 24.935834 |
| Control `Y8Mu2F` | Code Mode | 05:49:52.263 | 326.343 | 137.966 | 15.835 | 29.310988 |
| Candidate `U5AeSJ` | Code Mode | 05:50:59.813 | 222.701 | 75.123 | 15.242 | 28.378905 |

Every run completed and reaped both children, requested and persisted Naming once, and refreshed Usage once.
Spinner absence was zero, observation gaps stayed below 18 ms, and all four owned scopes were unloaded.
All four runs failed the frozen gates. The direct candidate's input maximum worsened; these pairs do not establish a
stable whole-process CPU, memory or latency saving. The removed publications are proven by the regression, not inferred
from these noisy totals. First-module loading and the previously recorded late Spinner hold remain unresolved.

Production Source grows by 24 physical lines and the focused test adds 93, a net increase of 117; every affected file
stays below 500 lines. Both control captures include the unexecuted new test, while both candidate captures include
all five production diffs and that test's complete body. No runtime probes were added. The numeric record's
`foregroundStartupHandoff` retains Source counts/hashes, full maxima and I/O, RSS and charged-memory counters. It does
not establish allocation/GC, whole-process wakeups or peak process-tree RSS. Full-Suite resource and responsiveness
acceptance remains open.

## Do not load Skill discovery for Skill-free launches

On 2026-09-06, `ps-yon.17` removes unused filesystem Skill Module loading from Agent launches. At `69807e53`,
an empty selection already skipped discovery, but static imports still loaded the resolver in the parent and both
child Hosts. The shared [task projection](../../packages/pi-stuff/src/subagents/src/runs/background/resolved-task.ts)
now imports that resolver only for a nonempty selection. Input normalization remains pure and shared by its three
callers. Selected Skills are resolved at preflight and again at final construction; reusing the earlier selection
would miss intervening file changes. Missing-Skill errors still precede fork creation. Ambient inherited Skills keep
Read access. Foreground cancellation is checked after the async build and before claiming its run directory;
background construction failure cleans up its already-claimed directory.

The new loading regression fails on the old source because a Skill-free launch loads filesystem discovery. It passes
on the candidate and confirms that a requested reserved Skill still reaches the real resolver and returns the same
missing-Skill error. Resolver/loading/recovery tests pass 16 tests and 74 assertions; foreground
launch/admission/context/recovery/resume and background-startup tests pass 72 tests and 289 assertions. These are
repository Bun checks, not native public-seam certification.

Five sequential runs used the existing foreground observer with `--repeat-tool`, exact Pi 0.85.0, 120×40 geometry,
two fresh-context children, automatic Naming/Usage and unchanged frozen gates. Private configuration and temporary
caches were fresh on the ordinary filesystem; the kernel page cache was not reset. No tests, scouts or profilers
overlapped these runs. All starts below are on 2026-09-06 UTC.

| Variant | Start, UTC | Spinner max, ms | Input max, ms | Selection max, ms | Scoped CPU, seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| Control `UX39W2` | 03:33:27.341 | 289.377 | 66.868 | 15.880 | 28.484953 |
| Candidate `QK1Z2w` | 03:41:30.353 | 199.545 | 122.987 | 14.446 | 24.554871 |
| Marked control `OtYWMh` | 03:44:22.371 | 197.675 | 26.459 | 15.493 | 28.480455 |
| Marked candidate `Z3TSO5` | 03:45:21.663 | 259.581 | 79.935 | 15.976 | 30.243116 |
| Final-source candidate `1pkXGl` | 03:59:45.111 | 280.664 | 226.297 | 16.241 | 30.432384 |

The marked pair added one Module-evaluation mark and read its count in existing Provider log events. Control loaded
the Module once in the parent and once per child; candidate loaded it zero times in all three Hosts. This establishes
three omitted evaluations, not that every shared dependency disappears. Both probes were removed before the final run.
Every sample completed and reaped both children, requested and persisted Naming once and refreshed Usage once.
Spinner absence was zero and observation gaps stayed below 26 ms. All five failed the frozen gates and all owned
scopes were unloaded. Whole-run CPU and memory varied; no stable aggregate resource or latency saving is established.

The first four samples captured tracked diffs before the two new files were added to Git's comparison. Thus the two
candidate records omit those new-file bodies. Their current hashes are retained in the numeric record, and
`1pkXGl` includes both files in its complete Source diff. That rerun closes this capture gap without changing the
earlier evidence or converting a failed liveness sample into a pass.

A separate selected-Skill native check, `6vgOHC`, started at 04:07:33.449 UTC with one synthetic local Skill.
Both requests in each child asserted its name, escaped description, file location and active Read Tool. All four
assertions passed; both children completed and were reaped, with Naming/Usage once. This functional check still failed
the Spinner (328.573 ms) and selection (64.321 ms) gates. Its first attempt, `9G2X3z`, used an unsupported unquoted
bracket list in the temporary Agent definition; preflight rejected the literal `[selected-skill]` name. That attempt
is incomplete evidence, not a product regression or a pass. The corrected fixture used the existing list format.
Both owned scopes were unloaded, and the temporary fixture/assertions were removed with their original hashes restored.

Production Source grows by 29 physical lines and tests by 42, a net increase of 71 across ten files. The resolver
shrinks from 690 to 659 lines; its 32-line normalizer now has no filesystem dependency. Async propagation preserves
validation and cancellation ordering without adding a cache or loader abstraction. The numeric record's
`skillFreeLaunchLoading` records every changed file's before/after count and hash, all five samples and their I/O,
RSS and charged-memory counters. These counters do not establish allocation/GC, wakeups, peak process-tree RSS or
per-Module byte savings. The separate selected-Skill check does not certify every modification, cancellation or
recovery scenario. Remaining cold-launch work, the unexplained late Spinner hold and whole-Suite
resource/responsiveness acceptance remain open.

## Skip cleanup after successful atomic publication

On 2026-09-06, `ps-yon.16` removes one redundant filesystem operation per successful Agents atomic write. At
`55dbf85c`, the [shared writers](../../packages/pi-stuff/src/subagents/src/shared/atomic-json.ts) attempted to remove
the temporary pathname after a successful same-directory rename had already consumed it. Both synchronous and
asynchronous writers now clean up only after a failed write or rename, preserving the original error if cleanup also
fails. Directory and rename retry policy, atomic visibility, private permissions and callers are unchanged. No cache,
option or writer abstraction was added. Production Source falls from 128 to 120 physical lines; the existing
regression grows from 28 to 78, for a net Source delta of +42.

The regression reached both writers on the old implementation: two tests passed and two failed because a successful
write called cleanup once instead of zero times. The candidate verifies complete replacement, mode `0600`, no leftover
temporary file, failure cleanup and original-error precedence. The final ordinary-filesystem run of
`atomic-json.test.ts`, `artifacts.test.ts`, `background-engine-lifecycle.test.ts` and
`foreground-engine-recovery.test.ts` passed 42 tests and 155 assertions in 4.45 seconds.

Earlier ordinary-filesystem tests did fail. Candidate runs reported 20 pass/2 fail and 17 pass/1 fail, with artifact
cleanup-hook or cross-process claim-shard timeouts. The old production control also failed the claim-shard test
(17 pass/1 fail). The same 42-test selection then passed on tmpfs before passing again on the ordinary filesystem.
The tmpfs result isolates functional behavior; it is not ordinary-disk performance evidence. No timeout was relaxed.
These failures are retained in the [numeric record](suite-resource-inventory-2026-09-05.json).

Four sequential native runs used the existing foreground observer with `--repeat-tool`, the exact Pi 0.85.0 executable,
a 120×40 terminal and two fresh-context children. All used the ordinary filesystem, fresh private configuration and
temporary caches; the kernel page cache was not reset. No tests, scouts or profiler competed with these runs.
The two ordinary variants differed only in the production writer; separate marked variants counted writer entries
and cleanup attempts. Observer start times below are on 2026-09-06 UTC.

| Variant | Start, UTC | Spinner, ms | Input, ms | Selection, ms | Scoped CPU, seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| Control `mWVidp` | 01:43:06.164 | 284.585 | 99.372 | 197.429 | 26.767517 |
| Candidate `kv9SHH` | 01:44:33.848 | 188.776 | 27.315 | 26.712 | 29.069786 |
| Marked control `dbCmhU` | 01:46:25.493 | 229.068 | 103.880 | 15.903 | 28.560100 |
| Marked candidate `rh14Kw` | 01:47:50.631 | 252.247 | 76.848 | 17.182 | 27.691378 |

Both marked runs observed 52 synchronous writes in the parent and one in each child: 54 publications in either
variant, with cleanup attempts reduced from 54 to zero. No asynchronous writer invocation occurred in this Host
workload; its success-path reduction is covered by the real-filesystem regression, not these native counts.
The marks count calls at the shared writer, not all kernel syscalls, wakeups, allocation or garbage collection.
All temporary marks and Provider probes were removed.

Every run still failed the frozen Spinner gate. The ordinary control also failed input and selection; both marked
runs failed input. All completed and reaped both children, requested and persisted automatic Naming once, and refreshed
Usage once. Spinner absence was zero, capture gaps stayed below 19 ms, and each sample retained over 37 seconds and
3,000 active captures. All four resource scopes were unloaded after shutdown.

Ambient I/O pressure varied substantially. The system's I/O `some avg10` was 78.98 before the ordinary control,
24.62 between ordinary runs and 26.14 after the candidate. This does not identify the cause of an individual stall or
test timeout. The samples establish removal of unwanted cleanup, not a stable whole-Host CPU, memory or latency
improvement. The numeric record's `successfulAtomicPublication` binds all four samples to source, fixture and evidence
hashes and retains resource snapshots and pressure readings. Charged-memory peaks and RSS snapshots are not peak
process-tree RSS. The separate late-Agent stall, remaining resource dimensions and full single-stall acceptance stay open.

## Skip status publication without an IPC recipient

On 2026-09-06, `ps-yon.15` removes inactive status-publisher work from the shared Agent runner. At `c7ea40e9`,
foreground execution installed a queue and fiber and scheduled 100 ms wakeups in the parent Host. The sender checked
for an IPC recipient only after waking, although this Host had no `process.send`. Two guards now check the existing
transport condition before installation and publication. Disk writes and in-process observers stay outside that
condition; connected IPC keeps its existing progress cadence, terminal delivery and disconnect check at send time.
No cache, dependency or scheduler was added. Production Source grows from 469 to 471 lines; the new regression has
79 lines, for a net Source delta of +81.

The regression fails on the old publisher: both absent and disconnected IPC schedule a sleep when zero is expected.
The candidate passes all three cases, including connected IPC, with unchanged local observation and persisted terminal
status. The focused foreground/background suite passes 54 tests and 235 assertions; the exact-Pi Package and execution
matrix passes another five tests and 15 assertions, including nested delegation. `check:fast` passes. These checks
establish functional evidence, not responsiveness acceptance.

Five ordinary runs used the existing observer with `--suite --agent foreground|background --resource-scope` and
`--repeat-tool`. Each launched two fresh-context children on the same exact Pi 0.85.0 executable and 120×40 terminal.
Private configuration and temporary caches were fresh; the kernel page cache was not reset. Runs were sequential,
without competing tests, scouts or profiling. Only the two production guards differed between ordinary variants.
Observer start times below are on 2026-09-06 UTC.

| Variant | Mode | Start, UTC | Spinner, ms | Input, ms | Selection, ms | Scoped CPU, seconds |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Candidate `U4SAr9` | Foreground | 00:41:25.238 | 489.594 | 153.177 | 14.908 | 22.661818 |
| Control `TYhuGV` | Foreground | 00:42:59.589 | 198.518 | 14.112 | 74.233 | 22.351724 |
| Control `IJEc1t` | Background | 00:44:06.189 | 135.712 | 14.555 | 13.934 | 21.803517 |
| Candidate `P2IXQw` | Background | 00:44:54.319 | 173.872 | 14.128 | 14.119 | 21.947347 |
| Candidate `9fZiJk` | Foreground | 00:45:46.200 | 183.739 | 25.791 | 14.152 | 21.927803 |

Only the background control passed every frozen gate. The candidate `U4SAr9` held one Spinner frame for 489.594 ms
at observer-relative 39741.056–40230.650 ms, late in the second Agent call. That stall was not reproduced in the second
ordinary foreground candidate, but its cause is unresolved; it is retained, not dismissed as noise. These samples do
not demonstrate a stable whole-Host CPU, memory or latency improvement, or establish that the guards cannot regress
responsiveness. First-Agent loading and later stalls still require attribution and acceptance.

Two separate marked diagnostics counted calls to publication, publisher installation and the post-sleep sender.
Candidate `X55jdH` started at 00:47:13.419 UTC and control `fNkYbj` at 00:48:13.302 UTC. Both actual parent Hosts had
an absent sender and a disconnected channel. Across the same 22 publication requests, the control installed two
publishers and woke eight times; the candidate installed none and woke zero times. This proves the omitted work in
this two-child workload, not a whole-process wakeup or allocation count. Both diagnostics still failed responsiveness:
candidate Spinner/input/selection maxima were 260.382/73.929/13.990 ms, versus control 195.956/14.125/73.245 ms.
All temporary performance marks and Provider probes were removed after measurement.

All seven runs completed both child Tools and reaped both child processes, requested and persisted automatic Naming
once, and refreshed Usage once. Both background runs delivered two outcomes and observed parent-idle input/selection while children ran.
Spinner absence was zero and every capture gap was below 25 ms; foreground samples retain over 36 seconds and 3,000
active captures, background samples over 14 seconds and 1,190 captures. All seven resource scopes were unloaded after
shutdown. The numeric record's `inactiveStatusPublication` retains every sample, source/fixture/evidence hashes,
resource snapshots and diagnostic counts. Charged-memory peaks and RSS snapshots do not measure allocation, GC or
peak process-tree RSS. Full resource and single-stall acceptance remain open.

## Skip the inactive root Agents implementation in children

At `396e1cfc`, the Agents entrypoint statically imported the root management implementation. Its factory then returned
immediately in a child Host. The child paid for that import despite using none of its registrations. `ps-yon.14` checks
the existing child flag before importing the root. Explicit dependency overrides still reach the original factory;
the parent loads the root during Suite installation, and nested delegation keeps its separate child Extension.
No cache, loader, timer or dependency was added. The entrypoint grows from 1 to 12 lines; a 33-line import-boundary
regression brings the Source delta to +44 lines. It fails on the old entrypoint and passes on the candidate.

Three ordinary runs used the unchanged exact-Pi observer with `--suite --agent foreground --resource-scope` and
`--repeat-tool`. Each parent launched two children with the same fresh-context Bash workload. Configuration and
temporary caches were private and fresh; the kernel page cache was not reset. Runs were sequential, without competing
tests, scouts or profiling. Observer starts below are on 2026-09-05 UTC.

| Sample | Start, UTC | Spinner, ms | Input, ms | Parent rchar, bytes | Scoped CPU, seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| Control `B9o4KB` | 23:29:07.019 | 212.506 | 147.220 | 256,145,210 | 22.589544 |
| Candidate `dMRIAb` | 23:31:57.701 | 197.750 | 110.127 | 241,984,013 | 22.358168 |
| Candidate `9z3isy` | 23:34:47.499 | 220.744 | 73.380 | 241,993,644 | 22.083298 |

Both candidates read about 14.15 MB less according to parent `/proc` accounting, which includes waited-child I/O.
These are returned bytes, not physical storage reads or an exact count of bytes from root-management files. Three
samples do not establish stable whole-Host CPU or RSS improvement. Every run failed the frozen Spinner and input
gates, with no missing Spinner observations and capture gaps below 17 ms. The parent cold-import stall remains open.

Two separate marked diagnostics verify the removed work directly. Control `XYbzCx` started at 23:36:38.077 UTC;
candidate `oyCJtj` followed at 23:37:45.069 UTC. A temporary performance mark in the root Module and a child Provider
counter showed one root import in each control child and zero in each candidate child, at both requests per child.
This proves the root was not evaluated in those candidate children, not that every shared dependency disappeared.
These marked runs also failed the frozen Spinner/input gates. Both probes were removed afterward.

All five runs completed and reaped both children, requested and persisted automatic Naming once, and refreshed Usage
once; their owned resource scopes were unloaded. The existing real-Host execution matrix passed with the candidate,
including actual nested delegation and its Tool authority checks. Together with parent Package loading, root
composition and the import-boundary regression, the focused command passed 12 tests and 88 assertions. The numeric
record's `childRootModuleLoading` retains all five runs, source/fixture/evidence hashes and measurement limits. Charged
memory and final RSS snapshots do not measure allocation, GC or peak process-tree RSS; complete resource and
responsiveness acceptance remain required.

## Read only selected Skill metadata

At `f8398ab2`, Agent Skill discovery read every candidate Markdown file to attach descriptions that its consumers
discarded. Selected files were then read again, and the selected-file cache retained stripped body text that the
Skill prompt never used. `ps-yon.13` removes those discovery reads and unused fields. Description parsing normalizes
only the frontmatter rather than the complete body. Discovery order, source priority, fallback, selected-file mtime
checks, missing-file handling and prompt text remain unchanged. Production Source falls from 720 to 690 physical
lines; the existing focused test grows from 16 to 61 lines.

The filesystem regression failed on the old implementation with three body reads instead of one. The candidate
passes, including metadata-only results, exact escaped prompt text, reuse and changed-file invalidation. A separate
source-bound Bun 1.4.0 diagnostic compared both complete resolvers on 12 LF/CRLF and malformed-frontmatter cases;
metadata and generated prompts matched. It then selected one of 48 files, each 147,500 bytes, using local Skill paths.
One cache-miss resolution made 49 file reads / 7,227,500 bytes before the change and one read / 147,500 bytes afterward.
Across 15 alternating trial pairs of five calls, selected-file mtimes were invalidated outside each timed call.
Median elapsed time fell from 88.171 to 0.568 ms and process CPU from 90,801 to 595 µs. Returned results for all 48
Skills retained 6,291,408 body code units before the change and none afterward; this is not a heap-byte measurement.
The diagnostic uses warmed Source and filesystem state; CPU includes all process threads, not exclusive main-thread
work, and it does not measure allocation or GC. Its first counting attempt failed to intercept namespace reads and
produced no measurements; the retained driver uses the same tested read spy and asserts both counts before timing.

Native comparisons used the existing exact Pi 0.85.0 foreground observer with two Agent calls, full automatic
Naming/Usage and unchanged frozen gates. The temporary fixture supplied the same 48-file local catalog and selected
`skill-00`. Each child Provider request verified the advertised name, escaped description, file location and active
Read Tool. Both children completed their Bash Tool and birth-bound exit in every run. Only the Skill resolver differed
between candidate and control; fixture hashes matched, the two candidate diffs were identical, and no tests or other
benchmarks ran concurrently.

| Variant | Spinner max, ms | Input max, ms | CPU seconds | Sampled parent `rchar`, bytes |
| --- | ---: | ---: | ---: | ---: |
| Candidate `b09Gyz` | 197.941 | 61.946 | 21.543203 | 256,288,088 |
| Control `YkfTkZ` | 209.615 | 134.232 | 22.584736 | 284,617,454 |
| Candidate `fyNfiD` | 198.677 | 62.558 | 22.507493 | 256,301,123 |

Every run had zero Spinner absence, capture gaps below 17 ms and more than 36 seconds of active observation.
All three still failed the 164.768 ms Spinner and 40.465 ms input gates. The parent read counters are consistent with
less Skill I/O, but include other reads and waited-child accounting; they are not exact Skill-only or physical-disk
bytes. These three samples do not establish a stable whole-Host CPU or memory improvement. All scopes were unloaded,
and temporary fixture changes were removed. The numeric record's `skillMetadataResolution` retains every trial,
Source and evidence hashes, native resource snapshots and limits. Full Suite resource dimensions, first-Agent cold
loading and final responsiveness acceptance remain open.

## Resource disposition at e43cc9e1

The dated investigations above keep their original failures and limits. The
[matched resource report](suite-comparable-resources-2026-09-06.md) now adds 52 recovery-verifier runs over 176 native
Host lifetimes, eight Agent tree-memory/GC/callback-interval diagnostics and six passing current-source frozen-gate
Agent runs. The earlier matched 32-run ordinary batch and 28-run scheduler comparison remain intact. This table
reconciles the finite owner audit; it does not claim that every possible payload or configured external service was tested.

| Capability | Removed work or measured disposition | Necessary retained cost and evidence |
| --- | --- | --- |
| Conversation UI | Slash-free redraws no longer read the command registry; command matching avoids per-redraw matcher construction. The earlier paired editor counts/output hashes establish the cuts. | Native painting, Spinner cadence, command discovery after registry changes and input/selection remain functional. Long-Session lifecycle and the current six Agent gate runs cover their shared UI path. |
| Session Naming | The [selector comparison](history-selection-cost-2026-09-06.md) reduces 10,000 inspected messages to six for the measured tail without adding a cache. | Canonical branch construction, bounded prompt selection and one automatic request remain. Full-feature ordinary/Agent observers verify request and persistence; the feature-specific recovery batch does not universally enable Naming. |
| Tool Display | Ledger and shared guard cuts remove upstream duplicate work; no additional grouping/animation hotspot was established. | Five native Host phases per historical/resume run and five per grouping run exercise lifecycle, compaction, resume and tree changes. Historical registration, projection and unchanged animation cadence are required display behavior. |
| RTK | The five exact executable reads were initial certification plus four drift checks, not repeated certification. Retain them. | Two-phase native execution/resume resource pairs preserve rewritten execution and raw Session history. Identity revalidation and bounded model projection remain security/compatibility cost. |
| Codex | The [owner measurement](gc-and-owner-cost-2026-09-06.md#retained-owner-behavior) reads one 71-byte usage response once; no duplicate read was found there. | Full-feature observers perform automatic Usage HTTP once. Account refresh/parsing and configured helper behavior are functional; these fixtures do not certify live OAuth or external account availability. |
| Goal | Reverse latest-state selection and shared runtime guards remove measured scans/lookups; canonical/legacy precedence stays unchanged. | Seven native lifecycle phases per resource run cover continuation, Code Mode, reload, two compaction routes, blockers and retry. Queue normalization, accounting and terminal policy remain Goal-owned work. |
| Context Management | Reuse the existing Worker, projection sharing and invalidation; measurements did not justify another cache or snapshot protocol. | Eight native phases cover projection, persistence, resume and isolation; two further phases cover input/interruption. Direct-input configuration, Worker initialization and complete context recovery remain necessary. |
| Ponytail | Existing first-read canonical-body reuse remains; no new mode cache was added. | Two-phase native mode/restore resource pairs cover Session-owned behavior. Skill-free and selected-Skill Agent evidence separately verifies omitted unused reads and retained requested Skill semantics. |
| Web | The measured publication seam reuses its stored object; no extra payload clone was found. Retain current TTL/lookup semantics. | Owner tests measure 100/1,000/10,000 publications and release; native search/fetch/continuation/restart pairs add actual Session replay and SSRF rejection. Live services remain outside this deterministic evidence. |
| MCP | Existing metadata/version/configuration invalidation and lazy connection remain; no unproven metadata cache was added. | Three native phases per resource run cover setup, connection, actual Tool use, failure and historical Session rendering. Configuration validation and connection/disconnect cleanup remain required. |
| Background Work | Shared successful atomic publication omits only the measured redundant cleanup; recovery/process identity checks remain. | The six-path monitor matrix measures cancellation and command/file/HTTP/log/timeout outcomes. Agent background completion/recovery checks separately preserve durable results and parent independence. |
| Agents | Removed root-only child imports, unused Skill reads/loading, repeated config discovery, unused lock-owner flushes, absent-IPC timers and discarded result scans. Foreground execution uses the per-run Worker; cold background launch separates recovery writing from reader/runner loading. | Real child execution, cancellation, canonical results, recovery and birth-bound reaping remain. Whole-tree CPU/RSS and scheduler counts include the isolation cost: foreground retained RSS and wakeups can rise. Current direct, Code Mode/Ledger and background gates pass without changing thresholds. |
| Todo | No measured duplicate replay or overlay work justified a new cache. | Native dependency creation/completion plus cold Session replay pairs preserve identical task state. Dependency validation, Session-owned storage, replay and completion display remain functional work. |
| BTW | Keep the existing bounded retained history and context-fitting behavior; no additional cache was introduced. | Three native phases per resource run exercise execution and retained history. Context conversion, overflow retry and history bounds are required behavior. |
| Notification | Owner measurements found one cancellable grace timer, no recurring poll or duplicate idle scheduling. | Counts at 1/100/1,000 settlements verify cancellation and disposal; two native lifecycle phases per resource pair include the real owner. Retain delivery and its existing grace policy. |
| Code Mode | Warm Ledger folding skips unchanged history; cold event-kind dispatch avoids repeated schema cleaning while preserving the unsafe-key-filtering clone. | Native cold Tool and foreground-Agent Ledger scenarios, approval/replay regressions and packed verification retain canonical validation and the shared helper. No fixed pre-Tool wait or replay bypass was added. |

Shared startup, idle shutdown, first/repeated prompting, unchanged reload and long Sessions also have the
[lifecycle comparison](suite-lifecycle-comparison-2026-09-06.md): 240 user/assistant turns and 1,000 historical Tool
results. Its older baseline includes intervening Host/Work/Goal changes, so it is not an isolated optimization delta.
The loader still fingerprints paths/metadata for drift and invokes installers transactionally; the
[cold-start marks](gc-and-owner-cost-2026-09-06.md#cold-start-boundaries) distinguish fingerprinting, imports,
registration and first-input Context activation. Shared status equality, Tool registration and recovery remain required
coordination, not new optimization targets inferred from aggregate CPU.

Resource axes now have explicit observations: waited/cgroup CPU, end/tail RSS, sequentially sampled tree RSS,
complete-cycle GC allocation lower bounds and observed pauses, partial kernel I/O, scheduler wakeups and elapsed
operation/callback intervals. Their limits are not interchangeable: sampled sums are not continuous peak RSS;
tail snapshots are not guaranteed steady state; GC logs are not total allocation; context switches are not wakeups;
callback gaps bound only wholly covered non-yielding tasks. The numeric reports retain each limit and failing sample.

No further speculative per-owner resource probe is justified by this inventory. The
[current-source failure disposition](suite-comparable-resources-2026-09-06.md#current-source-recheck-and-historical-failures)
keeps pre-Worker holds and later failed source revisions distinct from current passing execution. Full worktree checks,
two complete independent reviews and verified delivery remain the final engineering obligations, not another resource
matrix or permission request. Conditional external-service acceptance is still unverified where the declared service
or credentials were not exercised; deterministic Host evidence is not relabeled as live service evidence.
