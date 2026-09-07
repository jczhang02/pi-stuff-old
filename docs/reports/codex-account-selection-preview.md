# Codex account-selection TUI preview

Captured on 2026-09-07.

This preview illustrates the accepted design in [ADR 0035](../adr/0035-own-codex-account-selection.md) and Beads
`ps-4o1`. It is not an implemented account manager. All accounts, percentages, switches, defaults, deletions and failures
are simulated in memory. The OAuth page is descriptive only: it opens no browser and reads or saves no credentials.

## How to read the preview

A temporary Extension mounts the mock view inside the real Pi 0.85.1 Host through the existing full-width Command Dialog
coordinator and native SelectList. The Footer reuses the Suite Statusline renderer with a preview-only substitution for
the account name, because the production snapshot does not yet have that field. No production TypeScript is changed.
The temporary fixture is not a Package resource or supported command.

The preview runs with an empty isolated agent directory and home, no inherited credentials or parent selectors, offline
mode, and an isolated tmux socket with CSI-u extended keys. Its header identifies the mock and distinguishes preview
controls from product controls. Arrow keys and Enter operate the menus; Escape returns one level. The preview-only
F/U/0 keys simulate a switch failure, unavailable usage and reset. F12 reopens the view after closing it.

The retained ANSI frames come from that real Host; only right padding and empty trailing screen rows are trimmed. The PNGs below are rasterized ANSI previews using Rich, Pillow and
JetBrains Mono Nerd Font Mono, not native GUI screenshots or visual-acceptance evidence. No new dependency is installed.
Wide frames use 104 columns by 34 rows; narrow frames use 48 columns by 22 rows. Dialog images crop unrelated empty screen space; Statusline examples are cropped from captured frames. Private paths and credential-shaped values are excluded from the retained evidence.

## Main controls

The current account and new-Session default are separate rows. Account actions stay beside Fast mode, usage and Tools.

![Codex controls](../assets/previews/codex-accounts/overview.png)

## Account picker

Selecting an account affects only the current Session. Available five-hour and weekly allowance help inform the choice;
viewing those values does not change the selection. Pi native login stays available.

![Account picker](../assets/previews/codex-accounts/accounts.png)

The same picker in a narrow terminal:

![Narrow account picker](../assets/previews/codex-accounts/accounts-narrow.png)

## Startup default and login

Changing the new-Session default is a separate action. Existing Sessions, forks and running children do not follow it.

![Startup default picker](../assets/previews/codex-accounts/startup-default.png)

The login preview describes the independent OAuth step without implementing it.

![Add-account explanation](../assets/previews/codex-accounts/add-account.png)

## Failure and deletion

The failed-switch frame keeps personal selected and names the account that remains effective. Production must verify
that identity before making the same claim; this frame simulates the outcome only.

![Failed switch retaining the previous account](../assets/previews/codex-accounts/switch-failure.png)

Deletion defaults to Cancel and warns about other referencing Sessions. Current-account and startup-default references
must be removed first. Remote authorization is not revoked.

![Local deletion confirmation](../assets/previews/codex-accounts/delete-confirmation.png)

## Persistent status

The existing Codex group shows the account before weekly allowance. Switching changes both values; missing allowance
keeps the account name. These are mock Footer crops, not extra Statusline rows.

![Account and allowance Statusline states](../assets/previews/codex-accounts/statusline-states.png)

## Evidence limits

The local check passed 13 wide/narrow capture checkpoints covering keyboard navigation, simulated switching, the startup-default
picker, deletion confirmation, failure presentation, unavailable usage, Escape restoration and narrow rendering. It does not prove OAuth, refresh locking,
private-adapter compatibility, real Session isolation, child inheritance, persistence, actual allowance or cross-account
Codex continuation. Those remain feature acceptance requirements in the specification. Light-theme and authenticated
acceptance are also pending; the preview must not be used to close `ps-4o1`.
