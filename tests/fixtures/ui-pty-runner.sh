#!/bin/sh
set -eu

stty rows "$PI_STUFF_UI_PTY_ROWS" columns "$PI_STUFF_UI_PTY_COLUMNS"
export COLORTERM="$PI_STUFF_UI_PTY_COLORTERM"

exec "$PI_STUFF_UI_PTY_BIN" \
	--offline \
	--approve \
	--tui-mode "${PI_STUFF_UI_PTY_MODE:-fullscreen}" \
	--no-extensions \
	--no-skills \
	--no-prompt-templates \
	--no-context-files \
	--no-builtin-tools \
	--extension "$PI_STUFF_UI_PTY_PACKAGE" \
	--extension "$PI_STUFF_UI_PTY_PROVIDER_EXTENSION" \
	--skill "$PI_STUFF_UI_PTY_SKILL" \
	--provider pi-stuff-ui-pty \
	--model ui-pty-model \
	--thinking medium \
	--session-dir "$PI_STUFF_UI_PTY_SESSIONS" \
	--session-id "$PI_STUFF_UI_PTY_SESSION_ID"
