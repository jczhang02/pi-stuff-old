/**
 * Context-budget engine for /btw: bounds how much cloned primary-context
 * content rides into a fresh side call so the request stays within the model's
 * window. Display history is intentionally absent from this module and from
 * every model request.
 *
 * Pure host-primitive consumers — no ExtensionContext/globalThis access. The
 * caller reads session state and passes plain data in; results are computed
 * value-for-value with reference-identical message elements on the fast path
 * (preserves byte-identical prompt prefix across /btw invocations → cache parity).
 */

import type { Api, Message, Model, UserMessage } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	convertToLlm,
	estimateTokens,
	findCutPoint,
	getLastAssistantUsage,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../shared/runtime-type.ts";

// ---------------------------------------------------------------------------
// Budget constants — the engine's tuning surface. Defined in this leaf module so
// the btw.ts ↔ btw-budget.ts dependency is type-only at runtime (btw.ts re-exports
// them for the package's public surface).
// ---------------------------------------------------------------------------
const BTW_CONTEXT_RESERVE = 16384; // matches host DEFAULT_COMPACTION_SETTINGS.reserveTokens
const BTW_NO_ANCHOR_SAFETY_FACTOR = 1.2; // no-anchor fallback overcount, applied HERE (host does not)

// ---------------------------------------------------------------------------
// Branch-fit engine — pure; no ctx/globalThis access.
// Value-imports the six host primitives (no re-implementation). Deliberately does
// NOT reuse the host's backward findTurnStartIndex for the forward turn-start scan
// (the host scans backward for compaction's summarize-prefix model; /btw cannot
// summarize, so it drops the prefix and keeps a suffix that opens on a turn-start).
// ---------------------------------------------------------------------------

export interface FitBranchInput {
	/** Raw session entries from the snapshot (findCutPoint/getLastAssistantUsage contract). */
	entries: SessionEntry[];
	/** Cached converted branch messages (type==="message"-filtered via branchToMessages).
	 *  Returned by reference on the fast path (byte-identical prefix). */
	messages: Message[];
	model: Model<Api>;
	systemPrompt: string;
	question: UserMessage;
	/** Retry override: when set, skip the window formula and trim/stub to this
	 *  many branch tokens directly; the cached snapshot is NOT re-read. */
	keepBudget?: number;
}

export interface FitBranchResult {
	messages: Message[];
	branchWasTrimmed: boolean;
	stubbed: boolean;
	/** Budget fitBranch applied: window-computed on the default path, the passed-in
	 *  override on the retry path. Populated on BOTH paths so buildBtwMessages surfaces
	 *  it for the overflow-retry caller's Math.floor(built.keepBudget / 2). */
	keepBudget: number;
}

// Stub/truncation literals (research-grounded). BTW_STUB_TEXT is exported for the
// stub-content test assertion; BTW_TRUNCATE_MARKER_FMT stays private (test asserts the marker substring).
const BTW_STUB_TEXT = "[tool result elided by /btw to fit the context window]";
const BTW_TRUNCATE_MARKER_FMT = (truncatedChars: number): string => `[... ${truncatedChars} characters truncated]`;
const BTW_IMAGE_STUB_TEXT = "[image elided by /btw to fit the context window]";

