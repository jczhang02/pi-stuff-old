import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcClient, PiRpcTimeoutError } from "../../../scripts/pi-rpc-client.js";

test("RPC spawn failures reject commands without crashing", async () => {
	const rpc = new PiRpcClient({
		arguments: [],
		commandTimeoutMs: 1_000,
		cwd: process.cwd(),
		environment: process.env,
		executable: join(tmpdir(), `missing-pi-rpc-${String(process.pid)}`),
		failurePrefix: "RPC spawn test",
		settleTimeoutMs: 1_000,
		startupTimeoutMs: 1_000,
	});
	await expect(rpc.getInitialState()).rejects.toThrow("Pi RPC process error");
	await expect(rpc.close()).resolves.toBeUndefined();
}, 7_000);

test("RPC process exits reject later commands immediately", async () => {
	const rpc = new PiRpcClient({
		arguments: ["-e", "setTimeout(() => process.exit(0), 20)"],
		commandTimeoutMs: 1_000,
		cwd: process.cwd(),
		environment: process.env,
		executable: process.execPath,
		failurePrefix: "RPC exit test",
		settleTimeoutMs: 1_000,
		startupTimeoutMs: 1_000,
	});
	await expect(rpc.getInitialState()).rejects.toThrow("Pi RPC exited unexpectedly with 0");
	await expect(rpc.command({ type: "get_state" })).rejects.toThrow("Pi RPC exited unexpectedly with 0");
	await expect(rpc.close()).resolves.toBeUndefined();
}, 7_000);

test("initial state uses the Host startup budget", async () => {
	const rpc = new PiRpcClient({
		arguments: [
			"-e",
			'const readline = require("node:readline"); readline.createInterface({ input: process.stdin }).on("line", (line) => { const request = JSON.parse(line); setTimeout(() => process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true }) + "\\n"), 50); });',
		],
		commandTimeoutMs: 10,
		cwd: process.cwd(),
		environment: process.env,
		executable: process.execPath,
		failurePrefix: "RPC startup test",
		settleTimeoutMs: 1_000,
		startupTimeoutMs: 1_000,
	});
	try {
		await expect(rpc.getInitialState()).resolves.toMatchObject({ success: true });
	} finally {
		await rpc.close();
	}
}, 7_000);

test("RPC timeout identifies the pending command", async () => {
	const rpc = new PiRpcClient({
		arguments: ["-e", "setInterval(() => {}, 1_000)"],
		commandTimeoutMs: 10,
		cwd: process.cwd(),
		environment: process.env,
		executable: process.execPath,
		failurePrefix: "RPC timeout test",
		settleTimeoutMs: 1_000,
		startupTimeoutMs: 1_000,
	});
	let timeout: unknown;
	try {
		await rpc.command({ type: "get_state" });
	} catch (error) {
		timeout = error;
	} finally {
		await rpc.close();
	}
	expect(timeout).toBeInstanceOf(PiRpcTimeoutError);
	expect(timeout).toMatchObject({ command: "get_state", phase: "command" });
}, 7_000);

test("RPC close accepts an intentional signal exit", async () => {
	const rpc = new PiRpcClient({
		arguments: ["-e", "setInterval(() => {}, 1_000)"],
		commandTimeoutMs: 1_000,
		cwd: process.cwd(),
		environment: process.env,
		executable: process.execPath,
		failurePrefix: "RPC close test",
		settleTimeoutMs: 1_000,
		startupTimeoutMs: 1_000,
	});
	await expect(rpc.close()).resolves.toBeUndefined();
	await expect(rpc.command({ type: "get_state" })).rejects.toThrow("Pi RPC process is closed");
}, 7_000);
