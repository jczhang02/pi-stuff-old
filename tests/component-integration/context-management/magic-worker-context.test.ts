import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { MagicWorkerContextStore } from "../../../packages/pi-stuff/src/context-management/magic-worker-context.js";
import type {
	MagicWorkerCommandRequest,
	MagicWorkerMessage,
} from "../../../packages/pi-stuff/src/context-management/magic-worker-protocol.js";

function entry(id: string, text: string, parentId: string | null = null): SessionEntry {
	return {
		id,
		message: { content: [{ text, type: "text" }], role: "user", timestamp: Date.now() },
		parentId,
		timestamp: new Date().toISOString(),
		type: "message",
	};
}

function command(id: number, sessionId: string): MagicWorkerCommandRequest {
	return {
		args: "",
		context: {
			contextUsage: undefined,
			cwd: "/project",
			hasUI: false,
			mode: "rpc",
			model: undefined,
			session: { id: sessionId, leafId: "request-leaf" },
			systemPrompt: "",
		},
		id,
		name: "ctx-status",
		type: "command",
	};
}

test("replacing or deleting one Session mirror cannot change another Session", async () => {
	const sent: MagicWorkerMessage[] = [];
	const contexts = new MagicWorkerContextStore((message) => sent.push(message));
	const a1 = entry("a-1", "first A");
	const b1 = entry("b-1", "first B");
	contexts.replaceSession({ branch: [a1], leafId: a1.id, sessionId: "session-a", type: "session-snapshot" });
	contexts.replaceSession({ branch: [b1], leafId: b1.id, sessionId: "session-b", type: "session-snapshot" });

	const inspect = (request: MagicWorkerCommandRequest) =>
		contexts.run(request, new AbortController(), async (ctx) => {
			ctx.ui.setStatus("magic", request.context.session.id);
			return {
				branch: ctx.sessionManager.getBranch().map((item) => item.id),
				leaf: ctx.sessionManager.getLeafId(),
			};
		});
	expect(await inspect(command(1, "session-a"))).toEqual({ branch: ["a-1"], leaf: "a-1" });
	expect(await inspect(command(2, "session-b"))).toEqual({ branch: ["b-1"], leaf: "b-1" });

	const a2 = entry("a-2", "replacement A");
	contexts.replaceSession({ branch: [a2], leafId: a2.id, sessionId: "session-a", type: "session-snapshot" });
	expect(await inspect(command(3, "session-a"))).toEqual({ branch: ["a-2"], leaf: "a-2" });
	expect(await inspect(command(4, "session-b"))).toEqual({ branch: ["b-1"], leaf: "b-1" });

	contexts.deleteSession("session-a");
	expect(await inspect(command(5, "session-a"))).toEqual({ branch: [], leaf: "request-leaf" });
	expect(await inspect(command(6, "session-b"))).toEqual({ branch: ["b-1"], leaf: "b-1" });
	expect(sent.map((message) => ("sessionId" in message ? message.sessionId : undefined))).toEqual([
		"session-a",
		"session-b",
		"session-a",
		"session-b",
		"session-a",
		"session-b",
	]);
});
