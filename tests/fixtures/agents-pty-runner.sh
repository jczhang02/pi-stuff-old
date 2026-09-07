#!/bin/sh
set -eu

stty rows "$PI_STUFF_AGENTS_PTY_ROWS" columns "$PI_STUFF_AGENTS_PTY_COLUMNS"

if [ "${PI_STUFF_AGENTS_PTY_RESUME:-0}" = "1" ]; then
	set -- --continue
else
	set -- --session-id "$PI_STUFF_AGENTS_PTY_SESSION_ID" "launch one background general-purpose Agent"
fi

exec "$PI_STUFF_AGENTS_PTY_BIN" \
	--offline \
	--approve \
	--no-extensions \
	--no-skills \
	--no-context-files \
	--extension "$PI_STUFF_AGENTS_PTY_PACKAGE" \
	--extension "$PI_STUFF_AGENTS_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-agents-pty \
	--model fixture-model \
	--session-dir "$PI_STUFF_AGENTS_PTY_SESSIONS" \
	"$@"
