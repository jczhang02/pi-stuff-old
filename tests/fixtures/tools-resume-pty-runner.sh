#!/bin/sh
set -eu

stty rows 28 columns 100

case "$PI_STUFF_TOOLS_RESUME_PTY_MODE" in
	default|supervisor)
		set --
		;;
	disabled)
		set -- --no-builtin-tools
		;;
	allowlist)
		set -- --tools grep,find,ls
		;;
	*)
		echo "Unknown Tool resume mode: $PI_STUFF_TOOLS_RESUME_PTY_MODE" >&2
		exit 2
		;;
esac

if [ "${PI_STUFF_TOOLS_RESUME_PTY_COLD:-0}" = "1" ]; then
	set -- "$@" --session "$PI_STUFF_TOOLS_RESUME_PTY_TARGET"
else
	set -- "$@" --session-id "tools-resume-source-$PI_STUFF_TOOLS_RESUME_PTY_MODE"
fi

exec "$PI_STUFF_TOOLS_RESUME_PTY_BIN" \
	--offline \
	--approve \
	--no-extensions \
	--no-skills \
	--no-context-files \
	"$@" \
	--extension "$PI_STUFF_TOOLS_RESUME_PTY_PACKAGE" \
	--extension "$PI_STUFF_TOOLS_RESUME_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-tools-resume-pty \
	--model fixture-model \
	--session-dir "$PI_STUFF_TOOLS_RESUME_PTY_SESSIONS" \
	"$@"
