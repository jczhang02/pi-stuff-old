# ps-8ew reliability repair acceptance

Date: 2026-09-06. Beads: `ps-8ew`, its repair children, and final certification `ps-8ew.2`.

Baseline: `d620c43dba9f904e7c895c708a535ab5715fb4fc`. Runtime candidate: `48a3de5072b2cb95e3e5b8320cbb29f297abdc67`.
Branch: `fix/ps-8ew-reliability`. This report records local evidence; required CI is recorded separately against the
delivered PR head. Neither a local pass nor a stored Agent report establishes merge or installation.

## Repairs

Child Context now has one projection owner. Agents no longer deletes working history or rejects a request solely
because of its token estimate. Context Management and the existing Magic Worker handle projection and recovery; Pi
persists accepted input and compaction boundaries. The Magic patch retains signed reasoning and invalidates its cached
projection before rebuilding after compaction. Both defects were reproduced through the actual child Host hooks.

Isolated launches map a task directory relative to the repository root. The runner persists the resulting worktree cwd
in its recovery descriptor before launch, and cold resume reads that descriptor. Missing recovery data fails through
the runner's ordinary failure and cleanup boundary. A nested launch no longer duplicates the subdirectory or resumes
in the shared checkout.

Latched pause, stop, and timeout causes reach controls registered during startup and are checked before fallback.
Foreground recovery prefers the canonical final report when the completion file is absent. Background outcomes reach
the main Agent with bounded canonical findings and artifact references; receipt and Session identity govern delivery.
The main Agent can finish its original task without another user prompt. Goal remains the continuation-policy owner,
and closed, cancelled, replaced, or explicitly ended work cannot be restarted by a late result. A real Provider run
also exposed a late Goal settlement callback after Session teardown; the existing lifecycle guard now rejects it.

## Environment and boundaries

The checks used Bun 1.4.0 and certified Pi 0.85.1, released source
`d981de1229ef899957bbe968bc8dcda02a21f477`. Package certification used the official RTK 0.45.0 executable with SHA-256
`99e0cff729d52297a23eb832f809d9773ba7c32de818dfe76b2cdd900a951535`. Code Mode used the cached `rust-v0.145.0` V8 host,
binary SHA-256 `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`.

Deterministic Providers below exercise real Pi processes, Tools, Git worktrees, and the Magic Worker. Their injected
overflow responses do not establish a remote Provider capacity limit. Live runs used authenticated
`openai-codex/gpt-5.6-luna`; manual public RPC compaction is identified separately from actual remote overflow.
Temporary authentication copies and diagnostic Sessions are excluded from Git.

## Decisive scenarios

