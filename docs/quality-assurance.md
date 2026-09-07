# Quality assurance

Static Checks validate source without running product scenarios. Tests establish behavior through their declared seams.
Capability Benchmarks measure performance or effectiveness independently of verification gates. Reviews assess
requirements, design, security, maintainability, and the usefulness of that evidence.

The [tests directory guide](../tests/README.md) maps the five levels, shared fixtures, and pinned benchmark inputs.

## Current commands

```bash
bun run check
bun run fix
bun run test --list
bun run test --level acceptance --file repository/source-install.test.ts
bun run test --level component-integration --file goal/goal-runtime.test.mjs
bun run test --level acceptance --capability code-mode --matrix representative
bun run verify --keep-going
bun run benchmark:capability:ponytail --help
bun run benchmark:suite:terminal-bench --help
```

`check` runs formatting, lint, all TypeScript profiles, dependency/unused-source analysis, generated composition,
repository safety, the Capability Contract Catalog, and static Package/resource/license validation, and Python adapter syntax. It does not rewrite
source or execute Benchmarks. `fix` explicitly applies formatting and safe lint fixes; generated composition and
snapshots have separate explicit update operations.

`test` currently discovers 340 files (339 offline and one explicit live file) under five levels: Component (`unit`),
Component Integration (`component-integration`), System (`system`), System Integration (`system-integration`), and
Acceptance (`acceptance`). The offline inventory is 139 / 160 / 2 / 10 / 28 files by those levels. Within each level,
files are grouped by Capability directory and scenario. It runs one OS process per file. The Goal runtime smoke is a
native Bun test; the other 21 `.node.ts` compatibility files are compiled once and then run through Node. Repeated
selectors within one dimension are a union; different dimensions are an intersection. `--name` uses the native test
runner's regex candidate filter and does not scan source names. `--help` and `--list` execute no scenarios. Reports
default to timestamped JSON under `.artifacts/tests/`; `--output <path>` changes the destination. The report records
selected files, status, process duration, setup duration, and the Acceptance matrix. A failing or empty selected run returns nonzero.

Tests stop remaining files on the first failure, including missing native execution evidence. `--keep-going` collects
all selected-file outcomes without turning failures into success; `verify --keep-going` also runs Tests after a failed
Checks command. Reports are persisted before each file and after its result. They distinguish completed results,
not-started files, and the last recorded in-progress file if execution is interrupted. Missing, cancelled, or incomplete
evidence never passes CI aggregation.

The default profile is `offline`: deterministic fixture Providers, no credentials, and no live model calls. Real Pi,
Node, Code Mode, RTK, Expect, tmux, and local system tools are still required where a scenario uses their public
boundaries; missing required tools fail preflight or the scenario. Live Provider and Service evidence requires explicit
`--profile live`; the only live Magic Context scenario is `magic-context-live`. Fixture Provider evidence is not live
acceptance. `--list` reports tool requirements without setup or execution.

Pi and RTK are resolved from explicit `PI_BIN` / `RTK_BIN` overrides, then `PATH` (excluding package-manager `node_modules/.bin` directories for Pi, which expose the development SDK CLI).
Existing supported installations,
including RTK source builds and shims, are reused. Local commands do not download or reinstall them. Preflight reports
the selected path and distinguishes missing programs, non-executable files, wrong versions, and failed version probes
before running dependent tests. Fixed Pi/RTK executable hashes are not admission gates. A clean CI runner prepares its
dependencies separately; download-integrity checks do not replace real behavior tests. RTK PTY fixtures execute the
exact `RTK_BIN` selection even when its filename is not `rtk`.

## Source installation and retained evidence

Static Package verification checks source/resources, declared external dependencies, native Tool executability, and
license/provenance records. Distribution archives are not a delivery requirement.

