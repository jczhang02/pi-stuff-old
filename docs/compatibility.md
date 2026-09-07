# Compatibility

## Supported host

| Contract | Certified version |
| --- | --- |
| Pi standalone host | `0.85.1`, upstream `d981de1229ef899957bbe968bc8dcda02a21f477`, Linux x64 |
| Repository Bun toolchain | 1.4.0 |
| Pi Stuff Package | 0.3.3 |
| Repository development package | 0.0.0 |
| System-utility baseline | Ubuntu 24.04 with Bash, Python 3 (adapter syntax checks), curl, tar, gzip, and standard Unix utilities; no `pwsh` |
| PTY verification tools | Ubuntu 24.04 packages for Expect and tmux |
| TypeScript checker | 5.9.3 |
| Code Mode host | OpenAI Codex `rust-v0.145.0`, Linux x64 |
| Code Mode host release archive | SHA-256 `ac23177956c30cc1f9f180c27bd80f5bb5b76780db55fb94dcc22644d490852e` |
| Code Mode host executable | SHA-256 `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8` |
| Optional RTK runtime | `0.45.0`, release source `b34be37caf3796b69a50952a28e60e32b5daad43`, Linux x64 |
| RTK CI download archive | SHA-256 `c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4` |
| RTK CI download executable | SHA-256 `99e0cff729d52297a23eb832f809d9773ba7c32de818dfe76b2cdd900a951535` |

The supported Host profile is Pi `0.85.1` on Linux x64. The upstream source commit above is retained as a provenance
reference. Acceptance exercises the complete Suite contract against the real Host and its public APIs, including public
`registerMarkdownTransformer()`, regular and fullscreen UI behavior, and space-preserving native settings search. A
version match alone is insufficient: the Host must also pass the applicable real-Host capability acceptance. Pi Stuff
does not rebuild or distribute Pi Host.

Local verification reuses installed Pi and RTK through `PI_BIN` / `RTK_BIN` or `PATH`, without automatic downloads
or reinstalls. Pi and RTK compatibility admission checks versions and real behavior, not fixed executable hashes.
RTK source builds and PATH shims may satisfy that contract. CI download hashes identify the artifacts prepared on a
clean runner; they do not constrain an already-installed local executable.

