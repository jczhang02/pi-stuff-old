# Bundled context engine provenance

Pi Stuff integrates the official Magic Context Package through this adapter and does not vendor Magic Context Core.
The repository applies one temporary, audited dependency patch to the pinned Package for tokenizer compatibility and stable
message identity during Pi retry, plus genuine Magic recovery through the public compaction hook.

The exact published Package executes inside Pi Stuff's Context Engine Worker. The adapter produces one
activation-time in-memory bundle solely to make the official module graph resolvable from the certified standalone Pi
binary; it does not alter upstream source or persist a derived artifact.

- Upstream: `https://github.com/cortexkit/magic-context`
- Upstream release: `v0.41.1`
- Published source commit (`gitHead`): `cbfac49fa88b3eb86074b9499c38e993cc447f34`
- Package: `@cortexkit/pi-magic-context@0.41.1`
- npm integrity: `sha512-FYl1IH4KOCXkt4UOI6ZswwI/p3YO9+eP2hrfOtgjlsYjp8UHI+OM7fRY6Z6PGOcaf5+kn0PM1CeHY9j3mjL9TQ==`
- npm tarball SHA-1: `877ae8c6d055bc8af7e7fa5f1d180724c18d2dfb`
- Audited tarball SHA-256: `5a227889dd91ed952a7403390b463e3e1ac705f837b8f055ffba62eb659229de`
- License: MIT, as declared by the official Package manifest and upstream repository.

## Temporary tokenizer compatibility patch

- Patch: [`patches/@cortexkit%2Fpi-magic-context@0.41.1.patch`](../../../../patches/@cortexkit%252Fpi-magic-context@0.41.1.patch)
- Patch SHA-256: `b391655ee46a47c0aedd21cfc857d9870ba585b6e2cdf156ee758f724a3caf40`
- Scope:
  - add the published module's `import.meta.url` ancestry and Bun isolated-linker `node_modules` root to the existing
    `ai-tokenizer` fallback search;
  - preload the tokenizer during engine initialization instead of the first submitted turn;
  - reuse an image draft's existing image-token estimate while hashing it, avoiding exact BPE work over base64 that is
    not part of the hash result.
- Behavior retained: a genuinely unavailable tokenizer still uses Magic Context's existing heuristic fallback. The
  patch does not suppress or intercept diagnostics.
- Evidence: a forced frozen-lockfile install applies the patch; direct `preloadTokenizer()` under the certified Pi Host
  resolves from an unrelated user project; the 4 MiB malformed-image PTY case remains responsive; and the real Context
  PTY gate rejects raw `[magic-context]` output.
- Removal trigger: replace the patch only after an exact official Magic Context artifact passes the same clean-install,
  first-input, malformed-image, schema, and real-Host checks.

### 2026-09-02 upstream audit and upgrade

