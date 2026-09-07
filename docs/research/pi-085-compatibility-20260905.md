# Pi 0.85.0 compatibility assessment

Date: 2026-09-05. Repository snapshot: `2610bd42`. Read-only implementation assessment; no acceptance tests were run.

## Finding

Pi Stuff already pins Pi 0.85.0. No additional mandatory implementation fix was established in this investigation.
The compatibility decision is now version plus behavior: support Pi 0.85.0 when its public APIs and real-Host capability
acceptance pass. Existing test definitions and certification declarations are not fresh execution evidence; run the
applicable acceptance checks before claiming a particular installation passes.

| Executable | SHA-256 | Bytes |
| --- | --- | --- |
| Installed Host | `f5f6e08211f44c11f048aac4d3321a7922021fcb40a3952c2587fe2e0df46f49` | 94,672,072 |
| Previous repository reference artifact | `0cfd1bf3e9468f1052d172502fa388e8e8e53dcdeb9fa97f1ef828fdd7757072` | 105,764,992 |

These measurements establish different historical artifacts, not different source changes, and are retained as evidence
only. The installed npm and Host changelogs match. Additional local source changes could not be established from these
artifacts. The current compatibility owner is the supported Host contract and its real-Host capability acceptance.

## Release changes and response

The [official release](https://github.com/earendil-works/pi/releases/tag/v0.85.0) and
[versioned changelog](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/CHANGELOG.md)
describe the changes relative to 0.84.4. They contain no declared breaking-change section.

| Change | Pi Stuff response |
| --- | --- |
| Default editor embeds the working indicator and uses thinking-level colors | Optional adoption. The Suite's `InputEnhancementEditor` does not expose `setWorkingStatusIndicator`; Pi intentionally retains a standalone indicator for such custom editors. Forwarding the method alone is insufficient unless the wrapped editor also opts into rendering it. |
| Fullscreen jump-to-latest control, faster transcript search, corrected drag selection | Retain Host behavior; verify navigation, search, selection, resize and Suite editor coexistence in real PTY acceptance. |
| Persistent Anthropic effort and signed-thinking recovery | Retain Provider ownership; exercise effort changes and resumed/delegated sessions when these transports are used. |
| Restorable in-memory sessions and restored SDK client entry | Additive APIs; no need to introduce another Session layer. |
| Fork compaction-boundary preservation, settled in-memory forks, RPC abort cancelling manual compaction, larger branch-summary output allowance | Prioritize Context/Goal cancellation, fork/resume, and continuation acceptance. A pending Magic-only recovery proposal is separate from an accepted Host compatibility contract. |
| Built-in tools respect `ctx.cwd` | Verify child-Agent and alternate-directory tool execution against the actual child cwd; no evidence here justifies a speculative shim. |
| Bash-only Skill discovery and provider stream/tool-delta fixes | Exercise restricted-tool discovery and RPC streaming fixtures; retain native fixes. |
| Codex terminal SSE events, Copilot reasoning, Fireworks adapter, Baseten image metadata, Qwen catalog, Grok removal | No Suite Provider replacement; only affected user model configuration needs adjustment. |
| vLLM priority, Responses output limits, LaTeX join symbols | Optional native capabilities; no mandatory Suite feature work. |
| Proxy/NO_PROXY, musl tool downloads, seccomp startup, Zed images, EXIF, concurrent sharing, imported filenames, write-result byte-count fixes | Native fixes; check Suite tool projections tolerate the revised write result. Platform-specific certification remains scoped to the documented baseline. |

Queue clearing, non-triggering message ordering, image MIME detection and post-tool threshold compaction already appear
in the 0.84.4 changelog. They remain relevant to 0.85.0 compatibility, but are not new 0.85.0 features.

## Existing adaptation and remaining work

[Compatibility](../compatibility.md) records pinned dependencies, the development-only `pi-server` workaround,
Thinking MouseRegion adaptation, RPC partial fixtures, queue attribution, native settings, PowerShell name policy and
the public image MIME seam. Source inspection confirms these adaptations exist; this investigation did not rerun them.
The [input wrapper](../../packages/pi-stuff/src/conversation-ui/input-enhancement.ts) explains the standalone spinner.

1. Run focused real-Host checks, then `bun run check` on the final chosen profile. Prioritize compaction cancellation and
   Goal continuation, Session forks/resume, alternate cwd, and regular/fullscreen UI with spinner liveness.
2. Keep pending acceptance entries in the [contract catalog](../capability-contract-catalog.md) distinct from passed
   evidence. This assessment neither proves existing runs failed nor certifies pending contracts.
3. Clarify the current-versus-historical Pi 0.84.4 wording in
   [Context upstream notes](../../packages/pi-stuff/src/context-management/UPSTREAM.md); preserve historical results.
4. Adopt the embedded indicator only if matching the new default UI is desired, using the Host mechanism and its
   existing liveness gate rather than a new spinner implementation.
