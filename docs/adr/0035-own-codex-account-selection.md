---
status: accepted
---

# Own Codex account selection with a version-bound authentication adapter

This is an accepted design, not an implemented or certified feature. Beads feature `ps-4o1` owns the full specification;
its planning task `ps-4o1.1` delivers the documentation and mock-only TUI preview. Existing Codex behavior remains unchanged.

## Context

The maintainer needs explicit switching between Codex subscriptions without changing the selected provider or model.
Pi's built-in credential store has one credential per provider ID. Copying that credential file would couple concurrent
Sessions and risk overwriting rotating credentials. Provider aliases offer separate slots, but make account selection
part of model identity, which the maintainer rejected.

Pi 0.85.1 exposes native Provider registration and reusable Codex request functions, but its Extension-facing model
registry does not publicly expose runtime credential overrides. A source inspection and pure in-memory resolver check
confirmed that stored OAuth wins over an ambient account resolver; removing the OAuth handler does not bypass the stored
credential. Explicit request-auth overrides do take precedence. These observations do not constitute live-account acceptance.

## Decision

Codex owns named OAuth accounts and explicit, idle-only account switching. Keep `openai-codex` and the selected model
unchanged. Preserve Pi native login as an independently selectable credential source, not a fixed extra account entry.
Named accounts complete independent OAuth logins; do not import native token snapshots or overwrite Pi's authentication file.

The maintainer explicitly accepted one narrow exception to the public-API boundary in [ADR 0001](0001-keep-pi-as-the-host.md):
a Codex-owned, version-bound adapter may access the existing Session runtime authentication operations in the certified
Pi 0.85.1 Host. Compose the necessary public Provider auth bridge and retain the native catalog and request implementation.
Do not introduce another Runtime, Models collection, Session layer, proxy, transport implementation or alias provider.
Do not change or distribute Pi Host.

Keep all private access in one adapter. Check the supported version, required interface shape and effective authentication.
Do not add guessed compatibility paths for other releases. An incompatible adapter rejects named-account activation;
a Session already selecting one blocks Codex requests rather than falling back to native, ambient or another account.
A future adequate public Host seam is the trigger to remove this exception. A version match alone is not certification.

### State ownership

| State | Owner and scope |
| --- | --- |
| Codex Account Identity | Stable provider account/workspace identity used to group display entries, not credential records |
| Saved Codex Account | Codex-owned independent credential record for an identity, addressed by a stable non-secret reference |
| Codex Account Selection | The account source selected by one Session, separate from model choice and startup default |
| Codex Startup Default | A user-wide starting choice for new Sessions, initially Pi native login |
| Account display | Conversation UI projects the Codex-owned selection and allowance; it does not own authentication |
| Child inheritance | Agents snapshots only the parent's non-secret selection reference at launch |

Keep the startup default in the existing Codex Settings Namespace under [ADR 0012](0012-merge-pi-stuff-settings-file.md).
The private OAuth credential library is credential storage, not another settings file. Reuse suitable Suite persistence
primitives, preserve private permissions, and perform refresh and writes under cross-process locks with atomic replacement.
Session records, child launch metadata, diagnostics, model context and preview artifacts must never contain credentials.
Import remains pure; account operations do not begin merely because the Package was loaded.

Resume and reload restore the Session's selection. Tree navigation keeps one Session-wide choice. Ordinary new Sessions
snapshot the startup default. Forks, clones and new Codex children inherit the source selection once and then remain
independent; existing and resumed children never resnapshot a changed parent. No process-global selected-account variable
may affect another Session. Pi's own global native-login semantics remain Host-owned and are not redefined by this feature.

### Switch transaction and failure

Reject switching while the main Agent is busy. Do not queue a delayed switch, abort work or replay a task automatically.
Recheck the idle and Session fences before committing. Resolve and, when needed, refresh the target account; stage its
runtime authentication; verify the effective identity; invalidate account-bound Codex connection/continuation state;
then commit the Session selection and publish the new account's status.

A failed switch restores and verifies the previous account before reporting that it is still selected. If restoration
cannot be verified, block Codex requests rather than showing an unverified account. A refresh failure after a successful
switch also blocks requests; it never silently restores native login or another named account. Refresh must cover every
owning request path, including work that crosses token expiry, not only the first request after switching.

