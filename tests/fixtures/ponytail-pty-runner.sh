#!/bin/sh
set -eu

stty rows "$PI_STUFF_PONYTAIL_PTY_ROWS" columns "$PI_STUFF_PONYTAIL_PTY_COLUMNS"

exec "$PI_STUFF_PONYTAIL_PTY_BIN" \
	--offline \
	--approve \
	--tui-mode fullscreen \
	--no-extensions \
	--no-skills \
	--no-prompt-templates \
	--no-context-files \
	--no-themes \
	--extension "$PI_STUFF_PONYTAIL_PTY_PACKAGE" \
	--extension "$PI_STUFF_PONYTAIL_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-ponytail-pty \
	--model ponytail-pty-model \
	--session-dir "$PI_STUFF_PONYTAIL_PTY_SESSIONS" \
	--session-id "$PI_STUFF_PONYTAIL_PTY_SESSION_ID"
