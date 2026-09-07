import { isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { reportAgentWarning } from "../../shared/diagnostics.ts";
import { type ModelInfo as AvailableModelInfo, splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";
import { checkModelScope, type ModelScopeConfig, type ModelScopeViolation, type ModelSource } from "./model-scope.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null | undefined;
	error?: string | undefined;
	usage?: Usage | undefined;
}

export function splitThinkingSuffix(model: string) {
	return splitKnownThinkingSuffix(model);
}

export function formatSubagentModelVerificationError(
	expectedModel: string,
	observedModel: string,
	availableModels: AvailableModelInfo[] | undefined,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const expectedBase = splitThinkingSuffix(expectedModel).baseModel;
	const observedBase = splitThinkingSuffix(observedModel).baseModel;
	if (expectedBase === observedBase) return undefined;
	const expectedEntry = availableModels.find((entry) => entry.fullId === expectedBase);
	if (expectedEntry) {
		if (expectedEntry.id === observedBase) return undefined;
		const expectedIdLeaf = expectedEntry.id.slice(expectedEntry.id.lastIndexOf("/") + 1);
		const expectedFullIdLeaf = expectedEntry.fullId.slice(expectedEntry.fullId.lastIndexOf("/") + 1);
		if (expectedIdLeaf === observedBase || expectedFullIdLeaf === observedBase) return undefined;
	}
	return `model_verification_failed: child reported a different model than the launch candidate. Expected '${expectedModel}' but observed '${observedModel}'.`;
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export const INHERIT_MODEL = "inherit";

/** Must stay aligned with durable process-terminal writer proof capacity. */
export const MAX_MODEL_CANDIDATES_PER_CHILD = 64;

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeParentModel<Value>(model: Value): ParentModel | undefined {
	if (!model || !isRuntimeObject(model)) return undefined;
	if (!("provider" in model) || !("id" in model)) return undefined;
	if (!isRuntimeString(model.provider) || !isRuntimeString(model.id)) return undefined;
	if (!model.provider || !model.id) return undefined;
	return { provider: model.provider, id: model.id };
}

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators. Pure.
 */
export function normalizeModelSegment(segment: string): string {
	return segment.toLowerCase().replace(/[._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. Pure. */
function stripTrailingDateStamp(segment: string): string {
	for (const pattern of [/^(.*)-(\d{4})-(\d{2})-(\d{2})$/, /^(.*)-(\d{4})(\d{2})(\d{2})$/]) {
		const match = pattern.exec(segment);
		if (!match) continue;
		const [, base, year, month, day] = match;
		if (base !== undefined && year !== undefined && month !== undefined && day !== undefined) {
			if (isPlausibleDateStamp(year, month, day)) return base;
		}
	}
	return segment;
}

function isRegisteredProvider(provider: string, availableModels: AvailableModelInfo[]): boolean {
	const normalized = normalizeModelSegment(provider);
	return availableModels.some((entry) => normalizeModelSegment(entry.provider) === normalized);
}

function splitQualifiedModelQuery(baseModel: string, availableModels: AvailableModelInfo[]) {
	const slashIdx = baseModel.indexOf("/");
	if (slashIdx !== -1) {
		const providerPart = baseModel.slice(0, slashIdx);
		if (isRegisteredProvider(providerPart, availableModels)) {
			return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(slashIdx + 1) };
		}
		return { queryIdRaw: baseModel };
	}
	for (const separator of [":", "."]) {
		const separatorIdx = baseModel.indexOf(separator);
		if (separatorIdx <= 0) continue;
		const providerPart = baseModel.slice(0, separatorIdx);
		if (!isRegisteredProvider(providerPart, availableModels)) continue;
		return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(separatorIdx + 1) };
	}
	return { queryIdRaw: baseModel };
}

function resolveExactIdMatches(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return preferredMatch.fullId;
	}
	return exactMatches.length === 1 ? exactMatches[0]?.fullId : undefined;
}

function resolveBaseModelCandidate(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const exact = availableModels.find((entry) => entry.fullId === baseModel);
	if (exact) return exact.fullId;
	const { queryProvider } = splitQualifiedModelQuery(baseModel, availableModels);
	if (queryProvider === undefined) {
		const exactId = resolveExactIdMatches(baseModel, availableModels, preferredProvider);
		if (exactId) return exactId;
	}

	return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A qualified `provider/id`
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates). Pure.
 */
export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
	const queryId = normalizeModelSegment(queryIdRaw);
	const queryIdNoDate = stripTrailingDateStamp(queryId);

	const candidates = availableModels.filter((entry) => {
		const entryId = normalizeModelSegment(entry.id);
		if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
		if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
		return true;
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const preferredProviderNorm = normalizeModelSegment(preferredProvider);
		const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
		if (preferred) return preferred.fullId;
	}
	if (candidates.length === 1) return candidates.at(0)?.fullId;
	return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query. Pure.
 */
export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (!availableModels || availableModels.length === 0) return model;

	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	if (!thinkingSuffix) return model;
	const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
	if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
	return model;
}

function resolveSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return model;
	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const resolvedBase = thinkingSuffix
		? resolveBaseModelCandidate(baseModel, availableModels, preferredProvider)
		: undefined;
	return resolvedBase ? `${resolvedBase}${thinkingSuffix}` : undefined;
}

function suggestAlternateProviderModel(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
	if (queryProvider === undefined) return undefined;
	const suggestion = resolveBaseModelCandidate(queryIdRaw, availableModels);
	if (!suggestion) return undefined;
	const matched = availableModels.find((entry) => entry.fullId === suggestion);
	if (!matched || normalizeModelSegment(matched.provider) === queryProvider) return undefined;
	return `${suggestion}${thinkingSuffix}`;
}

function resolveRequiredSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string {
	const resolved = resolveSubagentModelCandidate(model, availableModels, preferredProvider);
	if (resolved) return resolved;
	const suggestion = suggestAlternateProviderModel(model, availableModels);
	throw new Error(
		`Unknown subagent model '${model}' in the active Pi model registry.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
	);
}

export interface ResolveSubagentModelOverrideOptions {
	/** When set with `enforce: true`, out-of-scope models are rejected. */
	scope?: ModelScopeConfig | undefined;
	/** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
	source?: ModelSource;
	/** Called for warn-severity violations instead of the default warning sink. */
	onWarn?: (violation: ModelScopeViolation) => void;
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
	reportAgentWarning(`[pi-subagents] ${violation.message}`);
}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one.
 */
export function resolveSubagentModelOverride(
	requestedModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const trimmed = isRuntimeString(requestedModel) ? requestedModel.trim() : "";
	const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
	let resolved: string | undefined;
	let resolvedFromRegistry = explicit === undefined;
	if (explicit === undefined) {
		resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	} else {
		const candidate = resolveSubagentModelCandidate(explicit, availableModels, preferredProvider);
		resolvedFromRegistry = candidate !== undefined;
		resolved =
			options?.source === "explicit"
				? (candidate ?? resolveRequiredSubagentModelCandidate(explicit, availableModels, preferredProvider))
				: (candidate ?? explicit);
	}
	if (resolved && resolvedFromRegistry && options?.scope?.enforce) {
		const source: ModelSource = explicit === undefined ? "inherited" : (options.source ?? "inherited");
		const violation = checkModelScope(resolved, options.scope, source);
		if (violation) {
			if (violation.severity === "error") throw new Error(violation.message);
			(options.onWarn ?? defaultScopeWarn)(violation);
		}
	}
	return resolved;
}

export function resolveEffectiveSubagentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const source = options?.source ?? (explicitModel !== undefined ? "explicit" : "inherited");
	const resolved = resolveSubagentModelOverride(
		explicitModel ?? agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source },
	);
	if (resolved || explicitModel === undefined) return resolved;
	return resolveSubagentModelOverride(agentModel, parentModel, availableModels, preferredProvider, {
		...options,
		source: options?.source ?? "inherited",
	});
}

export type ModelOrigin = ModelSource | "configured";

export function resolveModelOrigin(input: {
	explicitModel?: string | boolean | undefined;
	agentModel?: string | boolean | undefined;
	parentModel?: ParentModel | undefined;
}): ModelOrigin {
	const requestedModel = input.explicitModel ?? input.agentModel;
	const requested = isRuntimeString(requestedModel) ? requestedModel.trim() : "";
	if (input.parentModel && (!requested || requested === INHERIT_MODEL)) return "inherited";
	const explicit = isRuntimeString(input.explicitModel) ? input.explicitModel.trim() : "";
	return explicit && explicit !== INHERIT_MODEL ? "explicit" : "configured";
}

export interface BuildModelCandidatesOptions {
	/** Fallback models are inherited agent config and warn, rather than error, when out of scope. */
	scope?: ModelScopeConfig | undefined;
	onWarn?: (violation: ModelScopeViolation) => void;
	origin?: ModelOrigin;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: BuildModelCandidatesOptions,
): string[] {
	const origin = options?.origin ?? "configured";
	const seen = new Set<string>();
	const candidates: string[] = [];
	const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
	let skippedPrimary: string | undefined;
	for (let index = 0; index < rawCandidates.length; index++) {
		const raw = rawCandidates[index];
		if (!raw) continue;
		const model = raw.trim();
		const normalized =
			index === 0 && origin === "inherited"
				? model
				: index === 0 && origin === "explicit"
					? resolveRequiredSubagentModelCandidate(model, availableModels, preferredProvider)
					: resolveSubagentModelCandidate(model, availableModels, preferredProvider);
		if (!normalized) {
			if (index === 0) skippedPrimary = model;
			else
				reportAgentWarning(
					`[pi-subagents] Skipping fallback model '${model}' because it is unavailable in this environment.`,
				);
			continue;
		}
		if (seen.has(normalized)) continue;
		if (index === 0 && origin === "explicit" && options?.scope?.enforce) {
			const violation = checkModelScope(normalized, options.scope, "explicit");
			if (violation) throw new Error(violation.message);
		}
		if (index > 0 && options?.scope?.enforce) {
			const violation = checkModelScope(normalized, options.scope, "inherited");
			if (violation) (options.onWarn ?? defaultScopeWarn)(violation);
		}
		seen.add(normalized);
		candidates.push(normalized);
		if (candidates.length > MAX_MODEL_CANDIDATES_PER_CHILD) {
			throw new RangeError(
				`An Agent may try at most ${MAX_MODEL_CANDIDATES_PER_CHILD} model candidates (primary plus fallbacks).`,
			);
		}
	}
	if (candidates.length === 0 && skippedPrimary) {
		resolveRequiredSubagentModelCandidate(skippedPrimary, availableModels, preferredProvider);
	}
	if (skippedPrimary) {
		reportAgentWarning(
			`[pi-subagents] Skipping primary model '${skippedPrimary}' because it is unavailable in this environment.`,
		);
	}
	return candidates;
}

export function assertModelCandidateLimit(candidates: readonly string[]): void {
	if (candidates.length > MAX_MODEL_CANDIDATES_PER_CHILD) {
		throw new RangeError(
			`An Agent may try at most ${MAX_MODEL_CANDIDATES_PER_CHILD} model candidates (primary plus fallbacks).`,
		);
	}
}

/** A Tool failure is task-local even when its diagnostic mentions a provider or network error. */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

const CONTEXT_OVERFLOW_PATTERNS = [
	/context(?: length| window| limit)? (?:exceed|overflow|too long)/i,
	/maximum context length/i,
	/too many tokens/i,
	/context_length_exceeded/i,
	/prompt.*too long/i,
	/input.*too long/i,
	/exceeded.*context/i,
];

export function isContextOverflow(error: string | undefined): boolean {
	if (!error || TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(error));
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/usage\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection\s+(?:error|reset|closed|aborted)/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/stream ended without finish_reason/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b500\b/,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
	/internal server error/i,
	/cold.?start/i,
	/empty response/i,
	/no output/i,
	/model.*(?:load|fail|error)/i,
	/final child payload.*above the safe/i,
];

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	if (isContextOverflow(error)) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

export function isRetryableModelFailureAttempt(input: {
	error: string | undefined;
	messages?: readonly unknown[] | undefined;
	toolCount?: number | undefined;
}): boolean {
	if (!isRetryableModelFailure(input.error) || (input.toolCount ?? 0) > 0) return false;
	if (input.error === "Agent produced no output.") return true;
	if ((input.messages?.length ?? 0) === 0) return true;
	const error = input.error?.trim();
	return Boolean(
		error &&
			input.messages?.some(
				(message) =>
					isRuntimeObject(message) &&
					message !== null &&
					"errorMessage" in message &&
					isRuntimeString(message.errorMessage) &&
					message.errorMessage.trim() === error,
			),
	);
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
