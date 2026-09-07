import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NativeCompactionSettings } from "./magic-runtime.ts";

export type ContextActivationTrigger = "startup" | "input" | "automatic-turn" | "projection";
export type ContextCapabilityState = "dormant" | "loading" | "active" | "native" | "degraded";

export interface ContextStatusSnapshot {
	readonly continuity?: "degraded";
	readonly continuityDetail?: string;
	readonly state: ContextCapabilityState;
	readonly engine: "magic-context" | "native";
	readonly trigger?: ContextActivationTrigger;
	readonly error?: string;
}

const NATIVE_COMPACTION_DISABLED_DETAIL =
	"Pi auto-compaction is disabled, so Pi will not invoke automatic Magic overflow recovery. Ordinary Magic compaction remains enabled.";
const NATIVE_COMPACTION_UNKNOWN_DETAIL =
	"Pi native auto-compaction settings could not be read. Automatic Magic overflow recovery requires Pi to invoke its compaction hook.";

export function nativeContextStatus(trigger: ContextActivationTrigger): ContextStatusSnapshot {
	return { state: "native", engine: "native", trigger };
}

export function contextStatusWithContinuity(
	state: ContextStatusSnapshot,
	ctx: ExtensionContext | undefined,
	readNativeCompactionSettings: (ctx: ExtensionContext) => NativeCompactionSettings | undefined,
): ContextStatusSnapshot {
	if ((state.state !== "active" && state.state !== "degraded") || !ctx) return { ...state };
	try {
		const settings = readNativeCompactionSettings(ctx);
		if (!settings) {
			return { ...state, continuity: "degraded", continuityDetail: NATIVE_COMPACTION_UNKNOWN_DETAIL };
		}
		return settings.enabled
			? { ...state }
			: { ...state, continuity: "degraded", continuityDetail: NATIVE_COMPACTION_DISABLED_DETAIL };
	} catch {
		return { ...state, continuity: "degraded", continuityDetail: NATIVE_COMPACTION_UNKNOWN_DETAIL };
	}
}
