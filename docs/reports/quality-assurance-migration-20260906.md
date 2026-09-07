# Quality-assurance migration — 2026-09-06

## Batch 1: command and execution boundaries

Baseline: `cac0e79a866c3973a1515a5044441e136f30652e`. This is checkpoint evidence, not final acceptance of the full
[migration design](../adr/0032-organize-quality-assurance-by-verification-purpose.md).

| Evidence | Before | Batch 1 |
| --- | --- | --- |
| `check` scope | Static checks, all tests, Tool Activity benchmark, archive/Host aggregate | Read-only static checks, including source Package validation |
| Ordinary test runner | Bun runner plus separately invoked Goal runner; arguments ignored | One selected file inventory; Bun and compiled Node files remain separate OS processes |
| Repeated Host verifier families | Ten already-tested families called again by Package aggregate | Ten calls removed; seven previously unique calls have primary test entries |
| Suite surface within Package aggregate | Twice, once before packing and once after | One inspector scenario; installed-source discovery is separate evidence |
| Package delivery evidence | Archive creation/extraction | Real `pi install`, isolated settings, then loading outside the checkout |
| Changed implementation/test source | 4,525 physical lines | 4,856 physical lines (+331) |

The source increase buys argument validation, reporting, live-profile boundaries, real installation evidence, and
proportional command tests. It does not add a dependency or a second product runtime. The largest touched files remain
below the 800-line gate; independent review assessed the files above 500 lines and found their responsibilities cohesive.

Focused execution on the local Linux x64 host, Bun 1.4.0 and Pi 0.85.0:

- Command previews, invalid selectors, benchmark discovery, source constraints, and a selected Goal Node test passed.
  Goal compilation ran once before selected Node execution; the Node test reported 6.64 ms for three cases.
- Source installation passed in 3.29 seconds. The retained Suite inspector, Web fixture, Goal lifecycle, Notification
  PTY, and Host seams passed in 52.02 seconds combined. MCP PTY passed in 17.78 seconds; RTK PTY passed in 7.48 seconds.
- Benchmark command tests passed in 6.80 seconds, source Package tests in 0.11 seconds, and Effect comparison-tool tests
  in 7.52 seconds. Tool Activity completed with a local JSON report and no gating on comparative timing values.
- `bun run check` passed after integration. No live model benchmark was run. Two consecutive independent
  Thermo-Nuclear reviews reported no findings against the final checkpoint source.

These timings have different scopes; they are not additive full-suite timing or a claimed before/after speedup. Baseline
and final full CI comparisons remain part of the final migration evidence. Local JSON reports are under ignored
`.artifacts/tests/`; benchmark reports are separate artifacts.

## Batch 2: test classification and reduction

Base: `f506b4f1` (Batch 1 checkpoint); this is the reviewed Batch 2 checkpoint. The current test
inventory is 332 files (331 offline and one explicit live file): 130 Component, 159 Component Integration, 2 System, 10 System Integration, and 31 Acceptance.
The directory map is `level/capability/scenario`; helpers remain in neutral `test/<legacy-capability>` locations. The
Goal smoke was renamed to `test/component-integration/goal/goal-runtime.test.mjs` and uses native Bun scenarios. The
21 remaining `.node.ts` files retain the Node compatibility boundary and compile once before execution.

The runner now exposes `--level`, `--capability`, `--file`, and `--name` selection. Repeated selectors in one dimension
union; different dimensions intersect. `--name` is a native regex candidate filter and does not scan source names.
Unknown arguments and empty explicit selections fail. The default profile is offline; live execution requires explicit
`--profile live`, with `magic-context-live` as the only live Magic Context wrapper. `--list` reports requirements
without setup. Reports under `.artifacts/tests/` include actual file/process durations and setup duration; zero actual
tests is nonzero, including Node compatibility runs.

Code Mode RPC and TUI offline Acceptance wrappers use the real Host and fixture Provider. The Agent ran Code Mode RPC in 8.33 s and TUI group/failure/media/cancel behavior in 113.48 s, with resume widths 100 and 64.
Goal native name selection (`normal continuation`) took 0.52 s; a native Unit selector ran three tests in 1.2 s. A
Node no-match selection failed with zero tests as intended. Static checks and focused command, native-tool, Node compatibility, and real Code Mode acceptance checks passed. Two consecutive independent Thermo-Nuclear rounds reported no findings against the complete diff. The official Code Mode executable installed in local artifacts has SHA-256
`60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`; the compatibility row records this identity.