`tests/acceptance/repository/source-install.test.ts` runs the certified Pi `install` command with isolated Settings and
XDG directories, then starts Pi outside the checkout and observes commands loaded through the installed Package
setting. It never changes the maintainer's installation. The installed process and temporary environment are cleaned up.

The former package-verification aggregate repeated Host/PTY scenarios already owned by test files. Those repeated calls
are removed. Distinct source-install, Suite inspection, Host seams, and dependency interoperability now have primary
homes under the applicable level and Capability directory. Existing RPC and PTY tests remain where they observe
different contracts.

## Benchmarks

Existing experiments are named `benchmark:capability:<name>`. Ponytail behavioral effectiveness, Markdown, lifecycle,
Magic Context, and Tool Activity are Capability-scoped questions.
Using a complete Host does not establish complete-Suite public-task outcomes.

Use each command's `--help` or `--list` before execution. Ponytail experiments require `--profile live`; their help and
previews do not use credentials. Historical reports remain dated evidence; newly generated reports use local artifacts unless an output is explicitly selected.
The retired Effect/mainline, Code Mode image, and Skill Discovery experiments remain available in Git history;
their dated reports and locked inputs are retained as historical evidence.

Completed experiments may report poor scores or performance regressions without failing the command. Setup failures and
incomplete experiments remain failures. Tool Activity's former 250 ms and relative 25 ms benchmark values are retained
as diagnostic report values rather than verification gates. The explicit PTY requirements remain 150 ms to first Tool
UI/input/selection feedback and no unchanged Vibe Line Spinner frame beyond 200 ms; ADR 0025's 500 ms severe-stall
assertion is a separate backstop. The Tools PTY verifier reports the measured values for each terminal geometry and
fails when a required target is unmet.

The Suite Outcome Evaluation branch evaluates the complete Suite on public tasks. The concrete entry is
`benchmark:suite:terminal-bench`; the generic `benchmark:suite` alias remains unregistered.

### Local Terminal-Bench evaluation

```bash
bun run benchmark:suite:terminal-bench --help
bun run benchmark:suite:terminal-bench --list
bun run benchmark:suite:terminal-bench
bun run benchmark:suite:terminal-bench --worktree .worktrees/my-change --task regex-log
bun run benchmark:suite:terminal-bench --resume .artifacts/terminal-bench/<evaluation>
```

Execution explicitly starts a live evaluation using Harbor 0.22.0 and local Docker-compatible containers. It never
uploads results or uses Runta. The default is the pinned Terminal-Bench 2.1 dataset, all 89 tasks, one attempt per task,
and two concurrent containers. `--task` selects exact names and the flag may be repeated for different tasks; `--repetitions` and `--concurrency` accept
positive integers. A single repetition is a local observation, not the official five-trial leaderboard protocol.
Help and task previews require no credentials and start no setup, containers, or model calls. Benchmarks never run as
part of `check`, `test`, or `verify`.

The evaluated source defaults to committed local `main`, independently of the command's checkout. `--worktree <path>`
selects a registered worktree from the same repository, including its uncommitted Package source and dependency inputs.
The runner freezes `packages/pi-stuff`, the root package manifest, Bun lockfile, and patches before execution. It excludes
unrelated engineering files and rejects private paths and escaping or absolute symlinks. Later edits cannot affect the
remaining tasks. A fresh `--output <directory>` changes the default local artifact directory.

The installed certified Pi Host, Bun, RTK, and Code Mode executables are reused. Harbor, Docker CLI, and Compose resolve
from explicit `HARBOR_BIN`, `DOCKER_BIN`, and `DOCKER_COMPOSE_BIN` overrides, then PATH, then existing mise installations.
The runner does not install Host tools. An explicit preparation example is
`mise install pipx:harbor@0.22.0 docker-cli docker-compose`; a working Docker-compatible daemon remains required.
`DOCKER_HOST` takes precedence over an available local rootless Podman socket. Compose plugin configuration is private
to the invocation. Engine, network, image, and task-resource failures remain infrastructure failures; the runner does
not change host firewall configuration or override task networking.

