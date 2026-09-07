import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolArguments } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import type {
	SuiteToolEnvelopeArgumentPreparer,
	SuiteToolEnvelopeDecoder,
	SuiteToolEnvelopeDetails,
	SuiteToolEnvelopeFallbackVisibility,
	SuiteToolEnvelopeOperation,
} from "./contract.ts";
import { decodeEnvelopeOperations, envelopeFallbackVisible, envelopeOperationResult } from "./envelope-renderer.ts";
import { TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT } from "./limits.ts";
import { isRecordValue, isToolArguments } from "./tool-value.ts";

/** Projects execution envelopes into the ordinary Tool protocol owned by Tool UI. */
export class ToolEnvelopeProjection {
	private readonly calls = new Map<string, string>();
	private readonly argumentPreparers = new Map<string, SuiteToolEnvelopeArgumentPreparer>();
	private readonly decoders = new Map<string, SuiteToolEnvelopeDecoder>();
	private readonly fallbackVisibility = new Map<string, SuiteToolEnvelopeFallbackVisibility>();
	private readonly rawArguments = new Map<string, ToolArguments>();

	register(
		name: string,
		decode: SuiteToolEnvelopeDecoder,
		prepareArguments?: SuiteToolEnvelopeArgumentPreparer,
		showFallback?: SuiteToolEnvelopeFallbackVisibility,
	): void {
		this.decoders.set(name, decode);
		if (prepareArguments) this.argumentPreparers.set(name, prepareArguments);
		else this.argumentPreparers.delete(name);
		if (showFallback) this.fallbackVisibility.set(name, showFallback);
		else this.fallbackVisibility.delete(name);
	}

	has(name: string): boolean {
		return this.decoders.has(name);
	}

	clearClaims(): void {
		this.calls.clear();
	}

	clearRawArguments(): void {
		this.rawArguments.clear();
	}

	rawArgumentsFor(toolCallId: string): ToolArguments | undefined {
		return this.rawArguments.get(toolCallId);
	}

	*claimOperations(
		envelopeName: string,
		envelopeId: string,
		details: SuiteToolEnvelopeDetails,
	): Iterable<SuiteToolEnvelopeOperation> {
		for (const operation of this.decode(envelopeName, details)) {
			if (operation.displayOnly === "overflow") continue;
			const owner = this.calls.get(operation.id);
			if (owner && owner !== envelopeId) continue;
			if (!owner) this.calls.set(operation.id, envelopeId);
			yield operation;
		}
	}

	/** Project registered Tool envelopes into the ordinary calls and results they contain. */
	projectMessages(messages: readonly unknown[]): readonly unknown[] {
		if (this.decoders.size === 0) return messages;
		const envelopeCallsById = new Map<string, { readonly args: ToolArguments; readonly name: string }>();
		for (const candidate of messages) {
			if (!isRecordValue(candidate) || candidate["role"] !== "assistant" || !Array.isArray(candidate["content"])) {
				continue;
			}
			for (const block of candidate["content"].slice(-TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT)) {
				if (!isRecordValue(block) || block["type"] !== "toolCall") continue;
				const id = block["id"];
				const name = block["name"];
				if (isRuntimeString(id) && isRuntimeString(name) && this.decoders.has(name)) {
					envelopeCallsById.set(id, {
						args: isToolArguments(block["arguments"]) ? block["arguments"] : {},
						name,
					});
				}
			}
		}
		const projectionsById = new Map<
			string,
			{
				readonly fallback: boolean;
				readonly name: string;
				readonly operations: readonly SuiteToolEnvelopeOperation[];
			}
		>();
		for (const candidate of messages) {
			if (!isRecordValue(candidate) || candidate["role"] !== "toolResult") continue;
			const id = candidate["toolCallId"];
			if (!isRuntimeString(id)) continue;
			const envelope = envelopeCallsById.get(id);
			if (!envelope) continue;
			const content = Array.isArray(candidate["content"]) ? candidate["content"] : [];
			const operations = this.decode(envelope.name, candidate["details"]);
			const result: AgentToolResult<unknown> & { isError?: true } = {
				// SAFETY: Pi tool-result messages own this content array; visibility never rewrites its blocks.
				content: content as AgentToolResult<unknown>["content"],
				details: candidate["details"],
			};
			if (candidate["isError"] === true) Object.assign(result, { isError: true as const });
			const state: Exclude<ToolActivityState, "running"> = candidate["isError"] === true ? "error" : "success";
			const ownsOuterOutcome =
				operations.length === 0 ||
				(candidate["isError"] === true &&
					!operations.some((operation) => operation.state !== "running" && operation.state !== "success"));
			projectionsById.set(id, {
				fallback: ownsOuterOutcome && this.showFallback(envelope.name, envelope.args, result, state),
				name: envelope.name,
				operations,
			});
		}
		const projected: unknown[] = [];
		for (const candidate of messages) {
			if (!isRecordValue(candidate)) {
				projected.push(candidate);
				continue;
			}
			if (candidate["role"] === "assistant" && Array.isArray(candidate["content"])) {
				const content: unknown[] = [];
				for (const block of candidate["content"].slice(-TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT)) {
					if (!isRecordValue(block) || block["type"] !== "toolCall") {
						content.push(block);
						continue;
					}
					const id = block["id"];
					const name = block["name"];
					if (!isRuntimeString(id) || !isRuntimeString(name) || !this.decoders.has(name)) {
						content.push(block);
						continue;
					}
					const projection = projectionsById.get(id);
					if (!projection) {
						content.push(block);
						continue;
					}
					for (const operation of projection.operations) {
						if (operation.displayOnly === "overflow") continue;
						this.rawArguments.set(operation.id, operation.args);
						content.push({
							arguments: this.prepareArguments(projection.name, operation),
							id: operation.id,
							name: operation.name,
							type: "toolCall",
						});
					}
					if (projection.fallback) content.push(block);
				}
				projected.push({ ...candidate, content });
				continue;
			}
			if (candidate["role"] === "toolResult") {
				const id = candidate["toolCallId"];
				const projection = isRuntimeString(id) ? projectionsById.get(id) : undefined;
				if (!projection) {
					projected.push(candidate);
					continue;
				}
				for (const operation of projection.operations) {
					if (operation.displayOnly === "overflow") continue;
					const result = envelopeOperationResult(operation);
					if (!result) continue;
					const projectedResult = {
						role: "toolResult",
						toolCallId: operation.id,
						toolName: operation.name,
						content: result.content,
						details: result.details,
					};
					if (result.isError === true) Object.assign(projectedResult, { isError: true });
					projected.push(projectedResult);
				}
				if (projection.fallback) projected.push(candidate);
				continue;
			}
			projected.push(candidate);
		}
		return projected;
	}

	private decode(name: string, details: SuiteToolEnvelopeDetails): readonly SuiteToolEnvelopeOperation[] {
		const decode = this.decoders.get(name);
		return decode ? decodeEnvelopeOperations(decode, details) : [];
	}

	private prepareArguments(name: string, operation: SuiteToolEnvelopeOperation): ToolArguments {
		const prepare = this.argumentPreparers.get(name);
		if (!prepare) return operation.args;
		try {
			return prepare(operation);
		} catch {
			return operation.args;
		}
	}

	private showFallback(
		name: string,
		args: ToolArguments,
		result: AgentToolResult<unknown>,
		state: ToolActivityState,
	): boolean {
		return envelopeFallbackVisible(this.fallbackVisibility.get(name), args, result, state);
	}
}
