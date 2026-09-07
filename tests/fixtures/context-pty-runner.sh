#!/bin/sh
set -eu

stty rows "$PI_STUFF_CONTEXT_PTY_ROWS" columns "$PI_STUFF_CONTEXT_PTY_COLUMNS"

set -- \
	"$PI_STUFF_CONTEXT_PTY_BIN" \
	--offline \
	--approve \
	--tui-mode fullscreen \
	--no-extensions \
	--no-skills \
	--no-prompt-templates \
	--no-context-files \
	--no-themes \
	--extension "$PI_STUFF_CONTEXT_PTY_PACKAGE" \
	--extension "$PI_STUFF_CONTEXT_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-context-pty \
	--model fixture-model \
	--session-dir "$PI_STUFF_CONTEXT_PTY_SESSIONS"

if [ -n "${PI_STUFF_CONTEXT_PTY_RESUME_SESSION:-}" ]; then
	exec "$@" --session "$PI_STUFF_CONTEXT_PTY_RESUME_SESSION"
fi

if [ "${PI_STUFF_CONTEXT_PTY_STARTUP_ONLY:-}" = "1" ]; then
	exec "$@" --session-id "$PI_STUFF_CONTEXT_PTY_SESSION_ID"
fi

exec "$@" --session-id "$PI_STUFF_CONTEXT_PTY_SESSION_ID" "${PI_STUFF_CONTEXT_PTY_INITIAL_PROMPT:-CONTEXT_FIRST 中文检索标记}"