Frozen dependencies are installed with Bun's frozen lockfile and lifecycle scripts disabled. Each task executes real
`pi install` against the mounted Package before starting Pi. HOME, XDG directories, Pi settings, and Magic storage are
isolated. The fixed profile has one generic delegated Agent and enables the Suite's normal runtime paths, including
Goal, Agents, Magic historian/dreamer/sidekick, and Session Naming. Package Skills remain available; personal plugins,
Skills, model overrides, and settings are not inherited. Every configurable model path uses GPT-5.6 Luna/max with no
fallback models. The observer also fixes public simple-stream requests to max; native API calls such as Session Naming,
whose capability configuration exposes no reasoning setting, retain their provider defaults and are still counted.
The selected Pi credential is copied into temporary evaluation storage and removed from staging when the invocation
ends; each container uses its isolated copy.

The runner preserves `protocol.json`, the frozen assets, native Harbor configuration/results, raw agent output, and
per-trial `agent/usage.jsonl`. A public Provider observer records every started/completed call, model/pricing metadata,
reported usage, and process/Agent identity, including delegated and auxiliary calls. Usage is copied out of running
containers every five seconds. `summary.json` and progress lines aggregate all recorded calls, including archived
interrupted attempts. Dollar amounts are Pi SDK estimates from the recorded model pricing, not invoices. Calls without
reported usage remain unresolved rather than being treated as free. The denominator always comes from the frozen
selected task count multiplied by repetitions, never from the successfully completed subset.

Upstream task timeouts remain unchanged, with no additional global dollar cap and no automatic retry. A valid reward-0
outcome or Agent timeout remains a completed task outcome. Setup/infrastructure errors, missing required evidence, and
unfinished work return nonzero. Ctrl+C asks Harbor to stop and preserves available evidence. `--resume` validates the
frozen protocol digest, assets, and configuration, requires the original Harbor job state, archives incomplete attempt
directories before Harbor can remove them, and runs only
unfinished trials in fresh containers. It cannot be combined with new source, task, or execution options. It never
re-runs completed failures or silently changes the snapshot. Unreported usage from an interrupted request may remain
unknown after task completion; resuming does not manufacture missing cost evidence.

The TypeScript boundaries have offline tests; `check:terminal-bench` syntax-checks the Python Harbor adapter with
Python 3 without requiring Harbor or credentials. Running an actual benchmark is an explicit maintainer action and is
not an implementation completion requirement.

## Verification and migration status

Batch 2 classifies and reduces the test corpus, moves files into the five-level/Capability map, adds stable level
aliases, and removes obsolete acceptance aliases. Code Mode RPC and TUI have offline Acceptance homes using the real
Host with a fixture Provider. The explicit live Magic Context wrapper remains separate and was not run.

Batch 3 now implements affected-test planning and CI orchestration. Local `verify` compares the merge base with
`origin/main` by default, includes committed, staged, unstaged, and untracked paths, and accepts `--base <ref>`.
Planning starts from production sources and offline test files, follows their TypeScript AST imports through shared
helpers, and resolves `.js` imports to `.ts` sources. Unknown imports in this verification graph force full coverage.
[Dynamic dependency declarations](../config/verification-dependencies.json) record reviewed external or local loading
boundaries with the importing file's SHA-256; a changed or undeclared dynamic importer falls back to all tests. Unused
benchmark scripts do not make every local change uncertain. Shared scripts, configuration, Suite composition, Host
versions, deleted paths, and unknown impact retain the full-suite fallback. Narrow
metadata-only changes can produce an explicit no-tests plan only when the current, index, `HEAD`, and comparison-base
contents prove that the paths contain no executable fences or script material. Deleted paths use the same conservative
full-suite fallback. `--list` prints the base, head, reason, selected files, and environment requirements without
running Checks or Tests; `--help` and unknown options are strict. A normal run performs read-only `check`, then the
selected offline Tests, and writes a timestamped summary with plan, status, duration, and evidence paths.

