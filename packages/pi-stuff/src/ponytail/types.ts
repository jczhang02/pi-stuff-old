import { isRuntimeString } from "../shared/runtime-type.ts";

export const PONYTAIL_MODES = ["off", "lite", "full", "ultra"] as const;
export const PONYTAIL_SPECIALIZED_SKILLS = [
	"ponytail-review",
	"ponytail-audit",
	"ponytail-debt",
	"ponytail-gain",
	"ponytail-help",
] as const;

export type PonytailMode = (typeof PONYTAIL_MODES)[number];
export type PonytailSpecializedSkill = (typeof PONYTAIL_SPECIALIZED_SKILLS)[number];

export const PONYTAIL_DEFAULT_MODE: PonytailMode = "full";
export const PONYTAIL_ICON = "\u{F15BF}";
export const PONYTAIL_SESSION_ENTRY_TYPE = "ponytail-mode";
export const PONYTAIL_CHILD_MODE_ENV = "PI_STUFF_PONYTAIL_MODE";

export interface PonytailSavedSettings {
	readonly defaultMode: PonytailMode;
	readonly hideStatus: boolean;
	readonly quietStartup: boolean;
}

export interface PonytailEffectiveSettings extends PonytailSavedSettings {
	readonly saved: PonytailSavedSettings;
	readonly source: "defaults" | "legacy" | "merged";
	readonly defaultModeOverridden: boolean;
	readonly hideStatusOverridden: boolean;
	readonly quietStartupOverridden: boolean;
	readonly writable: boolean;
	readonly error?: string;
}

export function normalizePonytailMode<Value>(value: Value): PonytailMode | undefined {
	if (!isRuntimeString(value)) return undefined;
	const normalized = value.trim().toLowerCase();
	return PONYTAIL_MODES.find((mode) => mode === normalized);
}

export function inheritedPonytailMode(
	env: Readonly<Record<string, string | undefined>> = process.env,
): PonytailMode | undefined {
	return normalizePonytailMode(env[PONYTAIL_CHILD_MODE_ENV]);
}

export function isPonytailDeactivationCommand<Value>(value: Value): boolean {
	if (!isRuntimeString(value)) return false;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[.!?\s]+$/u, "");
	return normalized === "stop ponytail" || normalized === "normal mode";
}
