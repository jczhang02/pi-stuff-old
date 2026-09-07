---
status: accepted
---

# Keep Pi as the Host and Pi Stuff as one repository-owned Package

## Context

Pi already owns the CLI, TUI, Sessions, Settings Layers, Package loading, and model interaction. Pi Stuff is installed,
upgraded, tested, and used as one Suite; none of its Capabilities has an independent user, release, or installation
lifecycle. Splitting the Suite into npm Packages, or moving mechanisms upstream merely to reduce repository line count,
would add boundaries without creating independent products.

Source provenance also does not change maintenance responsibility. Adapted, forked, vendored, generated, and locally
written Source all ship from this repository and can affect the same Host behavior.

## Decision

Pi remains the Host. Pi Stuff remains one local Pi Package with one default Extension factory. The entry point installs
ordered internal Capability Modules through Pi's public Extension interface; it does not introduce another CLI,
runtime, Session layer, SDK, or TUI shell.

Conversation UI may adapt the certified Host's Thinking and User Message presentation methods where no public
renderer exists. These narrowly owned, reversible adapters preserve canonical messages and Host lifecycle authority;
they require real-Host certification and release their method ownership on Session shutdown. This is a presentation
exception, not permission to patch execution, persistence, or arbitrary Host internals. User Message trade-offs and
failure containment are specified in [ADR 0030](0030-unify-user-message-presentation.md).

A Capability Module is an internal implementation boundary, not an independently installed or published Package. The
current ordered set is defined by `packages/pi-stuff/suite.json`, and dependencies between Modules stay explicit.
Shared Modules may provide narrow interfaces to Capability Modules, but shared Modules do not import the Capabilities
that consume them. The adapted MCP and Web implementations remain private directories inside their owning Modules.

Every tracked implementation, test, script, generated source, prototype, and repository quality tool is
Repository-owned Source regardless of origin. All of it follows the same architecture, formatting, lint, type-safety,
dependency, size, and maintainability gates. Provenance remains mandatory for attribution, licensing, and selective
upstream review; it never grants a quality exemption.

Extension import stays pure. Package installation and Settings Layer changes are explicit Host or maintainer actions,
and initialization failures propagate instead of leaving a partially loaded Suite.

## Consequences

- Pi continues to own ordinary Host behavior and lifecycle authority.
- The repository keeps one development manifest and one runtime Package manifest; it does not use npm publication,
  Changesets, per-Capability versions, or multi-Package release manifests.
- Runtime dependencies are declared once. Tests certify public Host and Module seams rather than npm Package names.
- Upstream fixes are reviewed and incorporated selectively without a second Package lifecycle.
- A Capability may become a Package only after a real independent consumer or installation need exists.
- Repository reduction comes from deleting unneeded behavior, deepening Modules, and reusing public or native seams,
  not from transferring code ownership to satisfy a line-count target.

## Rejected alternatives

- **A workspace Package per Capability:** rejected because the user-facing deployment and release unit is still one
  Suite, so the extra manifests, versions, dependency edges, and archives have no independent lifecycle to represent.
- **Externalize mechanisms for source reduction:** rejected because it moves maintenance responsibility without
  reducing product complexity or changing who must certify the behavior.

## Consolidation history

This ADR incorporates the durable decisions formerly recorded in ADR 0003 (one local Package with internal Capability
Modules) and ADR 0016 (repository ownership is independent of provenance). Their separate files are removed because
they described the same Host and ownership boundary.
