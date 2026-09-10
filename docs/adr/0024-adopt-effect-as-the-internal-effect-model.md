---
status: accepted
---

# Adopt Effect as the internal effect model

## Context

Pi Stuff currently expresses asynchronous work, cancellation, timeouts, retries, resource release, dependency
provision, and shutdown through Capability-owned Promise and `AbortSignal` mechanisms. These mechanisms preserve the
right domain authorities, but their execution semantics recur across Background Work, Agents, Context Management,
Code Mode, MCP, Web, and other effectful Modules.

The proposal was evaluated as a behavior-preserving, merge-quality implementation in an isolated worktree. Completing
the migration alone did not accept it: the final implementation also required repository review, certification, and
an explicit go/no-go decision.

## Decision

Effect v4 is the approved implementation baseline, available for direct production adoption rather than a pending
candidate. This includes applicable public `effect/unstable/*` APIs and official v4 platform adapters. Select them
by functional fit and verified compatibility with the supported Host; RC, prerelease, or `unstable` labels alone are
not reasons to defer adoption, require an Effect v3 fallback, or wait for a stable release. Pin mutually compatible
dependency versions exactly and apply the normal risk-based verification policy. This policy does not assert an
upstream API-stability guarantee or waive concrete compatibility failures.

Use Effect as the default model for every effectful production function inside the Pi Stuff Package. I/O, failure,
cancellation, concurrency, time, retries, resources, mutable shared state, and effectful dependency provision belong
in Effect. Deterministic pure computation, domain state, codecs, formatting, and projections remain ordinary
TypeScript so purity stays visible in Module interfaces. This mandate applies to Package production runtime Source,
not its test harnesses, benchmarks, build tools, repository checks, or documentation. Those sources remain subject to
the same repository quality policy but may use native effects to exercise and inspect the public runtime contract.
Production Source imports only the required Effect namespaces through public `effect/<Module>` subpaths. The root
barrel and internal paths remain outside the production contract because the Suite executes TypeScript source directly.

Pi remains the Host. Effect owns execution mechanics only; Pi, Goal, Agents, Background Work, Context Management, and
the other Capability owners retain their existing lifecycle authority, durable state, terminal policy, and visible
outcomes. Pi, Bun, Workers, child processes, filesystems, networks, and third-party libraries meet Effect through
Capability-owned adapters. Effect cancellation expresses cancellation intent and never substitutes for the native
protocol that actually stops or releases an external resource.

Each Host event bus (`pi.events`) owns one Effect foundation for the current Suite installation generation. All Pi
facades over that event bus discover and share it through the existing Host shared-resource mechanism instead of
creating independent runtimes. The foundation owns one root Scope, each Pi Session owns a child Scope, and each
Capability may own a further Scope for its long-lived resources. An externally initiated effectful operation gets an
operation Scope when it needs cancellation or resource ownership; nested helpers inherit that Scope, and pure helpers
do not create one.

Session replacement invalidates the old generation and starts closing its Scope before the new Session becomes
current, but does not impose one global wait policy. Each Capability preserves its existing contract: activation may
await its own previous cleanup when required, or allow that cleanup to finish in the background. The foundation tracks
remaining finalizers so final Host shutdown can join them within the existing grace period. Generation fences prevent
old work from publishing into the new Session. Host registrations that Pi cannot unregister remain outside resource
acquisition and keep those fences.

Suite composition registers the foundation's Session-start owner before Capability installers, then registers its final
Host-shutdown hook after their protocol handlers. A Capability can therefore complete its established graceful native
shutdown before Scope finalization interrupts remaining work and releases its resources.

No Fiber is allowed to outlive an operation without an explicit owner. Work that intentionally continues beyond its
initiating call is forked into its Session or Capability Scope rather than into a detached global or daemon Scope. The
existing lifecycle owner still decides cancellation, terminal policy, and generation validity.

Only Pi-facing adapters execute Effect programs; lower effectful Modules return Effect values and never start
independent runners that escape their owning Scope. The shared foundation is limited to Scope ownership, this boundary
runner, and common shutdown and outcome projection. It uses Effect's native resource primitives directly. There is no
universal native-resource or I/O interface: filesystem, network, process, Worker, and third-party bridges remain
Capability-owned adapters because their release, error, and terminal semantics differ.

