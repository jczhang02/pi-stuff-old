---
status: accepted
---

# Certify the upstream release binary

## Context

Pi Stuff is a Pi Package, not a Pi Host distribution. Rebuilding Pi from a pinned checkout required repository-owned
model data, source hydration, build records, and crash-safe binary publication that did not contribute Package behavior.

## Decision

Support Pi `0.85.1` on Linux x64, retain the reviewed upstream source commit as provenance, and verify compatibility through
Pi's public APIs and real-Host capability acceptance. Acceptance must exercise the complete applicable Capability
Contract Catalog against the actual Host; executable hashes, archive hashes, file sizes, embedded Bun banners, and byte
offsets are not admission gates. Exact development dependencies continue to provide the released type surface.

Pi Stuff does not rebuild, publish, or retain generated model data for Pi Host.

## Consequences

- Host support depends on the supported version, public API behavior, and real-Host acceptance evidence.
- A Pi upgrade updates the source provenance, development dependencies, and capability acceptance evidence together.
- Release artifact observations may be retained as historical provenance, but they do not block a supported Host that
  passes the version and behavior contract.
- The repository no longer claims that it can reproduce the upstream binary from source.