| Scenario | Evidence and result |
| --- | --- |
| Repeated child Context pressure | Real fresh and forked children pass two injected overflows through the actual Magic Historian. Eight intervening Tool calls, signed Assistant content, paired Tool IDs, prior findings, two completed-check identifiers, and steering remain usable in the final report. Combined child-pressure and existing recovery Host checks: 14 tests, 116 assertions. |
| Nested isolated launch and cold resume | Real background and foreground launches write inside `worktree/sub`; both pause, close the parent, reopen its Session, and resume through the public Agent Tool. Resumed writes stay in the retained directory, the prior file survives, and the shared checkout is unchanged: 2 tests, 14 assertions. |
| Startup and fallback cancellation | Production runner tests cover pause, stop, and timeout, inspect terminal results and actual writer side effects, and retain process-tree cleanup and targeted-child controls. The three between-attempt controls pass 10 assertions. Pause prevents a second writer; asynchronous stop/timeout may allocate a writer before the inbox request is consumed, but termination prevents its later file effect and success. |
| Completion recovery | Missing completion-file recovery returns canonical `finalOutput` ahead of later progress. Failure and partial results retain their classification. Completion-delivery tests also put a concrete final finding ahead of an obsolete progress summary. |
| Main-Agent result integration | The real PTY Provider receives the hidden child outcome, consumes its final summary, and creates `FINAL_DELIVERABLE_FROM_BACKGROUND_RESULT`. Busy/idle batching, duplicate receipts, Goal coordination, cancellation, Session replacement, and shutdown have focused regressions. |
| Live useful deliverable | A live Luna main Agent delegates a repository review, receives the child result automatically, performs its follow-up verification, and writes the requested report without a second user message. The final run exits cleanly with zero extension errors. |
| Live manual Context compaction | Twelve live reads build synthetic evidence. Public RPC compaction persists a genuine Magic boundary (`tokensBefore=79939`, estimated after=22002, ordinal=19); the following live final report recovers both earlier fact/check identifiers without being given their names again. This proves manual recovery of synthetic evidence, not a realistic completed-code-check identity or remote overflow. |
| Live coding review across repeated compaction | A fresh live child reads 14 distinct source files in 14 native read calls and runs one check command. Two public RPC compactions persist genuine Magic boundaries (tokens before: 41948 and 40810). The final report retains both initial code observations, their function/path evidence, the exact command, and 20 passing tests without rereading or rerunning the check. Raw Tool evidence is 20 pass, 0 fail, 118 assertions; the final model report does not retain the failure/assertion totals. There are zero extension errors and empty stderr. |
| Code Mode | Explicit real V8 execution passes 11 tests and 41 assertions, including nested Tool failures, image validation, replay, approval, and post-effect persistence failure. |
| Ordinary Tools, reload, and resume | Packed source-installation certification passes the existing real Pi RPC/PTY matrix, including successful and failed Tools, Goal reload, cold Tool resume, Agent execution, and the shared visible surfaces. |

## Validation and failed-run accounting

`bun run check:fast` passed formatting, lint, strict types, unused-code/dependency analysis, generated output, repository
safety, and Capability contracts. The final test additions were also typechecked. Tool Activity benchmark acceptance
passed. `bun run pack:verify` passed: one local Package, 600 files, Pi Host 0.85.1.

The required full test command ran all 298 discovered isolated files. Its initial result was 2,094 passing tests,
six failed tests across five files, and 13 skips. Every failure was diagnosed: obsolete projection/product assertions,
a missing persisted recovery descriptor in a worktree fixture, and PTY ordering/usage expectations that no longer
matched the fixture. The affected cases passed after correction. The newly added isolated-resume Host file then passed
separately. Goal's separate runner passed 318 tests and its runtime smoke scenarios. The 11 default-skipped V8 cases
passed when explicitly enabled. These are component results across the recorded runs; the initial full command did
not exit successfully.

The live coding evidence is `.artifacts/ps-8ew-acceptance/live-coding-{session.jsonl,rpc.jsonl,final.json}`.
The final model report says the omitted test totals were not shown, although the raw Tool result contains them; those
extra totals are established by the verifier, not claimed as retained model evidence. Check identity and its passing
outcome survive. An earlier coding harness used a wrong source path and stale Session cwd; its failed check and
inconsistent model summary were rejected before the fresh corrected run.

The first package run stopped because the local RTK executable had the expected version but the wrong certified
fingerprint. The verifier remained strict; the repeat used the already available official executable. An early live
diagnostic wrapper omitted `await` on the asynchronous Extension factory, which caused its own load failure. Correcting
the wrapper then captured the separate production Goal teardown defect; its regression and final live run passed.

Independent Standards and Spec reviews, plus the required maintainability review, found no unresolved blocker in the
final affected scope. The [fork adaptation audit](../research/pi-stuff-reliability-fork-audit-20260906.md) records the
matched upstream versions, retained adapters, removed protection, and replacement evidence. Physical source lines changed
from 546 to 0 for the deleted competing projector, 217 to 319 for completion handling plus 139 for pure report projection,
799 to 798 for the process engine, 567 to 591 for the child task runner, and 421 to 463 for the background runner.

Raw local logs are retained under `.artifacts/ps-8ew-acceptance/` and the adjacent `ps-8ew-*.log` files. The report does
not claim live remote-overflow acceptance, a resource benchmark, merge, installation, or publication of private logs.
Final Beads closure requires the delivered revision's CI and all declared scenarios; failed or missing evidence remains
explicit rather than being converted into a pass.
