import { expect, test } from "bun:test";
import type { InputEvent } from "@earendil-works/pi-coding-agent";
import {
	AgentRunOriginTracker,
	withAgentWorkOrigin,
} from "../../../packages/pi-stuff/src/conversation-ui/agent-run-origin.js";

function input(
	text: string,
	source: InputEvent["source"],
	streamingBehavior?: InputEvent["streamingBehavior"],
): InputEvent {
	return Object.assign(
		{ type: "input" as const, text, source },
		streamingBehavior ? { streamingBehavior } : undefined,
	);
}

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }] };
}

test("keeps a user follow-up queued until Pi delivers its message", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("automatic run", "extension"));
	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("automatic run"));

	tracker.noteInput(input("later user work", "interactive", "followUp"));
	expect(tracker.current()).toBe("automatic");

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("later user work"));
	expect(tracker.current()).toBe("user");
	expect(tracker.consumeRunIncludesUserWork()).toBe(true);
	expect(tracker.current()).toBe("automatic");
});

test("promotes a direct steer only after Pi delivers it", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("automatic run", "extension"));
	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("automatic run"));

	tracker.noteInput(input("user correction", "interactive", "steer"));
	expect(tracker.current()).toBe("automatic");
	expect(tracker.hasUserWork()).toBe(false);

	tracker.noteMessageStart(userMessage("user correction"));
	expect(tracker.current()).toBe("user");
	expect(tracker.consumeRunIncludesUserWork()).toBe(true);
});

test("does not promote a direct steer without message delivery", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("automatic run", "extension"));
	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("automatic run"));

	tracker.noteInput(input("handled correction", "rpc", "steer"));
	expect(tracker.current()).toBe("automatic");
	expect(tracker.consumeRunIncludesUserWork()).toBe(false);
});

test("keeps a homogeneous identical-text Host queue lossless", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("same", "rpc", "followUp"));
	tracker.noteInput(input("same", "interactive", "steer"));

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("same"));
	expect(tracker.current()).toBe("user");

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("same"));
	expect(tracker.current()).toBe("user");
});

test("fails a transformed mixed delivery batch closed", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("raw automatic", "extension", "steer"));
	tracker.noteInput(input("raw user", "interactive", "followUp"));

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("expanded automatic"));
	expect(tracker.current()).toBe("automatic");
	tracker.noteMessageStart(userMessage("expanded user"));
	expect(tracker.current()).toBe("automatic");
	expect(tracker.hasUserWork()).toBe(false);
});

test("fails closed before an exact-text cross-class collision", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("raw automatic", "extension", "steer"));
	tracker.noteInput(input("expanded automatic", "interactive", "followUp"));

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("expanded automatic"));
	expect(tracker.current()).toBe("automatic");

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("expanded automatic"));
	expect(tracker.current()).toBe("automatic");
});

test("attributes marked custom work only when its delivery begins", () => {
	const tracker = new AgentRunOriginTracker();
	const automatic = withAgentWorkOrigin({ role: "custom", content: "wake" }, "automatic");
	const user = withAgentWorkOrigin({ role: "custom", content: "answer" }, "user");
	expect(JSON.stringify(user)).not.toContain("agent-work-origin");
	expect(JSON.stringify(user)).not.toContain('"user"');

	tracker.noteInput(input("user run", "interactive"));
	expect(tracker.current()).toBe("automatic");
	tracker.noteTurnStart();
	tracker.noteMessageStart(automatic);
	expect(tracker.current()).toBe("automatic");
	tracker.noteMessageStart(user);
	expect(tracker.current()).toBe("user");
});

test("ignores a marked custom entry that Pi appends outside an Agent turn", () => {
	const tracker = new AgentRunOriginTracker();
	const displayOnly = withAgentWorkOrigin({ role: "custom", content: "setting changed" }, "user");
	tracker.noteMessageStart(displayOnly);
	expect(tracker.current()).toBe("automatic");
	expect(tracker.consumeRunIncludesUserWork()).toBe(false);
});

test("does not count a handled idle input that never reaches message_start", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("handled command", "interactive"));
	const automatic = withAgentWorkOrigin({ role: "custom", content: "automatic wake" }, "automatic");

	tracker.noteTurnStart();
	tracker.noteMessageStart(automatic);
	expect(tracker.current()).toBe("automatic");
	expect(tracker.consumeRunIncludesUserWork()).toBe(false);
});

test("does not let a handled idle input relabel later unmarked custom work", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("handled command", "interactive"));

	tracker.noteTurnStart();
	tracker.noteMessageStart({ role: "custom", content: "third-party wake" });
	expect(tracker.current()).toBe("automatic");
	expect(tracker.consumeRunIncludesUserWork()).toBe(false);
});

test("fails a user delivery with no observed input closed", () => {
	const tracker = new AgentRunOriginTracker();

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("unobserved extension prompt"));
	expect(tracker.current()).toBe("automatic");
	expect(tracker.consumeRunIncludesUserWork()).toBe(false);
});

test("keeps more than 32 undelivered inputs losslessly in Pi delivery order", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("oldest user follow-up", "interactive", "followUp"));
	for (let index = 0; index < 40; index += 1) {
		tracker.noteInput(input(`user ${index}`, "interactive", "followUp"));
	}

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("oldest user follow-up"));

	expect(tracker.current()).toBe("user");
	expect(tracker.consumeRunIncludesUserWork()).toBe(true);
});

test("fails a mixed-origin delivery class closed after a later Extension makes it ambiguous", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("handled user correction", "interactive", "steer"));
	tracker.noteInput(input("raw automatic correction", "extension", "steer"));

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("transformed automatic correction"));
	expect(tracker.current()).toBe("automatic");
	expect(tracker.hasUserWork()).toBe(false);

	// The ambiguous class was consumed as one fail-closed boundary, so no stale
	// user record can contaminate another automatic delivery.
	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("handled user correction"));
	expect(tracker.current()).toBe("automatic");
});

test("fails mixed steer and follow-up origins closed as one ambiguous Host queue", () => {
	const tracker = new AgentRunOriginTracker();
	tracker.noteInput(input("handled user steer", "interactive", "steer"));
	tracker.noteInput(input("raw automatic follow-up", "extension", "followUp"));

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("transformed automatic follow-up"));
	expect(tracker.current()).toBe("automatic");
	expect(tracker.hasUserWork()).toBe(false);

	tracker.noteTurnStart();
	tracker.noteMessageStart(userMessage("handled user steer"));
	expect(tracker.current()).toBe("automatic");
	expect(tracker.hasUserWork()).toBe(false);
});
