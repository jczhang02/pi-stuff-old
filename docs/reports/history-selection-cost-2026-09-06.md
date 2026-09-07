# Naming and Goal history-selection cost

On 2026-09-06, `ps-yon.20` removed two discarded-history scans at the existing selectors. Naming now walks backward
until it has six user/assistant messages, then restores chronological order. Goal restoration stops at the latest
canonical entry; it remembers the latest legacy entry during the same walk and uses it only when no canonical entry
exists. Neither change adds a cache. Canonical validation, malformed-state handling, queue normalization and initial
Naming's short-exchange rule are unchanged.

The base is `67944dfeda231fd2feb026306ee167068e86087c`. The
[numeric record](history-selection-cost-2026-09-06.json) retains all 165 paired trials, output/input hashes, Source
hashes and the separate full-Suite Goal sample. This is a local reduction, not completion of the
[16-Capability audit](suite-resource-inventory-2026-09-05.md).

## Selector measurements

The exact Pi 0.85.0 executable, SHA-256 `0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072`, loaded
a temporary diagnostic Extension under its embedded Bun 1.3.14. The control modules retain the base's function bodies;
only import paths and a trailing blank line differ. Imports finish before measurement. These are production selector
calls over synthetic arrays, not measurements of Pi's `getBranch()` construction or the complete Suite.

Branches contain 100, 1,000 or 10,000 alternating user/assistant messages. Goal cases replace the last entry with
canonical or legacy state containing one paused head and eight queued goals, or omit Goal state. Numeric-index reads
are counted separately through a Proxy. Timing uses ordinary arrays: 20 warmup calls per variant, then 11 alternating
control/candidate pairs of 100 calls. Hashing is outside the timed interval. Process CPU includes background runtime
threads, so it can exceed elapsed time.

| 10,000-entry case | Indexed reads per call, before → after | Median elapsed per 100 calls, ms | Median process CPU per 100 calls, µs |
| --- | ---: | ---: | ---: |
| Naming, initial | 10,000 → 6 | 17.215 → 0.018 | 22,865 → 18 |
| Naming, periodic/forced | 10,000 → 6 | 16.705 → 0.015 | 25,042 → 15 |
| Goal, latest canonical | 10,000 → 1 | 5.441 → 3.097 | 5,451 → 3,090 |
| Goal, legacy only | 20,000 → 10,000 | 7.528 → 4.874 | 7,617 → 4,856 |
| Goal, absent | 20,000 → 10,000 | 4.273 → 1.782 | 4,261 → 1,779 |

Every timed result matches the control's output hash; input hashes remain unchanged. An exhaustive Naming comparison
also matches all 19,682 initial/periodic cases over user, assistant and custom sequences of length zero through eight.
The smaller cases remain in the numeric record, including Goal legacy CPU at 1,000 entries increasing from 3,611 to
4,150 µs. No uniform CPU improvement is claimed. Long custom-only tails still require scanning; legacy/absent Goal
selection remains O(branch entries). Required queue validation and normalization remain in the Goal timings.

An intermediate `findLast` implementation passed the native diagnostic but failed the Goal module's ES2022 typecheck.
It was replaced by the single reverse loop, without changing the target or adding a compatibility shim. Earlier harness
attempts hit Jiti setup failure or left RPC stdin open until the deadline; those failed attempts are retained privately.
The final loop measurement closes stdin and exits zero.

## Functional and responsiveness checks

Regression tests first failed on the old selectors: Naming read the discarded 1,000-message prefix twice, and Goal
visited superseded canonical entries. The final focused run passed 46 tests, with 95 Bun assertions plus Node assertions.
Cases include latest malformed/cleared canonical state taking precedence over newer legacy state, sparse slots and the
initial short-exchange boundary. The compiled Goal tests and all 22 Goal runtime smoke scenarios passed. `check:fast`
passed again after the unrelated CI fixture repair; no selector Source changed between these checks.

The real fixed Host passed the existing automatic/forced Naming and resume verifier, plus Goal's full-width dialog
verifier. A separate uninstrumented full-Suite normal Goal run, `sXTDbx`, started at **09:51:31.418 UTC** and passed
the unchanged frozen gates:

| Observed maximum | ms |
| --- | ---: |
| Spinner frame | 114.089 |
| Startup input feedback | 13.969 |
| Steady input feedback | 14.425 |
| Selection feedback | 14.070 |
| Observation gap | 16.248 |

The 120×40 run continuously captured 1,606 frames, including 1,019 active frames over 12.175 seconds, with no missing
active Spinner. It executed one automatic Goal continuation, persisted completion before the final response, generated
and persisted one automatic Session name, and refreshed Usage once. The scope used 11,770,115 µs CPU; sampled RSS was
656,826,368 bytes and peak charged memory was 919,261,184 bytes. The owned scope was unloaded after shutdown.

Those counters are one full-workload observation, not a paired whole-Host saving. Allocation, GC, complete wakeups,
peak process-tree RSS, Goal accounting and long-session replay/compaction costs are not measured here. Historical
unassigned 270/489 ms Agent holds and the separate CI repair remain open. This sample does not waive them or establish
absence of rare stalls.

## Source size

| Source | Before | After |
| --- | ---: | ---: |
| `session-naming/state.ts` | 90 | 88 |
| `goal/src/persistence.ts` | 402 | 401 |
| `test/session-naming/state.test.ts` | 140 | 189 |
| `test/goal-upstream/persistence.node.ts` | 366 | 397 |

Production Source drops three lines; the existing test files gain 80 lines of boundary and discarded-work regressions.
