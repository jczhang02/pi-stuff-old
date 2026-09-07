#!/bin/sh
set -eu

stty rows "$PI_STUFF_TOOLS_PTY_ROWS" columns "$PI_STUFF_TOOLS_PTY_COLUMNS"

exec "$PI_STUFF_TOOLS_PTY_BIN" \
	--offline \
	--approve \
	--no-extensions \
	--no-skills \
	--no-context-files \
	--tools read,bash,edit,write,grep,find,ls,fixture_large,fixture_search,fixture_state,codemode,tool_search \
	--extension "$PI_STUFF_TOOLS_PTY_PACKAGE" \
	--extension "$PI_STUFF_TOOLS_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-tools-pty \
	--model fixture-model \
	--session-dir "$PI_STUFF_TOOLS_PTY_SESSIONS" \
	--session-id "$PI_STUFF_TOOLS_PTY_SESSION_ID" \
	"run the deterministic Tool UI fixture"
