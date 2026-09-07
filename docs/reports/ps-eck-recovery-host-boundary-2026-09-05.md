# ps-eck: Magic recovery and the Host cancellation boundary

Date: 2026-09-05. Status: implementation committed; final online acceptance blocked by Provider quota. Not release-ready.

The branch is `fix/ps-eck-magic-recovery`, based on `2610bd42`. Signed checkpoints are `e87a1e33` (identity),
`673e6a8b` (recovery), `c833a3fc` (failed Worker registrations), and `143b7e5f` (incremental identity cleanup and no-op
accounting). They are pushed; no merge or installation was performed. The accepted contract is
[ADR 0031](../adr/0031-preserve-magic-context-behavior-through-suite-integration.md).

## Root causes and implementation

The pinned upstream Pi adapter incorrectly treated equal message counts as proof of positional identity. A retained
compaction summary and a persisted failed Assistant response can cancel the count difference while shifting identity.
The patch removes that shortcut and always uses Magic's existing reference/unique-fingerprint resolver.

The earlier causal A/B used authenticated Pi 0.84.4 and a reconstructed incident state. Both arms began with the same
request hash. After an injected connection loss, the faulty retry grew from 371,210 to 5,397,756 bytes and received a
real Provider overflow while displayed usage remained 49.695%. With only the identity correction, retry remained
371,210 bytes and succeeded. This proves the causal mechanism; it does not reconstruct the exact historical rejected
payload or database state. Final release certification uses Pi 0.85.0 separately.

Final log auditing found incomplete removal of the shortcut: incremental branch updates still called the removed
eligibility helper and appended to the removed positional list. The patch now removes that obsolete update too. The
real Worker retained-summary regression additionally rejects any branch-projection failure, so identical fallback
results cannot hide a broken incremental path.

The earlier Suite policy introduced independent failures: native fallback changed compression ownership, while a 95%
local estimate gate rejected requests without evidence of real Provider overflow. The new adapter keeps Magic exclusive,
removes its extra Provider projection reuse cache, and treats estimates as display information. A small pinned upstream
patch connects the existing Historian to Pi's custom-compaction hook with genuine summaries and durable boundaries.

Actual Worker termination tests also exposed competing fatal-error and compaction cleanup paths. One cleanup could
invalidate the generation of the replacement Worker. Fatal notifications now only mark the failed engine unavailable;
the bounded critical recovery path owns automatic cleanup and replacement. Explicit input and new-Session activation
also clean committed registrations before replacing a failed Worker. Regression tests reproduced stale closed-Worker
handlers through both entry points and now prove that only the replacement receives subsequent Session events.
No Pi or transport policy patch is included.

## Host evidence

Final Host checks use the certified Pi 0.85.0 Linux x64 release, source
`107d79f11072bbc8a3a757ed7fd69596bee7d68c`, binary SHA-256
`0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072`. Earlier exploratory runs used a different local
binary hash and are not the certification evidence. The new recovery test checks provenance before running.

Run with `PI_BIN` pointing to that verified executable:

```sh
bun test test/acceptance/context-management/magic-recovery-host.test.ts test/component-integration/context-management/magic-worker.test.ts test/acceptance/context-management/context-pty.test.ts
```

Fourteen RPC/PTY tests passed on the certified Host: twelve recovery cases and two Context TUI cases. Eight additional
real Worker regressions passed under the repository Bun runtime. Tests use isolated, disposable Sessions and a
deterministic Provider. Actual Magic compaction and actual Worker death are exercised; injected overflow proves
control flow, not a remote capacity limit.

| Scenario | Observed result |
| --- | --- |
| Direct patched Magic and full Suite | One genuine hook compaction, Pi retry succeeds, accepted input persists once. |
| Completed Bash Tool | One execution and one side effect; its persisted result is present in retry context. |
| Transient Historian failure | Existing Magic retry succeeds without another foreground scheduler. |
| Worker dies before compaction | One replacement Worker; one Historian result. |
| Worker reply lost after durable publication | One replacement reuses completion; Historian does not run again. |
| Uncertain completion or no progress | One explanation, no retry request, input remains persisted. |
| Second Provider overflow | Two requests, one compaction, no endless retry; input remains. |
| Explicit cancel with queued input | Magic stops; subsequent queue delivery matches the Host-only control. |
| Unavailable Context in real TUI | Current input persists, explanation appears, no raw Provider request. |

