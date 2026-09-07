# Pi 0.85.0 Suite resource baseline

This is a pre-optimization baseline, not a fix or compatibility certificate. On 2026-09-05, a small paired offline
profile showed substantial Suite startup, CPU, and memory cost. A separate quiet Provider-wait probe remained
interactive. Neither result establishes which costs are redundant, and neither covers the known long-Session
Execution Ledger stall. Policy is recorded in [ADR 0034](../adr/0034-remove-redundant-suite-work-without-feature-cuts.md).

## Exact environment

| Item | Recorded value |
| --- | --- |
| Suite source | `6d0507c165acc5056b7e4bf4aedddef326ab915b`, unchanged production source |
| Official Host release | [Pi v0.85.0](https://github.com/earendil-works/pi/releases/tag/v0.85.0), Linux x64 |
| Upstream source | `107d79f11072bbc8a3a757ed7fd69596bee7d68c` |
| Archive SHA-256 | `a7e7c65f1dc528d2e17e7d946ad2b61df0e2b0f9952faee77807c2484b464d6e` |
| Executable SHA-256 | `0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072` |
| Executable size | 105,764,992 bytes |
| Embedded runtime | `Bun v1.3.14 (0d9b296a) Linux x64 (baseline)`, marker at byte 2,995,056 |
| Repository toolchain / Pi development types | Bun 1.4.0 / Pi 0.84.4 |
| Machine | Intel Core i9-13900H, 20 logical CPUs, about 31 GiB RAM, Linux 6.19.10-jc-xanmod1 |
| Terminal | Fullscreen, 120 columns × 40 rows |

The archive digest matched the official release asset metadata before extraction; the extracted executable was then
hashed independently. Version output alone was not used as build identity. The official
[build workflow](https://github.com/earendil-works/pi/blob/v0.85.0/.github/workflows/build-binaries.yml) pins Bun 1.3.14.
No installed Pi binary, user configuration, or running user process was replaced or restarted.

The machine was shared, not CPU-isolated; frequency and background load were not controlled. Swap was in use.
These are exploratory local measurements, not portable performance guarantees. The repository still certifies
Pi 0.84.4 under [its compatibility contract](../compatibility.md); running this fixture on 0.85.0 does not upgrade it.

## Paired lifecycle profile

The existing [fixture](../../scripts/lifecycle-benchmark-fixture.ts) and
[sample runner](../../scripts/lifecycle-benchmark-sampling.ts) launched separate real Pi processes with private home,
Settings, cache, and Session directories. Both arms used the same deterministic in-process Provider. Only the Suite
arm loaded Pi Stuff. There were no credentials or model-network requests.

Each cell had one warmup and three measured samples, alternating Host-first and Suite-first order. Warmup does not
make later processes share a loaded Suite: each run has fresh configuration and cache directories. Each run submitted
one first prompt and two subsequent prompts. The long Session contained 240 user/Assistant turns and 1,000 historical
Tool results of 4,096 bytes each. Session integrity, expected Tool registration, editor readiness, and terminal
restoration checks passed for all 16 completed runs.

Context was configured enabled, with embedding off, Dreamer and Sidekick disabled, TodoWrite disabled, and fail-closed
blocking off, following the existing offline fixture. Naming and usage functionality were not removed from the Suite,
but this credential-free fixture does not exercise their complete live behavior. No Agent was launched. No Code Mode
ledger history was seeded. This is not a full-function or complete Capability profile.

Values below are medians across the three non-warmup samples. CPU is accumulated process CPU time over the complete
run, not wall time. Peak RSS is the process high-water mark returned by Bun's child `resourceUsage()`; it includes
in-process Workers but is not simultaneous aggregate RSS of a process tree. The observer wrapper is excluded from
that CPU/RSS accounting but contributes common launch overhead to elapsed startup measurements.

| Session / arm | Startup ms | First response ms | Subsequent response ms | Run CPU seconds | Peak RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh / native Host | 717.50 | 19.62 | 5.48 | 0.947 | 158.1 |
| Fresh / Suite | 5,353.12 | 736.36 | 699.85 | 10.494 | 984.8 |
| Long / native Host | 2,379.13 | 73.86 | 8.07 | 3.848 | 463.9 |
| Long / Suite | 6,924.57 | 1,519.06 | 680.48 | 14.220 | 930.2 |

The existing runner reports the nearest-rank p50 of each run's two subsequent responses, which selects the lower
one; the table then takes the median across runs. This metric must not be used as a worst-interaction or stall gate.
First-response delay includes work before the Provider boundary, not just rendering. These differences establish
additional cost, not how much of it can be removed without changing functionality.

The [numeric samples](suite-resource-baseline-2026-09-05.json) retain warmups, each lifecycle sample, resource counters,
and the separate probe results. Initial setup failures (a missing timing utility and missing worktree dependencies)
were corrected before these runs; failed setup attempts are not performance samples.

## Quiet wait and observation limits

A separate native/Suite pair used private tmux servers and an offline Provider that completed after 16 seconds. After
editor readiness and one second of settling, each process was observed idle for five seconds. A 12-second active
window began only after a visible Working spinner appeared. During that window the observer sampled the pane every
25 ms plus capture time, typed three markers, and changed command-autocomplete selection three times.

| Observation | Native Host | Suite |
| --- | ---: | ---: |
| Idle process CPU over 5 seconds | 20 ms | 30 ms |
| Idle RSS at window end | 129.7 MiB | 521.9 MiB |
| Active-window process CPU | 910 ms | 1,610 ms |
| Median observed spinner frame | 84.1 ms | 83.9 ms |
| Longest observed spinner frame | 92.9 ms | 122.1 ms |
| Slowest observed typing / menu selection | 31.0 ms | 31.4 ms |
| Longest capture call | 5.2 ms | 5.9 ms |
| Largest interval between samples | 64.5 ms | 65.2 ms |

CPU came from `/proc` process counters at 100 ticks per second. RSS values are snapshots, not retained-object sizes or
leak evidence. No child process was present at the resource-window endpoints; this does not prove no transient child
existed. Active-window CPU includes the cost of responding to the probe's interactions. A context-switch count is
not an exact timer-wakeup count.

Pi 0.85.0 puts the default Working indicator in the editor border. The observer accepted a spinner there or in the
Suite's custom-editor surface and required actual changing glyphs. Failure to find the spinner was not a pass.
Typing and selection results have roughly one sampling interval of observation delay; they are not precise native
event latency. Selection here means autocomplete selection, not mouse text selection. Menu setup also enlarged the
maximum sample gap. The probe did not observe the initial pre-spinner interval, any Tool invocation, or long-history
replay. It therefore cannot certify the pre-Tool freeze, calibrate final thresholds, or establish absence of rare stalls.

## Reproduction and implementation handoff

Use the recorded source commit and its frozen dependencies in an isolated checkout. Download and verify the exact
release above into a temporary directory. Reuse `prepareFixture(root, project, 1000, 4096)` and `runSample()` directly,
with `acceptance: false`, `contextEnabled: true`, `trace: false`, `promptRepetitions: 2`, variants `host` and `suite`,
scenarios `fresh` and `resume-long`, action `prompt`, and terminal size 120×40. Run iterations 0–3, marking iteration 0
as warmup and reversing pair order on odd iterations. Set `packagePath` to that checkout's Package and `piBinary` to
the exact release. Do not alter the existing certified CLI allowlist to make this exploratory profile run.

For the resource column, an external Bun wrapper launched that Pi executable with inherited PTY streams, waited for
exit, and recorded `resourceUsage().cpuTime` in seconds and `maxRSS` in MiB. Fixture generation used the repository's
0.84.4 Session API; the actual measured Host was the hashed 0.85.0 release. The temporary probe is exploratory; a retained,
continuous pre-Tool observer and full workload matrix belong to the implementation work, not to this small baseline.

The accepted work map is `ps-yon`. Its inventory must cover all 16 Capabilities, shared lifecycle paths, full-feature
profiles, process-tree costs, allocation/GC, I/O, wakeups, and individual liveness failures. No threshold has been
frozen from this report. The existing ledger invalidation finding remains a separate confirmed optimization target;
the short quiet-wait results neither reproduce nor disprove it. Coordinate that change with `ps-j3v`, which modifies
overlapping retention and lifecycle behavior.
