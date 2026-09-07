import { getFinalOutput } from "../../shared/utils.ts";
import type { ChildProtocolMessage } from "../shared/child-protocol.ts";

interface IndexedMessage {
	readonly index: number;
	readonly message: ChildProtocolMessage;
}

/** Retain only the message evidence needed to settle one child result. */
export class ChildResultReducer {
	private first: IndexedMessage | undefined;
	private latestAssistant: IndexedMessage | undefined;
	private latestAssistantOutput: IndexedMessage | undefined;
	private latestAssistantText: IndexedMessage | undefined;
	private latestNonAssistant: IndexedMessage | undefined;
	private latestToolError: IndexedMessage | undefined;
	private nextIndex = 0;

	record(message: ChildProtocolMessage): void {
		const indexed = { index: this.nextIndex++, message };
		this.first ??= indexed;
		if (message.role === "assistant") {
			this.latestAssistant = indexed;
			if (message.content.some((part) => part.type === "text" && part.text.trim().length > 0))
				this.latestAssistantText = indexed;
			const output = getFinalOutput([message]);
			if (
				output &&
				(!this.latestAssistantOutput || getFinalOutput([this.latestAssistantOutput.message, message]) === output)
			)
				this.latestAssistantOutput = indexed;
			return;
		}
		if (message.role === "toolResult" && message.isError) this.latestToolError = indexed;
		this.latestNonAssistant = indexed;
	}

	messages(): ChildProtocolMessage[] {
		const retained = [
			this.first,
			this.latestAssistantOutput,
			this.latestAssistantText,
			this.latestAssistant,
			this.latestToolError,
			this.latestNonAssistant,
		]
			.filter((entry): entry is IndexedMessage => entry !== undefined)
			.sort((left, right) => left.index - right.index);
		const seen = new Set<number>();
		const messages: ChildProtocolMessage[] = [];
		for (const entry of retained) {
			if (seen.has(entry.index)) continue;
			seen.add(entry.index);
			messages.push(entry.message);
		}
		return messages;
	}
}