Real RTK scenarios require the certified executable; explicit absence is a failure. Current preflight is
implemented in the shared test-environment helper. The 150 ms first-UI/input/selection targets and
200 ms unchanged-spinner target remain explicit PTY requirements; the 500 ms severe-stall assertion remains a separate
backstop. Stable focused certification is still pending. No full test suite, final CI/affected selection, or live Magic Context call was run for Batch 2. Batch 3 remains responsible
for affected selection and CI orchestration.


The generator test no longer freezes three wrapper statements or Goal's exact multiline formatting. Semantic Capability membership, Suite loader behavior, and real source-install acceptance remain.

Paired same-host focused runs (single samples, including Bun startup): generator `0.185 s` before / `0.168 s` after; Suite loader `0.573 s` before / `0.504 s` after. Both passed on the clean baseline and this worktree. These small differences do not establish an overall speedup. Changed JavaScript/TypeScript source totals 79,366 physical lines before and 79,824 after (+458); file moves preserve most of that source.

The Web direct-Provider redirect-declaration guard now runs with Static Checks; a small Component test protects the AST-based declaration count. This retains the previous parity constraint without claiming request-data-flow proof. Codex native Tool checks no longer skip unsupported/missing executables and passed three cases through the real local binaries. Missing Pi preflight was verified to leave the scenario unexecuted and emit an explicit failure report.

## Batch 3: affected-test selection and CI orchestration checkpoint

Base: `35225c57` (Batch 2 checkpoint). Batch 3 has signed checkpoints and draft PR #230; this section remains checkpoint evidence until final offline and hosted acceptance completes. The pre-merge inventory at `9dd54c24` was 334 files: 333 offline and one explicit live file. Offline files by level are Component 132, Component Integration 159, System 2, System Integration 10, and Acceptance 30. The increase from Batch 2's 332 files (331 offline) reflects one replacement with three Batch 3 planning, execution-contract, and CI-aggregate test files; the historical Batch 2 counts above remain unchanged.

Batch 3 implements conservative local and CI scope selection. Local `verify` uses the merge base between `origin/main` and `HEAD` by default, unions committed, staged, unstaged, and untracked paths, and accepts `--base <ref>`. The planner parses TypeScript imports with an AST and walks reverse dependencies through test helpers; `.js` imports resolve to corresponding `.ts` sources. Shared infrastructure, unknown paths, dynamic or opaque imports, unresolved dependencies, and deleted paths fall back to all offline Tests. A narrow no-tests plan is allowed only when current, index, `HEAD`, and comparison-base contents prove that Markdown or Beads metadata contains no executable fence or script material. `--list` previews base, head, reason, selected files, and environment requirements; `--help` performs no work and unknown options fail. A normal run performs read-only Checks, then selected offline Tests, and writes a timestamped summary containing the plan, statuses, duration, and evidence paths.

The CI workflow is `Plan`, `Checks`, `Tests`, and `Verify`: Plan selects PR target ranges or main-push before/after ranges, while manual dispatch selects all offline Tests. Checks runs independently, Tests waits only for Plan, and Verify validates the plan, every required job result, exact selected-file coverage, and the structured test report. Plan and test reports are separate artifacts; Verify does not rerun substantive work. Only superseded runs for the same PR are cancelled; distinct main-push revision ranges remain. Branch protection is unchanged.

The source-size comparison uses the 23-file JS/TS path set from the `35225c57` to `c0403212` git diff, including new untracked source paths and excluding artifacts: 4,275 physical lines became 5,181 (+906). This is a changed-path comparison, not whole-repository size or a speedup claim.

The latest full `bun run check` passed. Earlier focused evidence recorded 31 passing tests; the subsequent six-file focused results are recorded below. Two consecutive independent Thermo-Nuclear reviews of the final repair scope reported no findings. A second full offline run executed all 333 files and 2,459 native cases with zero skips in 1,131.173 seconds, plus 5.670 seconds of setup. Two files failed: the Magic multi-step scenario expected two requests but observed three, and the UserMessage regular/dark scenario timed out waiting for acknowledgement while input remained in the editor. The three failures from the first full run now pass. Preserved logs prove the Magic third request was a SessionNaming prompt triggered by invalid partial settings that enabled fallback; the existing `disableSessionNamingForTest` helper fixed the fixture, and the Goal retry branch received the same repair using the `DEFAULT` spread. Ten before/after Magic repeats changed from 5 pass / 5 fail in 62.85 seconds to 10 pass / 0 fail in 65.65 seconds, retaining the exact two-request assertion. The UserMessage failure came from inline Skill autocomplete consuming Enter; sending Escape before Enter preserves submission. Subsequent four-mode/theme results are recorded below.

