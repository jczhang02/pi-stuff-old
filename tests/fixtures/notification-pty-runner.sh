#!/bin/sh
set -eu

stty rows "$PI_STUFF_NOTIFICATION_PTY_ROWS" columns "$PI_STUFF_NOTIFICATION_PTY_COLUMNS"

exec "$PI_STUFF_NOTIFICATION_PTY_BIN" \
	--offline \
	--approve \
	--tui-mode fullscreen \
	--no-extensions \
	--no-skills \
	--no-prompt-templates \
	--no-context-files \
	--no-builtin-tools \
	--extension "$PI_STUFF_NOTIFICATION_PTY_PACKAGE" \
	--extension "$PI_STUFF_NOTIFICATION_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-notification-pty \
	--model notification-pty-model \
	--session-dir "$PI_STUFF_NOTIFICATION_PTY_SESSIONS" \
	--session-id notification-pty-session