// Turn-start discriminator (message-level, NOT the host's entry-level isTurnStartEntry
// which excludes compaction). branchSummary/compactionSummary are included so a head
// compaction/branch summary can open the kept suffix after a cut (hybrid filter).
const TURN_START_ROLES: ReadonlySet<string> = new Set([
	"user",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

/** chars/4 heuristic mirror of estimateTokens for the system-prompt STRING (estimateTokens
 *  takes a message, not a raw string). Math.ceil matches the host's conservative direction. */
function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Skip guard: the window is usable only when the reserve fits. */
function isBudgetable(model: Model<Api>): boolean {
	return model.contextWindow > 0 && model.contextWindow > model.maxTokens + BTW_CONTEXT_RESERVE;
}

/** Sum estimateTokens over an LLM message array (real host primitive, chars/4 per message). */
function estimateMessagesTokens(messages: Message[]): number {
	let sum = 0;
	for (const m of messages) sum += estimateTokens(m);
	return sum;
}

/** Branch-usage estimate. Anchor = getLastAssistantUsage → calculateContextTokens
 *  (safe overcount: includes the main agent's system/tools that /btw omits) PLUS
 *  estimateTokens over every context message from entries AFTER the anchor — turns the
 *  provider has not metered (the user's latest turn, tool traffic behind an
 *  aborted/error assistant) still occupy the window and must count toward it.
 *  No anchor → sum(estimateTokens) × BTW_NO_ANCHOR_SAFETY_FACTOR (host applies no factor;
 *  btw-budget applies 1.2 itself). */
function estimateBranchTokens(entries: SessionEntry[]): number {
	const usage = getLastAssistantUsage(entries);
	if (usage) {
		// Locate the anchor entry by Usage-object identity: getLastAssistantUsage returns
		// the stored reference, so identity finds the anchor without re-implementing the
		// host's validity predicate (skip aborted/error/all-zero). Walk newest-first,
		// summing estimates until the anchor — those are exactly the post-anchor entries.
		let tail = 0;
		let anchorFound = false;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (!e) continue;
			if (e.type === "message" && e.message.role === "assistant" && e.message.usage === usage) {
				anchorFound = true;
				break;
			}
			for (const m of sessionEntryToContextMessages(e)) tail += estimateTokens(m);
		}
		// Identity miss (a host returning a derived Usage object) would have made `tail`
		// span the whole branch and double-count the anchored prefix — drop it instead.
		return calculateContextTokens(usage) + (anchorFound ? tail : 0);
	}
	// No-anchor fallback: sum estimateTokens over every context-visible AgentMessage the
	// entries produce (estimateTokens accepts AgentMessage, so no cast is needed), × 1.2.
	let sum = 0;
	for (const e of entries) {
		for (const m of sessionEntryToContextMessages(e)) sum += estimateTokens(m);
	}
	return Math.ceil(sum * BTW_NO_ANCHOR_SAFETY_FACTOR);
}

/** Turn-start test on a raw entry, via the exported message conversion (message-level
 *  discriminator — includes compaction/branch summaries). */
function isTurnStartEntry(entry: SessionEntry): boolean {
	return sessionEntryToContextMessages(entry).some((m) => TURN_START_ROLES.has(m.role));
}

/** Forward scan from `fromIndex` to the first turn-start entry at or after it. Returns
 *  the index, or -1 if none exists (caller falls back to stubbing). Scanning forward
 *  past a mid-turn assistant also skips its trailing toolResults → atomicity:
 *  no toolCall without its toolResult and vice versa. */
function forwardScanToTurnStart(entries: SessionEntry[], fromIndex: number): number {
	for (let i = fromIndex; i < entries.length; i++) {
		const entry = entries[i];
		if (entry && isTurnStartEntry(entry)) return i;
	}
	return -1;
}

/** Trim: findCutPoint over RAW entries (its contract), then a FORWARD scan to a
 *  turn-start (NOT the host's backward findTurnStartIndex), then unfiltered conversion so
 *  a head compaction/branch summary survives (hybrid filter). Returns {messages:null} when
 *  no valid cut (firstKeptEntryIndex<=0) or no turn-start exists — caller stubs the full cache. */
function trimBranch(entries: SessionEntry[], keepRecentTokens: number) {
	const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);
	if (cut.firstKeptEntryIndex <= 0) return { messages: null }; // no valid cut → stub the cache
	const startIdx = forwardScanToTurnStart(entries, cut.firstKeptEntryIndex);
	if (startIdx < 0) return { messages: null }; // no turn-start in the kept suffix → stub the cache
	const keptEntries = entries.slice(startIdx);
	// Hybrid filter: after a cut, UNFILTERED sessionEntryToContextMessages (the sibling
	// conversion seam — shares convertToLlm with branchToMessages, no duplication) so a
	// head compaction/branch summary survives, matching the main agent's post-compact context.
	const trimmed = convertToLlm(keptEntries.flatMap((e) => sessionEntryToContextMessages(e)));
	return { messages: trimmed };
}

/** Phase 1 of {@link stubToFit}: oldest-first toolResult stubbing. Operates in-place
 *  on `result` (does NOT copy), updates the total from only the replaced message, and
 *  replaces over-budget `msg.role === "toolResult"` slots with the placeholder,
 *  preserving toolCallId/toolName/isError via spread (the paired ToolCall in the prior
 *  assistant stays). Returns `true` iff at least one slot was stubbed. */
interface FitProgress {
	estimate: number;
	stubbed: boolean;
}

function replaceMessage(result: Message[], index: number, replacement: Message, estimate: number): number {
	const previous = result[index];
	if (!previous) return estimate;
	result[index] = replacement;
	return estimate - estimateTokens(previous) + estimateTokens(replacement);
}