Expected failures that callers can recover from use typed error channels. Existing Capability domain errors remain
authoritative; native adapters translate into them, and a new typed error is introduced only when a caller must branch
on it or present it. There is no Suite-wide error hierarchy. Invariant violations and programming bugs remain defects,
and interruption remains distinct from both. The outer adapter projects these outcomes into the existing diagnostics,
domain outcomes, and Host contracts. Context services and Layers are reserved for effectful or scoped dependencies
shared across operations, or for dependencies with real production and test adapters. Pure helpers and local values
continue to use ordinary parameters.

Adopt Effect ecosystem Modules when they completely replace an existing mechanism while preserving behavior. An
Effect wrapper around an otherwise unchanged mechanism is insufficient. These Modules remain behind Capability
interfaces and do not replace Host-facing contracts, regardless of their release labels.

The first implementation phase preserves every user- and Host-observable behavior, including Tool and command
surfaces, settings and Session formats, diagnostics, cancellation, timeout, retry, recovery, and terminal outcomes.
Product redesign is a separate decision after parity is certified.

The migration first establishes the Scope, runner, error, and adapter foundation. It then proves that foundation in
three representative flows: `fetchCodexUsage` for simple asynchronous network work; the existing Host shared resource
and Tool UI cleanup path for a long-lived scoped resource, while leaving synchronous resource discovery as ordinary
TypeScript; and `MagicWorkerClient` for Worker cancellation and shutdown. Only after all three preserve their existing
contracts, pass focused checks, remove the corresponding former mechanism, and avoid a wrapper-only implementation
does the same model expand to every effectful production path. A failed proof changes the foundation before migration
continues. The completed migration pinned `effect` exactly to `4.0.0-rc.112` and kept version updates outside its
measurement window. That historical evidence freeze is not an ongoing adoption gate; subsequent version changes
follow the approved v4 policy above.

Expansion proceeds in complete vertical Capability slices. Each slice replaces and deletes its old Promise, abort,
timer, or resource-lifecycle implementation in the same coherent checkpoint while retaining the narrow native adapter
needed to operate the external system. The migration does not establish a long-lived dual execution track.

Repository checks must make completeness reviewable. Extend the existing repository-safety AST check rather than
creating another lint framework. Effect runners are confined to Pi-facing adapters, while direct Promise construction,
abort controllers, timers, network calls, asynchronous filesystem calls, Workers, and process launches are confined
to a small explicit inventory of Capability-owned native adapters. Production Source is denied by default outside that
inventory. The audit rejects an Effect wrapper that leaves the complete former lifecycle mechanism in place.

## Considered options

- **Adopt Effect only in selected complex flows:** rejected for this experiment because it cannot establish whether one
  coherent internal effect model creates Suite-wide leverage.
- **Wrap every function in Effect:** rejected because it hides the distinction between pure computation and effectful
  execution without adding failure, dependency, cancellation, or resource semantics.
- **Let Effect own product lifecycle policy:** rejected because Fiber and Scope outcomes do not define Pi Session,
  Goal, Agent, Background Work, or Context domain outcomes.

## Consequences

The ownership tree is Pi Host, Suite installation Scope, Pi Session Scope, Capability Scope, then operation Scope and
Fiber. Effect types stay inside the Package and do not replace Pi's public Extension, Session, Tool, UI, Provider, or
Agent contracts. Repository checks keep effectful execution inside that model while leaving pure computation and
Capability-owned native adapters explicit.

The first preregistered comparison on 2026-09-01 did not pass. Follow-up found two acknowledgement-fixture boundary
errors and then exposed a real product issue: direct input activated Context before the Host acknowledgement. The
fixture was corrected with regression tests, Context activation moved behind acknowledgement, and the complete
decision set was rerun prospectively against clean, pinned arms. The optimized native control included every portable
optimization identified during the study.

The recertification reported no lifecycle regression, resolved every screening uncertainty with higher-sample
evidence, and kept archive, Source, dependency, and typecheck growth below the frozen limits. Against the optimized
native control, the Effect implementation improved fresh import duration by about 13%, CPU by about 11%, and maximum
RSS by about 9%. This decision is accepted as of 2026-09-02, and the recertified Effect implementation is the adopted
mainline. See the [2026-09-01 mainline decision](../reports/effect-v4-mainline-decision-2026-09-01.md) for the final
evidence, measurement amendments, and bounded residual costs.
