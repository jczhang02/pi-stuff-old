# Documentation

[Simplified Chinese](i18n/zh-CN/docs/README.md)

Guides, references, engineering contracts, and retained evidence for Pi Stuff. English Markdown is authoritative;
Simplified Chinese mirrors follow the same repository paths under [`docs/i18n/zh-CN/`](i18n/zh-CN/).

<p align="center">
  <a href="assets/readme/docs/index.png">
    <img src="assets/readme/docs/index.png" alt="Pi chart and tree projections in a live conversation" width="100%">
  </a>
  <br>
  <em>Pi renders chart and tree projections directly in the conversation.</em>
</p>

## Start here

| Need | Document |
| --- | --- |
| Install Pi Stuff | [Getting started](getting-started.md) |
| See the complete feature map | [Package README](../packages/pi-stuff/README.md) |
| Find a slash command | [Command reference](reference/commands.md) |
| Configure a capability | [Settings reference](reference/settings.md) |
| Choose a bundled theme | [Themes](reference/themes.md) |
| Fix a common problem | [Troubleshooting](troubleshooting.md) |
| Understand how the Suite fits together | [Architecture](architecture.md) |

## Capability guides

| Area | User guide | Module README |
| --- | --- | --- |
| Conversation UI | [Guide](capabilities/conversation-ui.md) | [Module](../packages/pi-stuff/src/conversation-ui/README.md) |
| Session Naming | [Guide](capabilities/session-naming.md) | [Module](../packages/pi-stuff/src/session-naming/README.md) |
| Tool Display | [Guide](capabilities/tool-display.md) | [Module](../packages/pi-stuff/src/tool-display/README.md) |
| Goal | [Guide](capabilities/goal.md) | [Module](../packages/pi-stuff/src/goal/README.md) |
| Background Work | [Guide](capabilities/background-work.md) | [Module](../packages/pi-stuff/src/background-work/README.md) |
| Agents | [Guide](capabilities/subagents.md) | [Module](../packages/pi-stuff/src/subagents/README.md) |
| Todo | [Guide](capabilities/todo.md) | [Module](../packages/pi-stuff/src/todo/README.md) |
| BTW | [Guide](capabilities/btw.md) | [Module](../packages/pi-stuff/src/btw/README.md) |
| Notification | [Guide](capabilities/notification.md) | [Module](../packages/pi-stuff/src/notification/README.md) |
| Ponytail | [Guide](capabilities/ponytail.md) | [Module](../packages/pi-stuff/src/ponytail/README.md) |
| Context Management | [Guide](capabilities/context-management.md) | [Module](../packages/pi-stuff/src/context-management/README.md) |
| Web | [Guide](capabilities/web.md) | [Module](../packages/pi-stuff/src/web/README.md) |
| MCP | [Guide](capabilities/mcp.md) | [Module](../packages/pi-stuff/src/mcp/README.md) |
| RTK | [Guide](capabilities/rtk.md) | [Module](../packages/pi-stuff/src/rtk/README.md) |
| Codex | [Guide](capabilities/codex.md) | [Module](../packages/pi-stuff/src/codex/README.md) |
| Code Mode | [Guide](capabilities/code-mode.md) | [Module](../packages/pi-stuff/src/code-mode/README.md) |

The Web and MCP runtimes also have source-local READMEs:
[`web/runtime`](../packages/pi-stuff/src/web/runtime/README.md) and
[`mcp/runtime`](../packages/pi-stuff/src/mcp/runtime/README.md).

## Engineering documents

| Document | Covers |
| --- | --- |
| [`CONTEXT.md`](../CONTEXT.md) | Canonical terms and ownership boundaries |
| [`DESIGN.md`](../DESIGN.md) | Shared interface and interaction rules |
| [Capability Contract Catalog](capability-contract-catalog.md) | Current observable contracts and acceptance status |
| [Tests directory](../tests/README.md) | Test levels, shared fixtures, benchmark inputs, and local commands |
| [Compatibility](compatibility.md) | Certified Host, toolchain, and dependency versions |
| [Quality assurance](quality-assurance.md) | Verification commands, execution profiles, and migration status |
| [Code quality](code-quality.md) | Source-quality gates and completion review |
| [README style](readme-style.md) | README structure, screenshots, and translation rules |
| [Contributing](../.github/CONTRIBUTING.md) | Development and pull-request workflow |
| [Agent workflow](agents/) | Repository work planning and issue tracking |

## Architecture decisions

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-keep-pi-as-the-host.md) | Keep Pi as the Host |
| [0004](adr/0004-route-suite-diagnostics-through-owned-ui.md) | Route Suite diagnostics through owned UI |
| [0006](adr/0006-cache-unchanged-suite-modules-across-host-reload.md) | Cache unchanged Modules across Host reload |
| [0007](adr/0007-initialize-configured-context-before-editor-readiness.md) | Initialize configured Context before editor readiness |
| [0008](adr/0008-own-the-context-command-surface.md) | Own the Context command surface |
| [0009](adr/0009-align-code-mode-with-openai-and-cloudflare.md) | Align Code Mode with OpenAI and Cloudflare |
| [0012](adr/0012-merge-pi-stuff-settings-file.md) | Use one merged settings file |
| [0015](adr/0015-certify-the-upstream-release-binary.md) | Certify the upstream release binary |
| [0017](adr/0017-project-chart-and-tree-fences-inside-conversation-markdown.md) | Project chart and tree fences in Conversation Markdown |
| [0018](adr/0018-end-live-v1-agent-governor-coexistence.md) | End live v1 Agent governor coexistence |
| [0019](adr/0019-isolate-context-engine-work-from-the-host-ui-thread.md) | Isolate Context engine work from the Host UI thread |
| [0020](adr/0020-add-automatic-session-naming.md) | Add automatic Session naming |
| [0021](adr/0021-fork-ponytail-as-a-suite-capability.md) | Fork Ponytail as a Suite capability |
| [0022](adr/0022-restrict-folding-to-native-retrieval.md) | Restrict compact folding to native retrieval |
| [0023](adr/0023-use-a-closed-operation-block-family.md) | Use a closed Operation Block family |
| [0024](adr/0024-adopt-effect-as-the-internal-effect-model.md) | Adopt Effect as the internal effect model |
| [0025](adr/0025-protect-vibe-line-spinner-liveness.md) | Protect Vibe Line Spinner liveness at Pi Stuff boundaries |
| [0026](adr/0026-bound-context-managed-provider-requests.md) | Bound Context-managed Provider requests |
| [0027](adr/0027-preserve-foreground-reporting-through-background-handoff.md) | Preserve foreground reporting through Background Work handoff |
| [0028](adr/0028-bound-tool-display-before-projection.md) | Bound Tool Display before projection |
| [0029](adr/0029-keep-work-independent-of-retention-quotas.md) | Keep productive work independent of internal retention quotas |
| [0030](adr/0030-unify-user-message-presentation.md) | Unify User Message presentation inside the native Host |
| [0031](adr/0031-preserve-magic-context-behavior-through-suite-integration.md) | Preserve Magic Context behavior through Suite integration |
| [0032](adr/0032-organize-quality-assurance-by-verification-purpose.md) | Organize quality assurance by verification purpose |
| [0033](adr/0033-continue-open-work-after-background-agent-results.md) | Continue open work after background Agent results (candidate implementation; acceptance pending) |

## Evidence and history

- [Research](research/) collects dated investigations and product references.
- [Reports](reports/) collects acceptance, design, and performance evidence.
- [Release notes](releases/) record shipped changes.

Dated evidence describes its recorded snapshot. Use the guides, references, and engineering documents above for
current behavior.
