export type AcceptanceMatrixMode = "full" | "representative";

export function acceptanceMatrixMode(
	env: Readonly<Record<string, string | undefined>> = process.env,
): AcceptanceMatrixMode {
	const value = env["PI_STUFF_ACCEPTANCE_MATRIX"]?.trim() || "full";
	if (value === "full" || value === "representative") return value;
	throw new Error("PI_STUFF_ACCEPTANCE_MATRIX must be full or representative");
}

export function selectAcceptanceMatrix<T>(
	full: readonly T[],
	representative: readonly T[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): readonly T[] {
	return acceptanceMatrixMode(env) === "full" ? full : representative;
}
