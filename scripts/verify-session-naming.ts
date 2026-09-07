import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { getLastRenameMarker } from "../packages/pi-stuff/src/session-naming/state.js";
import type { JsonInputObject } from "../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeObject, isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { terminateDetachedProcessGroup } from "./detached-process.js";

const PROVIDER = "pi-stuff-session-naming";
const MODEL = "fixture-model";
const TIMEOUT_MS = 20_000;

const SESSION_ENTRY_SCHEMA = Type.Object(
	{
		customType: Type.Optional(Type.String()),
		data: Type.Optional(Type.Unknown()),
		name: Type.Optional(Type.String()),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const RPC_RECORD_SCHEMA = Type.Object(
	{
		command: Type.Optional(Type.Unknown()),
		data: Type.Optional(Type.Unknown()),
		entry: Type.Optional(SESSION_ENTRY_SCHEMA),
		error: Type.Optional(Type.Unknown()),
		extensionPath: Type.Optional(Type.Unknown()),
		id: Type.Optional(Type.String()),
		success: Type.Optional(Type.Boolean()),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const ENTRIES_DATA_SCHEMA = Type.Object({ entries: Type.Array(SESSION_ENTRY_SCHEMA) }, { additionalProperties: true });

type RpcRecord = Static<typeof RPC_RECORD_SCHEMA>;

interface RpcTransport {
	readonly records: RpcRecord[];
	send(command: JsonInputObject): Promise<RpcRecord>;
	stop(): Promise<string>;
}

export interface VerifySessionNamingOptions {
	readonly packagePath: string;
	readonly piBinary: string;
}

function environment(temporaryDirectory: string, logPath: string, label: string) {
	const path = process.env["PATH"];
	if (!path) throw new Error("PATH is required to start the Pi host");
	return {
		HOME: join(temporaryDirectory, "home"),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		NO_COLOR: "1",
		PATH: path,
		PI_CODING_AGENT_DIR: join(temporaryDirectory, "agent"),
		PI_OFFLINE: "1",
		PI_STUFF_SESSION_NAMING_LABEL: label,
		PI_STUFF_SESSION_NAMING_LOG: logPath,
		PI_TELEMETRY: "0",
		TERM: "dumb",
		XDG_CACHE_HOME: join(temporaryDirectory, "cache"),
		XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
		XDG_DATA_HOME: join(temporaryDirectory, "data"),
		XDG_RUNTIME_DIR: join(temporaryDirectory, "runtime"),
		XDG_STATE_HOME: join(temporaryDirectory, "state"),
	};
}

async function createRpcTransport(command: string[], cwd: string, env: Record<string, string>): Promise<RpcTransport> {
	const child = Bun.spawn(command, { cwd, detached: true, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const records: RpcRecord[] = [];
	const pending = new Map<
		string,
		{ reject: (error: Error) => void; resolve: (record: RpcRecord) => void; timeout: ReturnType<typeof setTimeout> }
	>();
	const stderrReading = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let sequence = 0;
	let readError: Error | undefined;
	const consume = (line: string): void => {
		if (!line) return;
		const value: unknown = JSON.parse(line);
		if (!Check(RPC_RECORD_SCHEMA, value)) throw new Error(`Invalid Pi RPC record: ${line}`);
		records.push(value);
		if (!isRuntimeString(value.id) || value.type !== "response") return;
		const request = pending.get(value.id);
		if (!request) return;
		pending.delete(value.id);
		clearTimeout(request.timeout);
		request.resolve(value);
	};
	const reading = (async () => {
		while (true) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				consume(buffer.slice(0, newline).replace(/\r$/u, ""));
				buffer = buffer.slice(newline + 1);
			}
			if (done) {
				consume(buffer.replace(/\r$/u, ""));
				break;
			}
		}
	})().catch((cause: unknown) => {
		readError = cause instanceof Error ? cause : new Error(String(cause));
		for (const request of pending.values()) {
			clearTimeout(request.timeout);
			request.reject(readError);
		}
		pending.clear();
	});
	return {
		records,
		async send(command_) {
			if (readError) throw readError;
			const id = `session-naming-rpc-${String(++sequence)}`;
			const result = new Promise<RpcRecord>((resolveRequest, reject) => {
				const timeout = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Pi RPC request timed out: ${JSON.stringify(command_)}`));
				}, TIMEOUT_MS);
				pending.set(id, { reject, resolve: resolveRequest, timeout });
			});
			child.stdin.write(`${JSON.stringify({ ...command_, id })}\n`);
			await child.stdin.flush();
			const record = await result;
			if (record.success !== true) throw new Error(`Pi RPC request failed: ${JSON.stringify(record)}`);
			return record;
		},
		async stop() {
			await terminateDetachedProcessGroup(child);
			await reading;
			return stderrReading;
		},
	};
}

function entries(record: RpcRecord): SessionEntry[] {
	if (!Check(ENTRIES_DATA_SCHEMA, record.data)) throw new Error("Pi get_entries response has no entries");
	// SAFETY: get_entries is a Pi-owned RPC command; the outer response and entry object boundaries were validated above.
	return record.data.entries as SessionEntry[];
}

function sessionName(records: readonly SessionEntry[]): string | undefined {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const entry = records[index];
		if (entry?.type === "session_info" && entry.name) return entry.name;
	}
	return undefined;
}

function assertNoExtensionError(transport: RpcTransport): void {
	const error = transport.records.find((record) => record.type === "extension_error");
	if (error) throw new Error(`Pi reported an Extension error: ${JSON.stringify(error)}`);
}

async function withRpcTransport(transport: RpcTransport, label: string, run: () => Promise<void>): Promise<void> {
	let failed = false;
	let failure: unknown;
	try {
		await run();
	} catch (cause) {
		failed = true;
		failure = cause;
	}
	const stderr = await transport.stop();
	if (failed) throw failure;
	if (stderr.trim()) throw new Error(`${label} Pi Session emitted stderr: ${stderr.trim()}`);
}

async function sessionFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...(await sessionFiles(path)));
		else if (entry.name.endsWith(".jsonl")) result.push(path);
	}
	return result;
}

function parseLog(content: string): JsonInputObject[] {
	return content
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			if (!isRuntimeObject(value) || value === null || Array.isArray(value)) {
				throw new Error(`Invalid Session Naming fixture record: ${line}`);
			}
			// SAFETY: the object boundary above proves this parsed JSON value satisfies JsonInputObject.
			return value as JsonInputObject;
		});
}

export async function verifySessionNaming(options: VerifySessionNamingOptions): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-session-naming-"));
	const agentDirectory = join(temporaryDirectory, "agent");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const logPath = join(temporaryDirectory, "session-naming.jsonl");
	const fixture = resolve(import.meta.dir, "..", "tests", "fixtures", "session-naming-provider.ts");
	const command = (sessionPath?: string): string[] => [
		options.piBinary,
		"--mode",
		"rpc",
		"--offline",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-builtin-tools",
		"--no-approve",
		"--provider",
		PROVIDER,
		"--model",
		MODEL,
		"--session-dir",
		sessionDirectory,
		...(sessionPath ? ["--session", sessionPath] : []),
		"--extension",
		fixture,
	];
	try {
		await Promise.all([
			mkdir(join(temporaryDirectory, "home"), { recursive: true }),
			mkdir(agentDirectory, { recursive: true }),
			mkdir(join(temporaryDirectory, "runtime"), { recursive: true }),
		]);
		await writeFile(
			join(agentDirectory, "settings.json"),
			`${JSON.stringify({ packages: [options.packagePath], compaction: { enabled: false }, retry: { enabled: false } }, null, "\t")}\n`,
		);

		const first = await createRpcTransport(
			command(),
			temporaryDirectory,
			environment(temporaryDirectory, logPath, "Semantic Session Naming"),
		);
		await withRpcTransport(first, "First", async () => {
			await first.send({ type: "get_commands" });
			await first.send({ type: "prompt", message: "实现自动会话命名验收。" });
			await first.send({ type: "prompt", message: "/session-naming-wait" });
			const currentEntries = entries(await first.send({ type: "get_entries" }));
			const marker = getLastRenameMarker(currentEntries);
			if (marker?.mode !== "initial" || marker.source !== "ai" || marker.name !== "Semantic Session Naming") {
				throw new Error(`Automatic Session naming state was not persisted: ${JSON.stringify(marker)}`);
			}
			if (sessionName(currentEntries) !== "Semantic Session Naming") {
				throw new Error("Pi did not persist the generated Session name through session_info");
			}
			assertNoExtensionError(first);
		});

		const files = await sessionFiles(sessionDirectory);
		if (files.length !== 1) throw new Error(`Expected one real Session file, received ${JSON.stringify(files)}`);
		const sessionPath = files[0];
		if (!sessionPath) throw new Error("The real Session path was missing");
		const firstLog = parseLog(await readFile(logPath, "utf8"));
		if (firstLog.filter((record) => record["kind"] === "naming").length !== 1) {
			throw new Error(`Expected one initial naming request: ${JSON.stringify(firstLog)}`);
		}

		const resumed = await createRpcTransport(
			command(sessionPath),
			temporaryDirectory,
			environment(temporaryDirectory, logPath, "Refreshed Session Naming"),
		);
		await withRpcTransport(resumed, "Resumed", async () => {
			const restoredEntries = entries(await resumed.send({ type: "get_entries" }));
			const restoredMarker = getLastRenameMarker(restoredEntries);
			if (
				restoredMarker?.mode !== "initial" ||
				restoredMarker.source !== "ai" ||
				restoredMarker.name !== "Semantic Session Naming"
			) {
				throw new Error(`Session Naming did not restore generated ownership: ${JSON.stringify(restoredMarker)}`);
			}
			const beforeForce = parseLog(await readFile(logPath, "utf8"));
			if (beforeForce.filter((record) => record["kind"] === "naming").length !== 1) {
				throw new Error("Resuming the Session triggered an unsolicited naming request");
			}
			await resumed.send({ type: "prompt", message: "/autoname" });
			const refreshedEntries = entries(await resumed.send({ type: "get_entries" }));
			const marker = getLastRenameMarker(refreshedEntries);
			if (marker?.mode !== "forced" || marker.source !== "ai" || marker.name !== "Refreshed Session Naming") {
				throw new Error(`/autoname did not persist forced regeneration: ${JSON.stringify(marker)}`);
			}
			if (sessionName(refreshedEntries) !== "Refreshed Session Naming") {
				throw new Error("Pi did not persist the refreshed Session name");
			}
			assertNoExtensionError(resumed);
		});

		const finalLog = parseLog(await readFile(logPath, "utf8"));
		if (finalLog.filter((record) => record["kind"] === "naming").length !== 2) {
			throw new Error(`Expected initial and forced naming requests: ${JSON.stringify(finalLog)}`);
		}
		const persisted = await readFile(sessionPath, "utf8");
		if (!persisted.includes("Semantic Session Naming") || !persisted.includes("Refreshed Session Naming")) {
			throw new Error("The real Session JSONL did not contain both generated names");
		}
		if (await Bun.file(join(agentDirectory, "pi-stuff.json")).exists()) {
			throw new Error("Session Naming created merged settings during startup");
		}
		if (await Bun.file(join(agentDirectory, "pi-autoname.json")).exists()) {
			throw new Error("Session Naming created the upstream standalone settings file");
		}
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}
