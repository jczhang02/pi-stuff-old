#!/bin/sh
set -eu

stty rows 28 columns 100

set -- \
	--offline \
	--approve \
	--no-extensions \
	--no-skills \
	--no-context-files \
	--tools bash \
	--extension "$PI_STUFF_RTK_PTY_PACKAGE" \
	--extension "$PI_STUFF_RTK_PTY_PROVIDER_EXTENSION" \
	--provider pi-stuff-rtk-pty \
	--model fixture-model \
	--session-dir "$PI_STUFF_RTK_PTY_SESSIONS"

case "$PI_STUFF_RTK_PTY_PHASE" in
	fresh)
		exec "$PI_STUFF_RTK_PTY_BIN" "$@" \
			--session-id pi-stuff-rtk-pty \
			"run the deterministic RTK fixture"
		;;
	resume)
		exec "$PI_STUFF_RTK_PTY_BIN" "$@" \
			--session "$PI_STUFF_RTK_PTY_SESSION" \
			"verify the resumed RTK fixture"
		;;
	*)
		echo "Unknown RTK PTY phase: $PI_STUFF_RTK_PTY_PHASE" >&2
		exit 2
		;;
esac