The latest npm release at this audit is
[`v0.41.1`](https://github.com/cortexkit/magic-context/releases/tag/v0.41.1). The preceding
[`v0.41.0`](https://github.com/cortexkit/magic-context/releases/tag/v0.41.0) adds cache-stability repairs, Pi RPC and
multi-Session support, layout-tolerant Pi module resolution, and storage migration v82. The patch release fixes the
first-day historian, bundled-Pi subagent, optional ONNX, Todo rendering, and diagnostic regressions.

The official 0.41.1 artifact still lacks all three local tokenizer and image-hash behaviors: its tokenizer fallback
walk starts only from `process.argv[1]`, tokenizer preload remains outside factory initialization, and part hashing
cannot accept an already-computed token estimate. The removal trigger is therefore not met, so the equivalent audited
patch remains in place.

Schema v82 adds `memory_verifications.mapping_origin`. Certification creates a real v82 database, rolls it back to an
exact v81 shape, verifies automatic v81-to-v82 migration, and then starts a v81-fenced Worker against v82 storage. The
stale Worker exposes no commands or Tools and retains only `session_shutdown`, so it cannot write a newer store.

Upstream 0.41.1 also reads `pi.events` for child-subagent lifecycle notifications. Pi never initializes child
Extensions inside the Context Engine Worker, so that isolated adapter supplies a no-op EventBus: there is no in-Worker
publisher to forward, while foreground Pi and Agents retain their existing lifecycle ownership.

The Package declares Pi peers `^0.80.2`, which does not include the Suite's certified Pi 0.84.4 Host. Pi Stuff does not
infer compatibility from that range. Real Pi 0.84.4 PTY and Provider gates separately certify activation, cancellation
recovery, live Session replacement and restoration, cold resume, Magic-only compaction, project isolation, startup/degraded
fail-open behavior, and active Host-managed fail-closed Provider handling. See the [optimization report](../../../../docs/reports/magic-context-effect-optimization-2026-09-02.md).

## Pi Stuff adapter policy

- Configured startup is read-only toward user configuration. Direct first-use authority follows upstream XDG and
  JSON/JSONC discovery, with a lexical-only default; explicit embeddings remain untouched.
- Enabled Magic exclusively owns foreground projection and compaction, including failure recovery. Native behavior
  remains only for unconfigured or explicitly disabled Magic. Local estimates do not block valid requests.
- Every foreground Context event calls Magic. Pi owns persistence, retry, and queue delivery, including queue
  continuation after explicit cancellation. There is no new foreground scheduler or transport policy.
- The pinned official artifact plus the audited patch runs in an internal Worker with immutable Host snapshots and
  Session-bound effects. Ordinary lifecycle events do not inherit ambient Agent cancellation; the compaction hook,
  Tools, and signal-aware commands receive their invocation-owned signals.
- Existing bounded reference projections for BTW and Agents remain. Only the five Context Tools and focused status,
  flush, recomposition, wrap-up, and upgrade commands are exposed; no competing Todo, statusline, announcement,
  Dreamer, or Sidekick UI is added.

## Retained-summary retry identity correction

The Pi adapter now uses Magic's existing reference and unique-fingerprint resolver for message identities on every
Context projection. Equal message counts cannot prove positional alignment: Pi retains earlier compaction summaries
and removes a persisted failed Assistant response from active retry messages. Those differences can cancel and attach
drop records to the wrong messages. The unused positional alignment implementation is removed.

A regression uses actual Pi Session projection and the real Magic Worker, retains an older summary, persists a failed
response, then retries unchanged input. The projected messages and tags must remain identical. This correction is part
of ps-5r4 under ps-eck; it does not alone certify Magic-only overflow recovery. Remove this patch component when an
exact upstream artifact passes the same retained-summary/retry regression and real Host differential acceptance.

## Genuine overflow compaction and durable completion

The same pinned dependency patch connects `session_before_compact` overflow/manual requests to the existing Historian,
boundary resolver, compartment lease, and retry machinery. It returns the durable compartment summary and verified
`firstKeptEntryId`; Pi persists the result and owns its subsequent retry. It adds no storage schema or full-history
recomposition. An abort check immediately before Historian publication prevents cancellation from publishing late work.

Recovery reads pending completion strictly: malformed state stops without clearing the evidence. A lost Worker reply
reuses the committed compartment after restart rather than rerunning the Historian. The pending marker stays until Pi
persists its compaction, then the existing compare-and-clear drain removes it. One ten-minute allowance bounds this
overflow operation; the Suite shares that allowance across its single permitted Worker restart. Manual compaction does
not inherit a fault deadline. Actual overflow uses Magic's existing emergency tail policy, retaining the current input.
Recovery drains successive runnable chunks with ordinal progress checks before returning to Pi. Each boundary calculation
owns its short-lived raw-message provider binding, so Historian cleanup cannot hide remaining history.

`tests/acceptance/context-management/magic-recovery-host.test.ts` compares direct patched Magic with the Suite on the certified Pi executable,
and injects real Worker termination before work or after publication. It also covers completed Tool reuse, transient
Historian failure, uncertain acknowledgement, no progress, repeated overflow, and native cancellation/queue parity.
These fixture Provider errors establish control flow, not live remote capacity. Remove this patch component only when
an exact official artifact passes the same durable-completion and real-Host differential cases. Re-audit handler signal
consumption, lease/publication atomicity, and summary boundaries on every upstream upgrade.

### 2026-09-06 child pressure differential

`bun test test/agents/child-context-pressure-host.test.ts test/context/magic-recovery-host.test.ts` passes 14 tests, 0
failures, and 116 assertions in 73.21s on certified Pi 0.85.1 (log: `.artifacts/ps-8ew-acceptance/context-host.log`). It
exercises the production `buildPiArgs` path with the actual Magic Worker/Historian, fresh and branched seeded child
histories, two real overflow recoveries, eight intervening Tool calls, latest steering, and final-report checks for prior
findings and completed-check IDs. The first
run failed because Magic's `clearOldReasoning` erased signed reasoning during replay. The patch now preserves signed
reasoning blocks in both existing clear paths. The next failure showed that a successful compaction summary was followed
by a retry with stale cached projection; invalidating the Pi cache before the public `recoverPiCompaction` hook fixes that
ordering. This reuses the existing cache seam and adds no child projector. The combined command passes 14 tests with 116
assertions in 73.21s; the fixture proves production control flow and protocol preservation, not live remote capacity.
A separate live background run confirmed clean teardown; live pressure compaction remains unclaimed.


The Pi Historian also records its three pre-chunk no-op exits as `noop`, matching their existing log messages and the
existing post-filter/budget no-op contract. Previously those returns retained the default `failed` telemetry status,
causing the real acceptance gate to reject otherwise successful runs. This changes outcome accounting, with no new
compression or retry behavior. The real Provider gate checks that genuine Historian failures remain absent.

## Pi process identity during migration

The same temporary patch uses Linux null-delimited process argv to limit package-name matching to the actual
script entrypoint for direct Node, Bun, and Deno launches, preserving paths containing whitespace. An observer receiving a Pi installation path as an application argument is not another Pi instance.
Otherwise the migration guard mistakes the observer for a competing Pi and refuses to initialize a fresh store.

Native Pi/OMP executable names and actual Pi script entrypoints remain migration blockers. Unavailable argv,
other platforms, and option-led or `run` interpreter launches retain upstream conservative matching; further
narrowing requires an unambiguous entrypoint. Database migration, schema fences, RPC identity checks, and storage formats are unchanged.

`tests/component-integration/context-management/magic-migration-guard.test.ts` substitutes only the OS process list
and exercises real Worker/database initialization with real child argv, isolated storage/configuration,
argument-only markers, whitespace paths, and genuine Pi launches. Unreadable argv must retain protection. The original
`tests/acceptance/repository/responsiveness-pty.test.ts` verifies foreground, background, Context, and Goal work with
the installed Host path, without renaming it to avoid the marker. Remove this patch component when an official
artifact passes both process-identity cases and the real-Host acceptance.
