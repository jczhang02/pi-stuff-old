import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { CodeModeEffectOwner } from "../../../packages/pi-stuff/src/code-mode/host/effect-owner.js";
import { CodeModeHostClient } from "../../../packages/pi-stuff/src/code-mode/host/host-client.js";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";

async function hostClient(path: string, startupTimeoutMs?: number): Promise<CodeModeHostClient> {
	const foundation = new EffectFoundation();
	const session = await foundation.startSession();
	return new CodeModeHostClient(
		path,
		new CodeModeEffectOwner(foundation, foundation.forkCapability(session)),
		startupTimeoutMs,
	);
}

async function hangingHost(): Promise<{ readonly directory: string; readonly path: string }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-host-client-"));
	const path = join(directory, "host");
	await writeFile(path, "#!/bin/sh\nsleep 30\n");
	await chmod(path, 0o755);
	return { directory, path };
}

type HostMode = "ignore-shutdown" | "late-cell" | "lost" | "malformed" | "stream";

async function scriptedHost(
	mode: HostMode,
): Promise<{ readonly directory: string; readonly marker: string; readonly path: string }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-host-client-"));
	const marker = join(directory, "terminated");
	const path = join(directory, "host");
	const source = [
		"#!/usr/bin/env bun",
		'import { appendFileSync } from "node:fs";',
		`const mode = ${JSON.stringify(mode)};`,
		`const marker = ${JSON.stringify(marker)};`,
		"let buffer = Buffer.alloc(0);",
		"function frame(message) {",
		"\tconst payload = Buffer.from(JSON.stringify(message));",
		"\tconst header = Buffer.allocUnsafe(4);",
		"\theader.writeUInt32LE(payload.length);",
		"\treturn Buffer.concat([header, payload]);",
		"}",
		"function send(message) { process.stdout.write(frame(message)); }",
		"function respond(id, value = null) {",
		'\tsend({ id, result: { status: "ok", value }, type: "operation/response" });',
		"}",
		"function handle(message) {",
		'\tif (message.type === "connection/hello") {',
		'\t\tconst ready = frame({ capabilities: [], selectedVersion: 1, type: "connection/ready" });',
		'\t\tif (mode === "stream") {',
		"\t\t\tprocess.stdout.write(ready.subarray(0, 2));",
		"\t\t\tsetTimeout(() => process.stdout.write(ready.subarray(2)), 1);",
		"\t\t} else process.stdout.write(ready);",
		"\t\treturn;",
		"\t}",
		'\tif (message.type === "operation/cancel") return;',
		'\tif (message.type !== "operation/request") return;',
		"\tconst method = message.request.method;",
		'\tif (method === "session/execute") {',
		'\t\tif (mode === "late-cell") {',
		'\t\t\tsetTimeout(() => respond(message.id, { cellId: "late-cell", type: "execution/started" }), 50);',
		"\t\t\treturn;",
		"\t\t}",
		'\t\tif (mode === "lost") process.exit(17);',
		'\t\tif (mode === "malformed") {',
		'\t\t\tconst payload = Buffer.from("{");',
		"\t\t\tconst header = Buffer.allocUnsafe(4);",
		"\t\t\theader.writeUInt32LE(payload.length);",
		"\t\t\tprocess.stdout.write(Buffer.concat([header, payload]));",
		"\t\t\treturn;",
		"\t\t}",
		'\t\tconst started = { id: message.id, result: { status: "ok", value: { cellId: "stream-cell", type: "execution/started" } }, type: "operation/response" };',
		'\t\tconst initial = { id: message.id, result: { status: "ok", value: { Result: { cell_id: "stream-cell", content_items: [{ text: "STREAM_OK", type: "input_text" }] } } }, type: "execute/initialResponse" };',
		"\t\tprocess.stdout.write(Buffer.concat([frame(started), frame(initial)]));",
		"\t\treturn;",
		"\t}",
		'\tif (method === "session/terminate") appendFileSync(marker, message.request.cellId);',
		'\tif (method === "session/shutdown" && mode === "ignore-shutdown") return;',
		"\trespond(message.id);",
		"}",
		'process.stdin.on("data", (chunk) => {',
		"\tbuffer = Buffer.concat([buffer, chunk]);",
		"\twhile (buffer.length >= 4) {",
		"\t\tconst length = buffer.readUInt32LE(0);",
		"\t\tif (buffer.length < length + 4) return;",
		'\t\tconst message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));',
		"\t\tbuffer = buffer.subarray(length + 4);",
		"\t\thandle(message);",
		"\t}",
		"});",
	].join("\n");
	await writeFile(path, source);
	await chmod(path, 0o755);
	return { directory, marker, path };
}

