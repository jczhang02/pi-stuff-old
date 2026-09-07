# Pi Stuff reliability fork adaptation audit

Date: 2026-09-06.
Scope: ps-8ew.1; Context/Goal compaction and continuation, Code Mode nested Tool Display, and Conversation UI Host adapters.
Baseline: `48a3de5072b2cb95e3e5b8320cbb29f297abdc67` (signed Pi runtime commit, Pi 0.85.1); current audit source is the uncommitted candidate in this worktree.

This is a bounded source/history audit. It does not certify a live Provider or the combined repair candidate. The
whole-Agents diagnosis recorded in `ps-qbn` is reused, including its deterministic evidence-loss replay and its
follow-ups `ps-81j`, `ps-sfx`, `ps-q2k`, `ps-gaz`, and `ps-tgj`.

Confirmed certified-Host evidence is available from `bun test test/agents/child-context-pressure-host.test.ts
test/context/magic-recovery-host.test.ts`: 14 tests, 0 failures, 116 assertions in 73.21s on Pi 0.85.1 (log:
`.artifacts/ps-8ew-acceptance/context-host.log`). It uses production `buildPiArgs`, the actual Magic Worker/Historian,
fresh and branched seeded histories, two real overflow recoveries, eight intervening Tool calls, steering, and final-report
assertions for prior findings and completed-check IDs. The dependency
patch is now SHA-256 `0c75ef8e484250b614d1650dfc772d3e66f3d83f9fc4478d863de9bd7d4044d2`. This deterministic Provider
fixture proves production control flow and protocol preservation. A separate live Provider background run on Pi 0.85.1
(`openai-codex/gpt-5.6-luna`, medium) completed the main final deliverable and clean teardown (0 extension errors); logs:
`.artifacts/ps-8ew-acceptance/live-provider-wrapper-final-20260906.log` and empty `stale-handler-final.jsonl`. This does
not claim remote live overflow.

A separate live manual Magic compaction/recovery on Pi 0.85.1 recovered prior finding and check markers after a public
RPC compaction (`tokensBefore=79939`, `estimatedAfter=22002`, `lastCompactedOrdinal=19`). This is synthetic evidence for
manual compaction and evidence retention; it is not remote live overflow, realistic code-check identity, or combined
acceptance.

## Dispositions

| Seam and owner | Intended behavior and local delta | Evidence and disposition |
| --- | --- | --- |
| Context Management (`packages/pi-stuff/src/context-management`); Context owns projection, Magic owns compaction, Pi owns persistence/retry | The pinned Magic Context 0.41.1 artifact (`cbfac49f…`) runs in an internal Worker. Local patch `patches/@cortexkit%2Fpi-magic-context@0.41.1.patch` supplies tokenizer resolution/preload, image-hash reuse, retained-summary identity, durable overflow completion, signed-reasoning preservation, and pre-hook cache invalidation. Local history `673e6a8b`, `911f686e`, and `143b7e5f` deliberately removed native fallback and estimate-only interruption while retaining the public Host hook. The current candidate removes Agents `continuation-context.ts` and its estimate gate/projector, returning child pressure to Context Management/Magic. | `test/agents/child-context-pressure-host.test.ts` exercises production launch and actual Magic Worker/Historian over two fresh/forked overflows with intervening Tools, steering, findings, completed-check IDs, and final-report placement. Earlier failures (signed reasoning erased; retry used stale cache) are fixed in the existing dependency patch and the test now passes its fresh/final-placement cases. `test/context/core-provider-boundary.test.ts`, `core-compaction.test.ts`, and the existing recovery Host suite cover estimate, cancellation, restart, stale-result, and no-fallback controls. **Keep** the audited Magic patch and boundary under documented removal triggers. **Restore the single-owner boundary**: do not reintroduce an Agents estimate gate or competing emergency projector. Live pressure capacity remains unproven; background clean teardown is covered by the separate live run. |
| Goal (`packages/pi-stuff/src/goal`); Goal owns continuation and terminal policy | Upstream `pi-extensions` `v0.48.0`, `f0963e4c…`, supplies the state machine, queue/RPC, persistence, and tests. Local commits `b0663fab`, `b10f94be`, `a3c0f79c`, and `3789e99e` adapt presentation to the shared Dialog, preserve terminal usage/budget and final response, resume after native compaction, and avoid ordinary automatic/no-progress limits while retaining the emergency backstop and explicit limits. | `test/goal-upstream/goal-terminal-tools.node.ts` covers goal identity, escaped continuation, structured completion evidence, repeated blocker evidence, stale replacement, and terminal usage. `test/ui/command-dialog-attribution.test.ts` covers waiting for Goal continuation before refresh. **Keep** local policy. **No new defect found** in this bounded review; do not restore upstream UI kit or aggregate quotas. The remaining combined completion/race proof belongs to `ps-8ew.2` and `ps-8ew.3`. |
| Code Mode and nested Tool Display (`packages/pi-stuff/src/code-mode`, `packages/pi-stuff/src/tool-display`); Code Mode owns nested execution; Tool Display owns presentation | Code Mode is derived from `howaboua-pi-stuff` `b3591d99…` and Cloudflare `@cloudflare/codemode` 0.5.1. It deliberately re-enters public Pi Tool preparation/validation/lifecycle and keeps the envelope silent; Tool Display derives from `pi-tidy-tools` 0.4.1 `4b251377…`, retaining result-first summaries but using native Pi 0.85.1 definitions and bounded semantic presentation. Local history `6d0507c1`, `5c64f803`, `682d6f4d` bounds synchronous presentation and makes ledger state truthful/replayable. | `test/code-mode/ledger.test.ts` passes replay, approval, exact large results, post-effect failure, duplicate/stale settlement, rollback, and no execution quota. With the existing cached certified `rust-v0.145.0` host, `PI_STUFF_CODE_MODE_REAL=1` ran `test/code-mode/v8-real.test.ts`: 11 tests, 0 failures, 41 assertions in 855ms (binary SHA-256 `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`; log `.artifacts/ps-8ew-v8-real.log`). The default gate still skips these tests when the flag is absent. **Keep** the adapter boundaries and bounded presentation; network-service behavior remains outside this evidence. |
| Conversation UI (`packages/pi-stuff/src/conversation-ui`); UI owns projection, Pi private methods stay behind version-checked adapters | Unicode/chart source is absorbed from `pi-unicode-charts` 0.1.0 `8d63d300…`; native user-message insertion/replay and status/thinking adapters were introduced in `5c653a43`, `6a0d9367`, `6770c76e`, and compatibility commits `1844ed86`/`d620c43d`. The delta removes competing transformer/UI registrations, restores native methods on shutdown, and contains projection failures while preserving canonical Session messages. | `test/ui/user-message-display.test.ts` covers overlapping owners, incompatible Host rejection, failure containment/retry, and replay adoption; `test/ui/conversation-markdown.test.ts` covers public transformer registration/failure; `test/ui/statusline-rendering.test.ts` covers events-only adapters, recovery state, unknown usage, and narrow widths. **Keep** the version-bound private Host adapters; no uncovered behavior regression found. Real TUI certification remains the release gate, not these unit tests. |

