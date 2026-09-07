#!/usr/bin/env bash
set -euo pipefail

args=(
	--offline
	--approve
	--no-extensions
	--no-skills
	--no-context-files
	--tools read,bash,find,ls,write,subagent,TaskCreate,fixture_state,fixture_confirm,fixture_cancel,fixture_retry,fixture_media,padding_tool
	--extension "$PI_STUFF_TOOLS_GROUPING_PACKAGE"
	--extension "$PI_STUFF_TOOLS_GROUPING_PROVIDER_EXTENSION"
	--provider pi-stuff-tools-grouping-pty
	--model fixture-model
	--session-dir "$PI_STUFF_TOOLS_GROUPING_SESSIONS"
	--session-id "$PI_STUFF_TOOLS_GROUPING_SESSION_ID"
)
if [[ ${PI_STUFF_TOOLS_GROUPING_RESUME:-0} != 1 ]]; then
	args+=("${PI_STUFF_TOOLS_GROUPING_PROMPT:-success}")
fi

exec "$PI_STUFF_TOOLS_GROUPING_BIN" "${args[@]}"