The hosted CI repair set includes a feature guard for the unsupported tmux 3.4 Goal option; the MCP assertion now waits for the Host completion marker `Reloaded` rather than the startup `Welcome` marker; the Code Mode outer CI deadline increased from 180 to 300 seconds with per-arm progress; and the obsolete old-envelope benchmark was removed from Acceptance together with legacy fixture flags. ADR 0009's explicit current 20% schema/input and cumulative gates remain, as do all 32 TUI arms. Hosted run `34013094628` used an older HEAD; its completed results are recorded below. Baseline main CI remains non-equivalent where it skipped Acceptance; no speedup claim is made.

The six-file focused run subsequently passed Magic recovery, all four User Message mode/theme combinations, Goal lifecycle, Goal PTY, and MCP PTY. Code Mode failed on its first cold startup with a missing Context adapter; the verifier now waits for a displayed Context percentage before input instead of sleeping 750 ms. Three complete repetitions then passed all 96 TUI arms in 267.97 seconds. This establishes the observed fixture behavior; the original registration failure did not retain enough diagnostic detail to establish an underlying product defect.

Hosted run `34013094628` completed all 333 files with 2,459 native cases and zero skips, taking 1,693.223 seconds plus 12.878 seconds of setup. It failed Code Mode's old 180-second deadline, Goal's tmux option, MCP reload synchronization, and a Tools liveness fixture waiting for its ready event. The last failure happened before response-time measurements and remains unresolved: the old verifier discarded the request log and terminal frame. The verifier now includes both in failure output; the unchanged liveness requirements passed locally in 59.18 seconds. The disconnected focused run passed both complete files: Code Mode in 95.86 seconds and Tools in 58.54 seconds. Updated hosted CI remains pending. The aggregate correctly failed this run.

## Reusable diagnoses

**RTK setup identity:** the maintainer's default executable failed the certified SHA-256 check. This was an environment
failure, not a timing regression or flaky test. Downloading the official 0.45.0 release into local artifacts and verifying
both the archive and executable hashes allowed the unchanged RTK scenario to pass with explicit `RTK_BIN`. Do not
weaken the identity check or treat an unrelated local RTK version as certified evidence.

**Removed-call audit:** filename similarity was insufficient to prove duplicate coverage. MCP and RTK PTY calls had no
test caller and were restored before the checkpoint. All 17 former aggregate calls were then matched to actual call
sites and their dimensions/defaults; the removed ten families already include the original scenarios.

**Migrated root paths:** checking that an intermediate directory exists was insufficient: `test/` exists but is not the repository root. The complete run caught UI Package loading and RTK provenance reads resolving from old locations. Both retain their original assertions and now resolve the actual source tree.

**Embedded-status snapshots:** the original intermittent failure lacked raw ANSI evidence, so its exact frame transition cannot be reconstructed. The test took plaintext and ANSI from different captures. It now waits for and asserts one ANSI snapshot, derives visible text from that same frame, and includes raw snapshot data on failure. Passing retries alone were not accepted as a repair; Host rendering and the asserted colors were unchanged.

**Repeated reload synchronization:** the next full offline run executed 333 files and 2,459 native cases with zero skips in 1,153.368 seconds, plus 6.177 seconds of setup. Only User Message fullscreen/dark failed: repeated `/reload` matched a previous `Reloaded` snapshot and sent the new-Session action before the latest reload completed. The fixture now waits for a fresh Session inventory record before the completion marker and waits for the third response before its first reload. All four mode/theme combinations passed five repetitions each: 20 pass, zero fail in 118.65 seconds. Static checks passed; integration with concurrent main changes and final full verification remain pending.

**Concurrent main integration:** merged `dfd0d209` into the QA branch, retaining native Context Worker closure, Work idle synchronization, and commit-bound delivery evidence. The new Beads delivery test moved into Component/repository, bringing the combined inventory to 335 files (334 offline, one live). Delivery reads the current Plan/Checks/Tests/Verify results; a verified no-tests plan is explicitly reported as not run. The obsolete PR-path reclassification request was removed. Fifteen focused delivery/publication cases and the full static check passed during integration. Final revision-bound CI evidence is recorded in PR #230 and the managed Beads delivery comment.

**CI job budget:** run `34015134858` on `9dd54c24` reached file 270/333 without test failures before the inherited 30-minute Tests job timeout cancelled it. Code Mode and both Tools PTY geometries passed in that run, but no final test report was produced and Verify failed. The Tests job budget is now 45 minutes based on that observed full-scope cost; test requirements and per-scenario assertions are unchanged. This is environment/execution-budget repair, not a speedup.