CI uses `Plan`, `Checks`, `Tests` shards, and `Verify`. Plan selects committed PR target ranges or main-push before/after
ranges. Checks runs independently; Tests waits only for Plan. Each shard runs its assigned files serially on an
independent runner, preserving per-file process isolation. The matrix stops remaining shards on failure. Verify checks
required job results, complete and unique file coverage, the declared matrix, and every report's completion status;
a union of filenames alone cannot establish success. Per-shard and aggregate reports remain separate artifacts.
PR runs may cancel superseded PR runs, while distinct main-push ranges are retained. Branch protection is unchanged.

Shard assignment uses the retained [file timings](../config/verification-timings.json) and longest-processing-time-first
partitioning. It chooses the smallest count with the lowest estimated completion time among 1–16 runners; new files
initially have a one-second estimate. Independent setup runs concurrently, so its cost is not multiplied into the
wall-time estimate. Historical weights are scheduling hints, never coverage or timeout gates. Report actual hosted
queue, preparation, and execution time before claiming a speedup.

Manual dispatch always selects the full offline inventory and full matrix. The nightly schedule is 02:17 Asia/Shanghai
(18:17 UTC). It reuses only a successful `main` run for the same SHA whose retained plan proves complete offline/full
matrix coverage; a previous scoped or skipped run is insufficient. Missing or expired evidence causes a full run.
A reused plan records `previousFullRun`, an unchanged base/head, and no changed files. Ordinary PRs retain their
pre-merge evidence requirements.

## Representative Acceptance matrices

Known local changes select their owning Capability and related interactions across all five levels. Production changes
also retain repository contracts; Acceptance, System, and System Integration do not create an unrelated fixed cost floor.
The planner uses full matrices for rendering, theme, terminal, or geometry paths and relevant changed text. Other known
local selections use representative combinations. Shared/unknown scope and complete inventory plans remain full.

`test` defaults to `--matrix full`; explicit focused execution may use `--matrix representative`. A plan owns its matrix
and cannot be combined with a matrix override. Child processes receive that selection through
`PI_STUFF_ACCEPTANCE_MATRIX`; an ambient value cannot weaken a full plan. `--list` displays the selected matrix without
running scenarios. Only repeated geometry/theme variants are reduced:

| Acceptance | Full | Representative; independent behavior retained |
| --- | --- | --- |
| Code Mode TUI | Two geometries | `100x32`; all four scenarios, Code/Direct, start/resume |
| Agents, Tools, BTW PTY | `100x32`, `64x28` | `100x32`; Tools parity and correctness/liveness remain distinct |
| Integrated UI | Five geometries | `100x32` and `64x28`, retaining their different interactions and resize checks |
| Theme lifecycle | Four themes, two geometries | Latte and Frappe (light/dark), `100x32`; truecolor and 256-color, reload/resume |
| User Message | Five resize steps per mode/theme | `64x28`, `24x16`, `100x32`; regular/fullscreen and dark/light retained |

Agents execution's eight cases, Magic recovery's twelve cases, and unique Tool grouping scenarios remain intact.
Omitted variants are not certified by representative runs. Duplicate UI/Agents Host loading checks now reuse the
System-level Suite Host test. Agent path identity and the unique Host peer/version checks retain low-level homes;
only duplicate manifest/workspace assertions were removed.

Verification evidence applies to the tested revision and declared scope. Check the current CI `Verify` result and its
plan and test artifacts; a historical passing run does not certify later changes. The dated
[migration report](reports/quality-assurance-migration-20260906.md) records checkpoint measurements and reusable
diagnoses, including failed runs. The delivery PR records final validation. Different test scopes do not establish a
speedup. See [ADR 0032](adr/0032-organize-quality-assurance-by-verification-purpose.md) for the accepted boundaries.
