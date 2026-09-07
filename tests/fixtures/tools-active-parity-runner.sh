#!/bin/sh
set -eu

stty rows 24 columns 80

case "$PI_STUFF_TOOLS_ACTIVE_MODE" in
	default)
		set --
		;;
	none)
		set -- --no-builtin-tools
		;;
	allowlist)
		set -- --tools grep,find,ls
		;;
	*)
		echo "Unknown Tool parity mode: $PI_STUFF_TOOLS_ACTIVE_MODE" >&2
		exit 2
		;;
esac

exec "$PI_STUFF_TOOLS_PTY_BIN" \
	--offline \
	--approve \
	--no-extensions \
	--no-skills \
	--no-context-files \
	"$@" \
	--extension "$PI_STUFF_TOOLS_PTY_PACKAGE" \
	--extension "$PI_STUFF_TOOLS_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-tools-pty \
	--model fixture-model \
	--session-dir "$PI_STUFF_TOOLS_PTY_SESSIONS" \
	--session-id "$PI_STUFF_TOOLS_PTY_SESSION_ID" \
	"probe before reload"
