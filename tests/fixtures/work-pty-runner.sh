#!/bin/sh
set -eu

stty rows "$PI_STUFF_WORK_PTY_ROWS" columns "$PI_STUFF_WORK_PTY_COLUMNS"

exec "$PI_STUFF_WORK_PTY_BIN" \
	--offline \
	--approve \
	--no-extensions \
	--no-skills \
	--no-context-files \
	--tools bash,background,monitor \
	--extension "$PI_STUFF_WORK_PTY_PACKAGE" \
	--extension "$PI_STUFF_WORK_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-work-pty \
	--model fixture-model \
	--session-dir "$PI_STUFF_WORK_PTY_SESSIONS" \
	--session-id "$PI_STUFF_WORK_PTY_SESSION_ID" \
	"run the deterministic Background Work fixture"