CI uses `Plan`, `Checks`, independent `Tests (shard N/M)` jobs, and `Verify`. Plan runs for pull requests, pushes to
`main`, manual dispatch, and nightly scheduling. PR and push ranges select affected offline tests; manual dispatch
selects the complete inventory and full matrix. Nightly execution reuses only successful same-main-SHA full evidence,
otherwise selecting full coverage. Plan writes the required scope and matrix as artifacts. Checks validates the frozen
dependency graph, formatting, anti-slop lint, type surfaces, unused-code analysis, generated composition, and public-release
safety independently of Tests. Each required Tests shard obtains the certified Pi, Code Mode, and RTK executables and
runs its assigned files one fresh Bun or Node process at a time in a network-isolated namespace. Shards wait for Plan,
not Checks, and stop remaining work on failure. Verify always evaluates the plan and required job results, unique and
complete selected-file coverage, matrix identity, and complete structured reports. A skipped Tests job is allowed only
for an explicit no-tests plan. Plan, per-shard reports, and the aggregate remain separate artifacts. Only superseded PR
runs are cancelled; distinct main-push ranges remain available. Certification
requires the current revision's applicable checks and real-Host evidence; workflow configuration alone is not evidence.
PTY verifiers probe optional tmux server settings; the Ubuntu baseline works without `extended-keys-format`. Reuse
required CI evidence for the same revision under [the verification policy](code-quality.md#risk-based-verification);
the [delivery publisher](agents/issue-tracker.md#verified-ci-evidence) verifies those results before reporting delivery.
A separate weekly upstream watch reports when npm `latest` moves beyond the supported Host without changing support
automatically.

The repository toolchain uses Bun 1.4.0. The Host's bundled runtime and release packaging are Host details; they are not
Pi Stuff compatibility admission criteria.
Bun dependency upgrades are deliberate maintainer changes because the frozen Bun lockfile, exact repository toolchain,
`@types/bun`, CI, and executable documentation must move coherently. Dependabot is limited to pinned GitHub Actions; it does not produce npm pull
requests that omit or bypass the repository-owned Bun lockfile.

The supported Host profile identifies the released version, reviewed upstream source commit, and Linux x64 platform. The
repository toolchain row separately identifies the Bun executable used for repository commands and CI. Pi upgrades review
the supported version, public API seams, and real-Host capability evidence together; the repository does not claim to
reproduce the upstream compilation process.

The certified Code Mode executable is checked by its executable hash after installation; the release archive hash is
recorded separately because archive and extracted executable identities differ. Ordinary verification uses the offline
Code Mode RPC and TUI wrappers with a fixture Provider. The live Magic Context wrapper requires explicit selection and
credentials.

Pi core imports remain wildcard peer dependencies because the Host supplies them. Development dependencies stay pinned
to the released `0.85.1` type surface. The published `pi-coding-agent` SDK at `0.85.1` excludes the experimental remote
harness from its published SDK surface, so the explicit development `pi-server` dependency and its narrow Knip exemption
are removed. The public SDK and stdio RPC contracts remain unchanged.

User Message presentation adapts Pi 0.85.1's native insertion/replay method, retaining native card and Markdown
components. Inline Skill placement observes the card-local native Markdown token renderer without a second parser.
The exact standalone Host must pass Skill-plus-prompt and Skill-only rendering, `Ctrl+O`, resize, replay,
and reload acceptance. Structural preflight and runtime containment protect native messages; fallback is not a passing
result for normal certified inputs. Tool alignment is certified at `outputPad=1`; other values remain configurable.

The input-enhancement editor exposes Pi 0.85.1's native embedded working-status capability. The Host spinner and
working message use the editor's top border and native thinking-level colors, with no duplicate working row. Real-Host
PTY coverage checks regular/fullscreen and dark/light presentation, narrow resize, dialog restoration, cancellation,
reload, completion, and the existing 500 ms Vibe Line Spinner liveness limit.

Pi 0.85.1 wraps Thinking content in a native clickable `MouseRegion`. The version-checked Thinking adapter projects
only that region's child, retaining the Host's visibility callback and click routing. Real-Host PTY acceptance covers
both mouse and keyboard collapse/expand, latest-row rendering, and unchanged canonical Session content.

Version-sensitive verification scripts read the shared certified Host contract
instead of maintaining independent Pi version constants. PowerShell is recognized as a Pi built-in for Tool lifecycle,
MCP name-conflict, and child-Agent availability policy, but the certified Linux baseline does not contain `pwsh` and
does not claim PowerShell execution or Windows behavior.
Real RPC Provider fixtures populate each Tool call in `toolcall_start.partial`, as required by Pi 0.85.1's RPC
serialization contract.
Pi 0.85.1 also owns live compaction replay and the post-Tool threshold check before the next Assistant request: it
validates the persisted boundary, rebuilds through `buildContextEntries()`, and renders the summary once. The Suite
does not intercept either Host path. Packed acceptance proves a large Tool result triggers one native threshold
compaction while an active Goal schedules exactly one continuation.

Pi 0.85.1 owns RPC `clear_queue`, terminal settings, non-triggering custom-message ordering, Sessions, and Providers.
Pi Stuff does not wrap or shadow those contracts. `clear_queue` returns the removed queues but exposes no Extension
event, so Conversation UI cannot synchronously prune its observational attribution mirror. The next ambiguous mixed
user/automatic delivery clears that mirror and fails closed to automatic attribution; real RPC acceptance covers this
gap. The Host also defers `sendMessage({ triggerTurn: false })` content queued during Tool execution until every Tool
result in that turn is persisted.

Codex generated-image inlining uses Pi 0.85.1's public `detectSupportedImageMimeTypeFromFile()` seam for JPEG, PNG,
GIF, WebP, and BMP. The existing four-image, 25 MiB, regular-file, and best-effort text fallback limits remain intact.
An inline image result certifies model-visible media and Host rendering behavior, not image display through tmux;
actual terminal display still depends on the Host, terminal protocol, and multiplexer passthrough. Pi Stuff neither
changes terminal settings nor claims that tmux itself renders these images.

Pi 0.84 gives independently loaded extensions distinct `ExtensionAPI.events` facade objects over one Host event bus.
Suite-wide registries therefore use a synchronous event-bus discovery handoff and retain facade-keyed WeakMaps only as
local caches. Object identity of an individual facade is never treated as Host identity. Real PTY and cross-facade unit
tests cover Command Dialog restoration, Tool Activity metadata, Context ownership, `/ui` settings, status channels,
Current Work sources, and duplicate lifecycle suppression.

A Pi upgrade requires a dedicated change that reviews relevant Extension and Package interfaces, updates the pinned
development dependency and provenance reference, and passes real-Host capability acceptance.
Compatibility with other Pi builds is not claimed until that work is complete.

Older version strings in changelogs, archived acceptance reports, research notes, and captured prototypes describe the
Host that produced that historical evidence. They are not executable compatibility declarations and must not be
rewritten to imply that old evidence was captured on the current Host. Current source, package manifests, CI, fixtures,
and verification scripts follow the applicable Host or repository toolchain row above. `CERTIFIED_PI_BUN_VERSION`
describes the repository toolchain only where explicitly used; it is not a Pi compatibility gate.

The Codex Capability bundles its retained native helpers only for the certified Linux x64 profile. On another target,
the command and ordinary Pi turns remain available while the unavailable Tool returns a bounded recovery error.