function stubToolResultsToFit(result: Message[], budget: number, initialEstimate: number): FitProgress {
	let stubbed = false;
	let estimate = initialEstimate;
	// Stub toolResult content oldest-first with the placeholder (preserves
	// toolCallId/toolName/isError via spread; the paired ToolCall in the prior assistant stays).
	for (let i = 0; i < result.length; i++) {
		if (estimate <= budget) break;
		const msg = result[i];
		if (!msg) continue;
		if (msg.role === "toolResult") {
			estimate = replaceMessage(result, i, { ...msg, content: [{ type: "text", text: BTW_STUB_TEXT }] }, estimate);
			stubbed = true;
		}
	}
	return { estimate, stubbed };
}

/** Replace high-cost non-text payloads before character truncation. Historical
 * tool arguments are no longer executable, and image/thinking payloads can be
 * reduced without changing the visible answer request. */
function stubStructuredContentToFit(result: Message[], budget: number, initialEstimate: number): FitProgress {
	let stubbed = false;
	let estimate = initialEstimate;
	for (let index = 0; index < result.length; index++) {
		if (estimate <= budget) break;
		const message = result[index];
		if (!message) continue;

		if (message.role === "user" && Array.isArray(message.content)) {
			let changed = false;
			const content = message.content.map((part) => {
				if (part.type !== "image") return part;
				changed = true;
				return { type: "text" as const, text: BTW_IMAGE_STUB_TEXT };
			});
			if (changed) {
				estimate = replaceMessage(result, index, { ...message, content }, estimate);
				stubbed = true;
			}
			continue;
		}

		if (message.role === "assistant") {
			let changed = false;
			const content = message.content.flatMap((part) => {
				if (part.type === "thinking") {
					changed = true;
					return [];
				}
				if (part.type === "toolCall" && JSON.stringify(part.arguments).length > 2) {
					changed = true;
					return [{ type: "toolCall" as const, id: part.id, name: part.name, arguments: {} }];
				}
				return [part];
			});
			if (changed) {
				estimate = replaceMessage(result, index, { ...message, content }, estimate);
				stubbed = true;
			}
		}
	}
	return { estimate, stubbed };
}

/** Phase 2 of {@link stubToFit}: terminal truncation toward the token gap. Text blocks are
 *  ranked once, and each replacement updates the total from only its containing message. */
