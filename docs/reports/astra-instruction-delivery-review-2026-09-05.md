# Astra instruction and delivery review — 2026-09-05

The instruction migration reduces repeated reading, verification, and completion rules while retaining Pi ownership,
source-quality limits, real-Host acceptance, and the Beads delivery contract. It does not change runtime model defaults.

## Basis and scope

[OpenAI's Astra guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices) recommends
reviewing Agent instructions and skills for conflicting guidance and calibrating clarification, delegation, output,
and testing to the workflow. The local change emphasizes autonomous completion of authorized work and risk-based
verification. It introduces no model-specific configuration or API migration.

The reviewed instruction chain includes root AGENTS, code quality, compatibility, contribution guidance, the tracked
Beads skill, issue tracking, ADR 0032, and their Chinese mirrors. Global Codex instructions and installed skills remain
outside the edit boundary. In particular, global delegation rules still prescribe roles, context inheritance, and
waiting; changing repository instructions does not remove those global rules.

## Verification decisions

| Finding | Decision |
| --- | --- |
| A local full check followed by equivalent CI repeats execution | Run focused development checks and reuse required CI evidence for the same revision |
| Fixed clean-review rounds repeat a completed judgment | Review the complete affected scope once; fix findings and revisit the changed and affected scope |
| Package and Module READMEs unnecessarily triggered Acceptance | Extend the existing prose whitelist; retain full checks for runtime resources and unknown changes |
| A rename could hide executable source behind a prose path | Classify both old and new paths in local CI and PR publication |
| Tool Activity thresholds and duplicate Host starts need deeper evidence | Retain existing benchmark and source/extracted-Package verification; do not remove protection based on cost assumptions |
| Validation text could claim checks that never passed | Verify the target commit against the actual CI workflow and exact run attempt before publishing |

The isolated test runner is serial and starts a fresh process per file. Package verification also runs real Host/PTY
scenarios against source and extracted content. These are cost indicators, not measured bottlenecks. This review does
not claim elapsed-time improvements or eliminate the different defects caught by those layers.

## Delivery enforcement and limits

The publisher requires successful applicable jobs from the latest eligible CI workflow run for the target commit.
PRs use their current head and the complete file list; branch-only records put the final target last. Documentation
PRs and direct pushes retain Fast-only policy, while manual runs require both checks. Missing or failed required
checks block publication. The comment links the Actions attempt, and exact comment/Issue readback remains mandatory.

CI evidence does not establish review quality, commit signatures, branch protection, merge authorization, or live
Provider acceptance. Those remain explicit criteria where applicable. No-code work needs its existing evidence and
reason, rather than fabricated CI. Missing historical Actions evidence blocks re-certification when republishing.

## Validation at implementation

- The focused publisher, CI-evidence, and scope tests passed: 19 tests, 0 failures.
- The complete `check:fast` passed, including repository safety and translation SHA validation.
- Read-only checks against real GitHub Actions accepted a successful direct-push Fast result and rejected a known
  failed run. No publication or merge claim is inferred from those historical records.
- Final review, branch CI, and public delivery evidence are recorded with Bead `ps-8l7`; this report does not substitute
  for their terminal results.

## Physical line counts

Counts compare the source revision `6ddb5cfa` with this implementation snapshot. Added validation protects an external
trust boundary; smaller instruction files are not a reason to omit required evidence.

| File | Before | After |
| --- | ---: | ---: |
| `AGENTS.md` | 85 | 54 |
| `docs/code-quality.md` | 59 | 41 |
| `.github/CONTRIBUTING.md` | 42 | 31 |
| `.agents/skills/beads/SKILL.md` | 65 | 31 |
| `scripts/publish-beads.ts` | 266 | 298 |
| `scripts/beads-delivery-checks.ts` | 0 | 75 |
| `scripts/ci-acceptance-scope.ts` | 60 | 70 |
| `test/publish-beads.test.ts` | 222 | 298 |
| `test/beads-delivery-checks.test.ts` | 0 | 90 |
| `test/ci-acceptance-scope.test.ts` | 30 | 43 |

## Acceptance follow-up — 2026-09-06

The first [branch Acceptance run](https://github.com/jczhang02/pi-stuff/actions/runs/33976280826) passed Fast but failed
`test/goal-pty.test.ts`: Ubuntu's tmux 3.4 rejected `extended-keys-format`. The Goal verifier was the only matching
PTY setup that set this optional option without probing. The same test reproduced the error locally with real tmux
3.4 in under one second. Reusing the existing server-option probe fixed it; the complete Goal PTY test then passed on
both tmux 3.4 and 3.6a with Pi 0.85.0. This repairs verification setup without changing Goal behavior or assertions.

The [next run](https://github.com/jczhang02/pi-stuff/actions/runs/34000105818), on `1724b346`, passed Fast and Goal PTY
but failed the Context multi-step recovery scenario: the fixture recorded three Provider requests instead of two.
Two focused local runs then failed and passed respectively, confirming an intermittent failure. The count reflects
actual requests, not matching escaped request text. This change does not modify that scenario or the Context runtime;
the extra request's cause remains unresolved. Other isolated test files passed, but the failed test stopped the later
acceptance stages. PR 228 remains a draft and unmerged; full acceptance and verified delivery remain incomplete.

## Instruction follow-up review — 2026-09-06

A second review used the current [Astra prompting guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)
and compared the full branch against `cfee220c`. Independent Standards and Spec reviews found a remaining instruction
conflict: CONTRIBUTING still prescribed development checks without the documentation exception. It now points to the
owning verification policy, including evidence reuse. Suite generation is conditional on composition changes, and
ordinary offline tests are distinguished from explicitly selected live acceptance.

AGENTS now makes user-instruction priority, existing authorization, and continuation after follow-up messages explicit.
A skill-induced pause must cite the file and rule and distinguish a requirement from interpretation. The quality
document brings the accepted failure-diagnosis policy into the active workflow and retains independent review for
cross-Capability or architecture changes without prescribing Agent scheduling.

For this follow-up, AGENTS grows from 54 to 57 physical lines, CONTRIBUTING from 31 to 32, and code quality from 41 to
46. The added rules address identified ambiguity and failure handling; the verification commands have one owning policy.

The code review's suggested extra PR SHA-format check was rejected with direct source evidence: `readBead()` validates
every delivery SHA, and `deliveryLines()` requires the PR head to belong to that validated list before querying CI.
No executable changes were needed. Instruction review and mirror/SHA checks cannot establish model behavior or resolve
the Context acceptance failure above; no behavioral performance improvement is claimed.

## Merge acceptance diagnosis — 2026-09-06

Retained request and Session records identified the extra call as Session Naming: its prompt started with a request to
name the coding session, and the Session ended with `pi-stuff-session-naming-state`. The recovery test wrote only
`enabled: false`, which fails the namespace schema and activates built-in defaults. The test now uses the existing
`disableSessionNamingForTest()` helper. The Goal lifecycle retry verifier had the same incomplete override and now
preserves the default settings fields when disabling naming. Provider matching and recovery assertions are unchanged.

This resolves the configuration cause of the earlier intermittent count; completion still requires validation of the
final revision. The recovery test and Goal lifecycle verifier each gain one import line; no runtime code changes.

The [next CI run](https://github.com/jczhang02/pi-stuff/actions/runs/34009462730) passed Context recovery but exposed a
separate Background Work PTY race. The terminal showed the Host rejecting `/reload` because its response was still
running: seeing `MONITOR_RESUMED` text does not establish idle state. The fixture now exposes a command that awaits
Pi's public `waitForIdle()` and reports readiness before the verifier sends `/reload`. This preserves reload assertions
and avoids a timing sleep. The verifier grows from 267 to 269 lines and its Provider fixture from 101 to 107.

[CI 34010463889](https://github.com/jczhang02/pi-stuff/actions/runs/34010463889) passed those scenarios but exposed a
schema-migration lock race. Bun's native `Worker.terminate()` returns no Promise, so awaiting that call let release
finish before the Worker closed. A native-Worker regression test reproduced this ordering failure. The existing
transport now observes `close` from Worker creation and awaits it after requesting termination, including when exit
has already happened. This changes the resource-release boundary, not database retry policy or migration assertions.
The transport grows from 258 to 262 lines and its tests from 341 to 354.
