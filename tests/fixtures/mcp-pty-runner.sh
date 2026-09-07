#!/bin/sh
set -eu

stty rows "$PI_STUFF_MCP_PTY_ROWS" columns "$PI_STUFF_MCP_PTY_COLUMNS"

exec "$PI_STUFF_MCP_PTY_BIN" \
	--offline \
	--no-extensions \
	--no-skills \
	--no-context-files \
	--no-prompt-templates \
	--no-builtin-tools \
	--extension "$PI_STUFF_MCP_PTY_PACKAGE" \
	--extension "$PI_STUFF_MCP_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-mcp-pty \
	--model fixture-model \
	--session-dir "$PI_STUFF_MCP_PTY_SESSIONS" \
	--session-id "$PI_STUFF_MCP_PTY_SESSION_ID"
