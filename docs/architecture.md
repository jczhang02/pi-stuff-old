# Architecture

[Simplified Chinese](i18n/zh-CN/docs/architecture.md)

Pi Stuff runs as one Package inside the Pi Host. Its Capability Modules share Pi's conversation, session, command,
Tool, and terminal surfaces while keeping ownership of their own state and policy.

## System shape

```text
Pi Host
└── Pi Stuff Package
    ├── Conversation surface
    ├── Work lifecycles
    ├── Context and integrations
    └── Supporting Tools and runtime adapters
```

Pi owns the editor, ordinary foreground Agent runs, sessions, models, and extension loading. Pi Stuff adds Suite
behavior through Pi's public extension APIs.

## Suite composition

`packages/pi-stuff/suite.json` is the composition source. The generated extension factory initializes capabilities in
this order:

| Stage | Capability Modules |
| --- | --- |
| Conversation foundation | Conversation UI, Session Naming, Tool Display |
| Model and command support | RTK, Codex |
| Work and context | Goal, Context Management, Ponytail |
| Integrations | Web, MCP |
| Delegated work | Background Work, Agents, Todo |
| Interaction helpers | BTW, Notification |
| Optional execution | Code Mode |

Order matters where a later capability consumes shared UI, diagnostics, lifecycle state, or Tools exposed earlier in
the Suite.

## Generated composition

`bun run suite:generate` reads `packages/pi-stuff/suite.json` and updates:

- `packages/pi-stuff/index.ts`, the Package extension entry;
- `packages/pi-stuff/src/suite-runtime.ts`, the generated capability loader.

Change the manifest and regenerate when composition changes. Capability implementation remains under
`packages/pi-stuff/src/<capability>/`.

## Runtime loading

Relative Package imports name the shipped file directly: TypeScript imports use `.ts`, while real JavaScript modules
retain their own extension. Generated composition follows the same rule. The repository import audit rejects missing
targets so the Host does not repeatedly search nonexistent `.js` paths before falling back to TypeScript Source.

Package import registers the extension factory. Session startup reads user configuration and initializes configured
capabilities before the editor becomes ready. Optional external services and subprocess-backed integrations start only
when their owning capability needs them.

Initialization failures propagate to the Host. Runtime problems that can be contained are recorded in the shared
diagnostics surface and are available through `/diagnostics`.

Shared runtime type guards bind their TypeBox predicates once when the module loads. They preserve JavaScript number
categories (including `NaN` and infinities) and object categories (including arrays and `null`); finite-number checks
remain separate.

## Lifecycle ownership

| Lifecycle | Owner | Responsibility |
| --- | --- | --- |
| Foreground Agent work | Pi | Ordinary turns, model execution, Goal Final Responses, and Host terminal behavior |
| Goal continuation | Goal | Objective persistence, evidence gates, continuation, terminal-state persistence, and queue intent |
| Delegated Agent execution | Agents | Child execution, supervision, and current-session Agent controls |
| Background processes | Background Work | Background Shells, Monitors, output, and cancellation |
| Context projection | Context Management | Retrieval, compaction, pressure handling, and history projection |

These owners coordinate through bounded shared state and Pi extension events. A visible state has one UI authority so
the Welcome card, Statusline, overlays, notifications, and transcript do not compete to explain the same condition.
Goal validates and persists an accepted terminal state before returning its Tool result; Pi then owns the ordinary
follow-up Provider request and Assistant message in that same foreground Agent run, unless the recorded usage exhausts
an explicit budget or another forced-stop boundary applies.

## Configuration and data

| Location | Owner |
| --- | --- |
| `<agentDir>/settings.json` | Pi Host settings |
| `<agentDir>/pi-stuff.json` | Pi Stuff settings namespaces |
| `<project>/.pi/code-mode.json` | Trusted-project Code Mode override |
| User MCP configuration | MCP server declarations and authentication |
| External Context configuration | Context engine and worker selection |

Session data, credentials, model stores, caches, and external service state stay with their owning Host or
integration. See [Settings reference](reference/settings.md) for the supported Pi Stuff namespaces.

## Design authorities

- [CONTEXT.md](../CONTEXT.md) defines canonical terms and ownership boundaries.
- [DESIGN.md](../DESIGN.md) defines shared visible-surface behavior.
- [Capability documentation](README.md#capability-documentation) links the current local contracts.
- [ADRs](README.md#current-adr-index) record durable trade-offs.
- [Compatibility](compatibility.md) records the certified Host and development toolchain.