The Host-only cancellation control loads a signal-aware compaction fixture without Magic or Pi Stuff. Pi awaits
`agent.prompt()`, then `_checkCompaction()`, then decides whether `agent.continue()` should run. Queue delivery after
cancellation is native Host behavior, accepted by the maintainer and outside this repair. Production code neither
clears nor resubmits queues. The same serial foreground flow does not overlap projection with its overflow compaction;
BTW/Agents projections do not clear the foreground recovery allowance.

## Provider evidence and review status

The existing live Provider gate passed on the certified executable, covering normal Magic pressure/compaction and Session
lifecycle behavior. Dedicated live overflow acceptance also passed against `openai-codex/gpt-5.3-codex-spark` with its
128,000-token window, using `openai-codex/gpt-5.6-terra` for the real Historian. Forty generated completed-artifact pairs
contain 160 deterministic SHA-256 checksum strings per user message; no private Session content is sent.

| Live execution | First request | Retry request | Outcome |
| --- | --- | --- | --- |
| Full Suite | 480,302 bytes; remote overflow | 63,070 bytes | Continued successfully; current input once; no Tools. |
| Direct patched Magic | 463,661 bytes; remote overflow | 46,423 bytes | Same successful continuation and retained boundary. |

Both runs persisted one genuine Pi hook compaction ending at ordinal 78. The Provider-payload size difference reflects
Suite prompt/Tool contributions. Eight durable compartments were produced in the same recovery phase; Pi then retried
once. The initial Host estimate was 105,351 tokens despite actual remote rejection, confirming that estimates alone
cannot decide admission. Summary bytes vary with real Historian output.

This acceptance caught two draft defects: one Historian chunk was insufficient, and nesting a persistent raw-message
provider around the Historian allowed its cleanup to hide remaining history. Recovery now drains runnable chunks with
progress checks, scopes each boundary read independently, and uses Magic's emergency tail on actual overflow. The
`multi-step` deterministic Host regression protects this behavior. No live-capacity claim follows from fixtures alone.

Final source commit `143b7e5f` passed two consecutive independent Astra correctness and Thermo-Nuclear reviews of the
complete diff and affected capability. Earlier clean reviews were invalidated by subsequent changes; the final two
rounds include the incremental identity and no-op accounting amendments. Both reported no blockers. The first final
review also ran 136 Context tests and the twelve certified Host recovery cases; the second independently inspected the
complete source without competing with the ongoing acceptance processes.

Final log auditing also exposed an upstream accounting defect: three pre-chunk Historian no-op exits retained the
initial `failed` status. The patch records those explicit no-op returns as `noop`, after their cleanup; actual failure
paths remain failures. The strict real Provider gate is retained rather than ignoring failed rows. The older gate had
completed pressure, cancellation, Session switching, cold resume, and isolation before rejecting these no-op records.

The latest online runs reached the Provider's usage limit. One final-patch run completed real Historian publication,
then continuity retrieval received quota errors; the next stopped during setup with the same explicit quota error.
Consequently the complete online gate has not passed at final source commit `143b7e5f`. Earlier successful live overflow
and ordinary acceptance runs remain dated evidence, not a claim of final-source online certification. A separate real
model-switch probe passed from Terra to Spark, with each complete current input observed in the selected model's
outbound request. Request instrumentation records model IDs, byte counts, and input-presence booleans only.

Known test-run interruptions are retained in the local logs: an SDK file was temporarily absent during dependency
installation, PTY processes failed during overlapping heavy acceptance runs, and a schema fixture briefly encountered
SQLite locking. Failed isolated tests are rechecked serially after installation. No production policy is relaxed to
make those fixtures pass. Goal/Ponytail/Tool-grouping fixtures explicitly select their native Context scope; the Goal
fixture uses the existing fixed Code Mode host path instead of downloading into every disposable cache.

Final offline results: `check:fast` passed. The last `bun run check` executed all 294 isolated test files: 292 passed;
the two interrupted files passed their subsequent serial reruns. Goal checks, the Tool Activity benchmark, and packed
Package certification then all passed serially against the final source. This is complete component evidence across
those runs, not a claim that the original monolithic command exited successfully. No further code changed after the
two clean final reviews.

Relevant physical line counts are runtime 791 to 796, projection 346 to 282, Worker client 421 to 425, and Statusline
rendering 507 to 508. Native preflight (89 lines) is an extracted native-only policy; recovery (51 lines) owns the shared
critical-phase budget. Native preflight is never a fallback after an enabled Magic attempt.

The identity child `ps-5r4` is closed in Beads. The broader `ps-eck` remains in progress until the final online
acceptance can run without the Provider quota block and all required gates are recorded. Sessions, payloads, credentials,
and private operational paths are excluded from this report and Git; disposable authentication copies were removed.