test("a host that never handshakes is bounded and torn down", async () => {
	const fixture = await hangingHost();
	const client = await hostClient(fixture.path, 30);
	try {
		await expect(Effect.runPromise(client.start())).rejects.toThrow("startup timed out after 30 ms");
	} finally {
		await Effect.runPromise(client.shutdown());
		await rm(fixture.directory, { force: true, recursive: true });
	}
});

test("host startup follows the outer Tool cancellation signal", async () => {
	const fixture = await hangingHost();
	const client = await hostClient(fixture.path, 5_000);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);
	try {
		const exit = await Effect.runPromiseExit(client.start(), { signal: controller.signal });
		expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
	} finally {
		await Effect.runPromise(client.shutdown());
		await rm(fixture.directory, { force: true, recursive: true });
	}
});

test("a cell created after cancellation is terminated when its response arrives", async () => {
	const fixture = await scriptedHost("late-cell");
	const client = await hostClient(fixture.path);
	const controller = new AbortController();
	try {
		await Effect.runPromise(client.start());
		const execution = Effect.runPromiseExit(
			client.execute({
				context: { cwd: "/project" },
				signal: controller.signal,
				source: "return 1",
				tools: [],
			}),
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 10);
		const exit = await execution;
		expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
		let terminated = "";
		for (let attempt = 0; attempt < 100 && !terminated; attempt += 1) {
			terminated = await readFile(fixture.marker, "utf8").catch(() => "");
			if (!terminated) await Bun.sleep(5);
		}
		expect(terminated).toBe("late-cell");
	} finally {
		await Effect.runPromise(client.shutdown());
		await rm(fixture.directory, { force: true, recursive: true });
	}
});

test("lazy startup accepts fragmented and coalesced protocol frames", async () => {
	const fixture = await scriptedHost("stream");
	const client = await hostClient(fixture.path);
	try {
		const response = await Effect.runPromise(
			client.execute({ context: { cwd: "/project" }, source: "return 1", tools: [] }),
		);
		expect(response).toEqual({
			cellId: "stream-cell",
			contentItems: [{ text: "STREAM_OK", type: "input_text" }],
			kind: "result",
		});
	} finally {
		await Effect.runPromise(client.shutdown());
		await rm(fixture.directory, { force: true, recursive: true });
	}
});

test("a malformed Host frame fails pending work and permits startup retry", async () => {
	const fixture = await scriptedHost("malformed");
	const client = await hostClient(fixture.path);
	try {
		await expect(
			Effect.runPromise(client.execute({ context: { cwd: "/project" }, source: "return 1", tools: [] })),
		).rejects.toThrow();
		await expect(Effect.runPromise(client.start())).resolves.toBeUndefined();
	} finally {
		await Effect.runPromise(client.shutdown());
		await rm(fixture.directory, { force: true, recursive: true });
	}
});

test("Host loss rejects a pending request with the typed lifecycle error", async () => {
	const fixture = await scriptedHost("lost");
	const client = await hostClient(fixture.path);
	try {
		await expect(
			Effect.runPromise(client.execute({ context: { cwd: "/project" }, source: "return 1", tools: [] })),
		).rejects.toMatchObject({ name: "CodeModeHostLostError" });
	} finally {
		await Effect.runPromise(client.shutdown());
		await rm(fixture.directory, { force: true, recursive: true });
	}
});

test("shutdown remains bounded when the Host ignores it", async () => {
	const fixture = await scriptedHost("ignore-shutdown");
	const client = await hostClient(fixture.path);
	try {
		await Effect.runPromise(client.start());
		const startedAt = performance.now();
		await Effect.runPromise(client.shutdown());
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	} finally {
		await Effect.runPromise(client.shutdown());
		await rm(fixture.directory, { force: true, recursive: true });
	}
});