Keep ordinary conversation and Tool history when switching. Existing visible context may be sent to the new account;
account switching is not conversation-data isolation. Account-bound encrypted reasoning and connection caches require
separate continuation validation and must not cross identities incorrectly. Session-owned Codex consumers use the same
selected identity; explicitly inspecting another account's allowance does not select that account. Discard stale
asynchronous results instead of publishing another account's usage under the current name.

### Management and presentation

Use the existing `/codex` surface for switching, adding or reauthenticating accounts, deletion and startup-default settings.
List available five-hour and weekly allowance on demand when opening account management; add no periodic poller and
preserve existing selected-account usage behavior. Usage failure remains visible without disabling management actions.

Group verified equal account identities into one entry. If native login authenticates the same account as work, show one
work entry with native/saved credential sources inside it. A verified different native identity gets its own account entry;
an unresolved native source stays visible and selectable outside verified account entries, explicitly marked unresolved.
It must pass the normal identity-validation transaction before activation; failure retains the prior selection.
Never match by nickname, email or token bytes. Preserve provider account/workspace
scope, and do not sum allowance across sources for the same account.

Grouping only changes presentation. Keep credential records, refresh ownership, Session/default references and deletion
guards unchanged. Expose the selected source in account details and require an explicit, validated source choice to change
it. Never merge/copy credentials or recover a failing selected source by silently using another source.

Extend the existing weekly Statusline group to `󰊚 work 82%`: short account name, then remaining weekly allowance.
Use the matched account name even when native credentials are selected. `Pi login` is only the native-source fallback
when no matched saved name is available, never `Default`. Keep the existing row count and Host semantic theme colors; do not
show email by default. Missing allowance must not erase account identity. The dialog owns full names and detailed usage.
The [preview evidence](../reports/codex-account-selection-preview.md) is a mock-only design artifact, not proof of authentication.

Reauthentication must preserve the real identity of a saved account; a different identity gets a new record. Deletion
targets one saved credential record, not the grouped identity. First move current-Session and startup-default references
away from that exact source; explicitly selecting native login for the same identity can satisfy this guard, but grouping
alone cannot. Confirm shared impact and remove only that saved login, without remote revocation. Native credentials and
other saved sources remain intact. Sessions referencing the deleted record fail on their next credential-dependent
operation instead of automatically switching sources.

## Acceptance

The primary acceptance seam is the real Pi Host's Codex command, Session lifecycle and Provider dispatch. Reuse existing
Codex Host, usage/settings, native Tool and image-generation tests, plus shared dialog/Statusline fixtures. Focused storage
fault tests supplement that seam; internal adapter field assertions cannot certify the feature.

Prove the private adapter before building the full account UI. Require real two-account and concurrent-Session evidence,
including named-auth precedence beside native login, native restoration, refresh races, failed rollback, incompatible
Host handling, child inheritance and continuation, fork/clone/new defaults, resume/reload, cross-account Codex replay,
Tool/image authentication and stale usage rejection. If a supported shared-runtime configuration cannot preserve isolation,
block it explicitly rather than weakening the Session contract.

Cover native=work, verified distinct native identity, equal email with different account/workspace identities, unresolved
identity and token rotation. Grouping must preserve source selection/default references and credentials, expose per-source
failures, and show one account allowance. Unresolved native sources remain selectable but require validation to activate.
Verify source-specific deletion guards and preservation of native/other sources for the same identity. Explicit source
changes retain all switch guards.

Verify wide, narrow and low-height TUI behavior in light and dark themes with long/CJK labels, cancellation, focus and
editor restoration. Real PTY fixtures use isolated tmux sockets with CSI-u extended keys; concurrent native-supervisor
fixtures use isolated runtime directories and clear inherited parent selectors. Keep private values and machine-specific
paths out of retained evidence. Missing live-account evidence remains blocked acceptance.

## Consequences

- Provider aliases: rejected because account selection must remain independent of model/provider identity.
- Shared authentication-file replacement: rejected because it can affect other Sessions and overwrite refreshed credentials.
- Change Pi Host first: not selected; the maintainer chose an explicit, bounded private-access exception for the current Host.
- General multi-provider account manager, automatic rotation and cross-tool synchronization: outside the accepted scope.

The selected route carries Host-upgrade maintenance and live-account certification costs. It is not a general exception
for private APIs, an upstream fork exemption, or permission to start feature implementation during spec publication.
