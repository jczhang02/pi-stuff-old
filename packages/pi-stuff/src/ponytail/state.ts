import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inheritedPonytailMode, type PonytailMode } from "./types.ts";

const PONYTAIL_RUNTIME_REGISTRY = Symbol.for("@jczhang02/pi-stuff/ponytail-runtime/v1");

export interface PonytailRuntimeReader {
	currentMode(): PonytailMode;
}

export interface PonytailRuntimeRegistry {
	readonly owners: WeakMap<object, PonytailRuntimeReader>;
	readonly startupNotified: Set<string>;
}

export function ponytailRuntimeRegistry(): PonytailRuntimeRegistry {
	// SAFETY: this global symbol owns only the validated Ponytail registry created immediately below.
	const root = globalThis as { [PONYTAIL_RUNTIME_REGISTRY]?: PonytailRuntimeRegistry };
	if (!root[PONYTAIL_RUNTIME_REGISTRY]) {
		root[PONYTAIL_RUNTIME_REGISTRY] = { owners: new WeakMap(), startupNotified: new Set() };
	}
	return root[PONYTAIL_RUNTIME_REGISTRY];
}

export function getPonytailMode(pi: Pick<ExtensionAPI, "events">): PonytailMode | undefined {
	// SAFETY: Pi's events surface is the stable object identity shared by duplicate ExtensionAPI wrappers.
	const owner = pi.events as object;
	return ponytailRuntimeRegistry().owners.get(owner)?.currentMode() ?? inheritedPonytailMode();
}