## Removed protection and upstream comparison

Commit `513f74b6` removed `context-management/work-continuity.ts` and its completed-verification retention assertion,
while retaining `subagents/src/runs/shared/continuation-context.ts` emergency history deletion. The removed assertion was
the regression detector for completed-check authority. This is a real protection loss and is owned by `ps-qbn`; passing
static checks or the current small-payload tests cannot justify it. The `ps-qbn` replay showed 41/100/801-message
histories collapsing to four messages under the local estimate/emergency projection, while the counterfactual without
raw signature fields retained the history. That counterfactual does not authorize removing Provider-required signatures.

Pinned released `pi-subagents` 0.65.1 commit
[`83be9c3de2cde1553c0269f383efc1eb1194dc8b`](https://github.com/nicobailon/pi-subagents/tree/83be9c3de2cde1553c0269f383efc1eb1194dc8b)
contains child-hook sanitation for parent-only messages and Tool IDs, but does not contain Pi Stuff's
`projectChildContinuationContext`/`emergencyProjection` strategy. Upstream provenance therefore cannot justify local
history deletion or the lost assertion.

The current candidate removes that Agents-owned continuation-context seam entirely; this audit treats the historical
deletion as repaired by ownership removal, pending confirmation that Context/Magic preserves required evidence in every
integrated route.

Matched fork comparison at the same released commit is concrete: upstream's `test/unit/fork-context.test.ts` and
`test/integration/fork-context-execution.test.ts` exercise persisted-parent/leaf preconditions, per-index branch files,
Anthropic signed-thinking removal, thinking downgrade, and explicit-fork fail-fast behavior. The local
`test/agents/fork-context.test.ts` passes the signed-thinking case, while local `test/agents/foreground-engine-context.test.ts`
passes raw-versus-projected fork choice, heterogeneous fallback ordering, and persisted-branch measurement. The local
candidate therefore has a demonstrated adapter delta (Pi Host session/worktree and model fallback integration), not a
reason to inherit upstream's unrelated UI/runtime. The current local run passes the replacement Context-owned child-history
cases, but it does not prove live Provider convergence or upstream integration equivalence.

The relevant released source records are [pi-extensions `f0963e4c`](https://github.com/narumiruna/pi-extensions/tree/f0963e4c343124a6f1419163b0425f571282c9b0),
[Code Mode source `b3591d99`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/b3591d996efbf6df293e426dea2bb2dd17fcbfe6),
and the local module provenance files [Context](../../packages/pi-stuff/src/context-management/UPSTREAM.md),
[Goal](../../packages/pi-stuff/src/goal/UPSTREAM.md), [Code Mode](../../packages/pi-stuff/src/code-mode/UPSTREAM.md),
[Tool Display](../../packages/pi-stuff/src/tool-display/UPSTREAM.md), and [Conversation UI](../../packages/pi-stuff/src/conversation-ui/UPSTREAM.md).

## Verification limits

Focused deterministic Context, Goal, nested-ledger, and UI tests passed through the cases listed above: the latest scoped
command ran 78 tests with 78 passes and 375 expectations; certified V8 Code Mode separately passed 11 tests with 41
assertions. The certified child-pressure/recovery command separately passed
14 tests with 116 assertions. The live background Provider run completed its final deliverable and clean teardown; it is
separate from pressure-compaction evidence. The Goal `.node.ts` runner is recorded from existing evidence
rather than included by Bun's default file discovery. The default Code Mode gate skips V8 tests unless
`PI_STUFF_CODE_MODE_REAL=1`; the explicit certified-host run passed as recorded above. No remote live overflow
certification, realistic code-check identity, resource measurement, or combined
post-repair certification was
performed. The audit recommends **keep** for documented adapters, **repair/verify** Context-owned child evidence
continuity in `ps-qbn`, and **defer final acceptance** to `ps-8ew.2` after the integrated candidate and certified Host are
identified.