function truncateToFit(result: Message[], budget: number, initialEstimate: number): FitProgress {
	let stubbed = false;
	let estimate = initialEstimate;
	const targets: Array<{ ci: number; isString: boolean; len: number; mi: number }> = [];
	for (let mi = 0; mi < result.length; mi++) {
		const content = result[mi]?.content;
		if (isRuntimeString(content)) {
			targets.push({ ci: -1, isString: true, len: content.length, mi });
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (let ci = 0; ci < content.length; ci++) {
			const part = content[ci];
			if (part?.type === "text") targets.push({ ci, isString: false, len: part.text.length, mi });
		}
	}
	targets.sort((left, right) => right.len - left.len);

	for (const target of targets) {
		if (estimate <= budget) break;
		const msg = result[target.mi];
		if (!msg) continue;
		const content = msg.content;
		const part = Array.isArray(content) ? content[target.ci] : undefined;
		const text =
			target.isString && isRuntimeString(content) ? content : part?.type === "text" ? part.text : undefined;
		if (!text) continue;
		const overTokens = estimate - budget;
		const removeChars = Math.max(1, Math.ceil(overTokens * 4));
		// Reserve room for the marker itself so the rewritten block lands at ~(len - removeChars)
		// chars total; without this the marker's own length leaks back into the estimate.
		const markerReserve = BTW_TRUNCATE_MARKER_FMT(removeChars).length;
		const keepChars = Math.max(0, text.length - removeChars - markerReserve);
		const truncatedChars = text.length - keepChars;
		const marker = BTW_TRUNCATE_MARKER_FMT(truncatedChars);
		// Rebuild with role narrowing so each spread yields a valid Message variant
		// (Message is a discriminated union — spreading the union and overriding `content`
		// directly does not typecheck). Top-level branches are pure msg.role checks so
		// narrowing flows into each arm; the user arm narrows string-vs-array content.
		if (msg.role === "user") {
			if (isRuntimeString(msg.content)) {
				estimate = replaceMessage(
					result,
					target.mi,
					{ ...msg, content: `${msg.content.slice(0, keepChars)}${marker}` },
					estimate,
				);
			} else {
				const content = [...msg.content];
				const part = content[target.ci];
				if (part?.type === "text") {
					content[target.ci] = { ...part, text: `${part.text.slice(0, keepChars)}${marker}` };
					estimate = replaceMessage(result, target.mi, { ...msg, content }, estimate);
				}
			}
		} else if (msg.role === "assistant") {
			const content = [...msg.content];
			const part = content[target.ci];
			if (part?.type === "text") {
				content[target.ci] = { ...part, text: `${part.text.slice(0, keepChars)}${marker}` };
				estimate = replaceMessage(result, target.mi, { ...msg, content }, estimate);
			}
		} else {
			// toolResult (msg narrowed to ToolResultMessage)
			const content = [...msg.content];
			const part = content[target.ci];
			if (part?.type === "text") {
				content[target.ci] = { ...part, text: `${part.text.slice(0, keepChars)}${marker}` };
				estimate = replaceMessage(result, target.mi, { ...msg, content }, estimate);
			}
		}
		stubbed = true;
	}
	return { estimate, stubbed };
}

/** Oversized-turn stubbing + terminal truncation. Operates on a SHALLOW copy
 *  (`messages.slice()`) — the copy lives HERE, in one place, and guards both phases —
 *  and replaces slots via object spread so the cached snapshot's array AND its message
 *  objects are never mutated. Phase 1 ({@link stubToolResultsToFit}) stubs toolResults
 *  oldest-first; phase 2 ({@link truncateToFit}) truncates the largest text block toward
 *  the token gap. Signature and return shape are unchanged. */
function stubToFit(messages: Message[], budget: number) {
	const result = messages.slice(); // shallow: new array, shared message objects — one place, guards both phases
	const initialEstimate = estimateMessagesTokens(result);
	const toolResults = stubToolResultsToFit(result, budget, initialEstimate);
	const structured = stubStructuredContentToFit(result, budget, toolResults.estimate);
	const truncated = truncateToFit(result, budget, structured.estimate);
	if (truncated.estimate > Math.max(0, budget)) {
		return { messages: [], stubbed: true };
	}
	return { messages: result, stubbed: toolResults.stubbed || structured.stubbed || truncated.stubbed };
}

/** Orchestrating pure branch-fit. Fast path returns the cached `messages` by reference
 *  (byte-identical prefix). Otherwise forward-scan trim, then stub/truncate. `keepBudget`
 *  is populated on every path. */
export function fitBranch(input: FitBranchInput): FitBranchResult {
	const { entries, messages, model, systemPrompt, question } = input;

	// --- Budget resolution ---
	let branchKeepBudget: number;
	if (input.keepBudget !== undefined) {
		// Retry path: skip the window formula AND the skip guard; trim/stub
		// directly to this many branch tokens. The cached snapshot is not re-read.
		branchKeepBudget = input.keepBudget;
	} else {
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		const windowBudget = available - estimateTextTokens(systemPrompt) - estimateTokens(question);
		if (!isBudgetable(model)) {
			// Skip guard: window unusable → fast-path the cached messages, no trim.
			// keepBudget is still populated (the window-derived value, possibly negative on an
			// unusable window) so the caller's read never sees undefined — see Notes / Deferred.
			return { messages, branchWasTrimmed: false, stubbed: false, keepBudget: windowBudget };
		}
		branchKeepBudget = windowBudget;
	}

	// --- Fast path: branch fits → return cached messages by reference (byte-identical prefix) ---
	const branchUsage = estimateBranchTokens(entries);
	if (branchUsage <= branchKeepBudget) {
		return { messages, branchWasTrimmed: false, stubbed: false, keepBudget: branchKeepBudget };
	}

	// --- Forward-scan trim ---
	const trim = trimBranch(entries, branchKeepBudget);
	if (trim.messages) {
		// Trimmed suffix fits → done (trimmed only).
		if (estimateMessagesTokens(trim.messages) <= branchKeepBudget) {
			return { messages: trim.messages, branchWasTrimmed: true, stubbed: false, keepBudget: branchKeepBudget };
		}
		// Still over after trimming → stub the TRIMMED suffix (branchWasTrimmed stays true).
		const stubbed = stubToFit(trim.messages, branchKeepBudget);
		return {
			messages: stubbed.messages,
			branchWasTrimmed: true,
			stubbed: stubbed.stubbed,
			keepBudget: branchKeepBudget,
		};
	}

	// --- No-cut-possible fallback: no valid cut or no turn-start → stub the full
	//     cached messages (branchWasTrimmed FALSE — findCutPoint found nothing to cut).
	//     When stubbing changed nothing (anchor-metered usage over budget but the raw
	//     estimates already fit), return the ORIGINAL cached array — best effort, and
	//     the reference-parity guarantee holds. ---
	const stubbed = stubToFit(messages, branchKeepBudget);
	return {
		messages: stubbed.stubbed ? stubbed.messages : messages,
		branchWasTrimmed: false,
		stubbed: stubbed.stubbed,
		keepBudget: branchKeepBudget,
	};
}
