import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAGIC_WORKER_PROTOCOL_VERSION,
	type MagicWorkerReadyMessage,
} from "../../../packages/pi-stuff/src/context-management/magic-worker-protocol.js";
import {
	buildMagicWorkerBundle,
	startMagicWorkerFromBundle,
} from "../../../packages/pi-stuff/src/context-management/magic-worker-transport.js";

const bundle = await buildMagicWorkerBundle();

async function initializeWithProcess(command: string, scriptName?: string): Promise<MagicWorkerReadyMessage> {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-migration-guard-"));
	const bin = join(directory, "bin");
	await mkdir(bin);
	await mkdir(join(directory, "config/cortexkit"), { recursive: true });
	await writeFile(
		join(directory, "config/cortexkit/magic-context.jsonc"),
		JSON.stringify({
			embedding: { provider: "off" },
			fail_closed_blocking: false,
			dreamer: { disable: true },
			sidekick: { disable: true },
		}),
	);
	// Only the OS process-list boundary is substituted; the real Worker opens a fresh database.
	await writeFile(join(bin, "ps"), '#!/bin/sh\nprintf "%s\\n" "$PI_STUFF_TEST_PROCESS_LIST"\n', { mode: 0o700 });
	let child: ReturnType<typeof Bun.spawn> | undefined;
	if (scriptName) {
		const entry = join(directory, scriptName);
		await mkdir(join(entry, ".."), { recursive: true });
		await writeFile(entry, "setInterval(() => {}, 1000);");
		child = Bun.spawn([process.execPath, entry, "--pi", "/opt/pi-coding-agent/pi"], {
			stdout: "ignore",
			stderr: "ignore",
		});
	}
	const environment = {
		HOME: directory,
		XDG_CONFIG_HOME: join(directory, "config"),
		XDG_DATA_HOME: join(directory, "data"),
		XDG_CACHE_HOME: join(directory, "cache"),
		PI_CODING_AGENT_DIR: join(directory, "agent"),
		PI_OFFLINE: "1",
		PATH: `${bin}:${process.env["PATH"] ?? ""}`,
		PI_STUFF_TEST_PROCESS_LIST: `${child?.pid ?? 42424242} ${command}`,
		MAGIC_CONTEXT_LOG_PATH: join(directory, "magic.log"),
	};
	const keys = new Set([
		...Object.keys(environment),
		...Object.keys(process.env).filter(
			(name) => name.startsWith("MAGIC_CONTEXT_") || name.startsWith("PI_SUBAGENT_PARENT_"),
		),
	]);
	const previous = new Map([...keys].map((name) => [name, process.env[name]]));
	for (const name of keys) delete process.env[name];
	Object.assign(process.env, environment);
	try {
		const handle = startMagicWorkerFromBundle(bundle);
		const ready = Promise.withResolvers<MagicWorkerReadyMessage>();
		const timeout = setTimeout(() => ready.reject(new Error("Magic initialization timed out")), 10_000);
		try {
			handle.port.onerror = (event) => {
				event.preventDefault();
				ready.reject(new Error(event.message));
			};
			handle.port.onmessage = ({ data }) => {
				if (data.type === "ready") ready.resolve(data);
				if (data.type === "error") ready.reject(new Error(data.error));
			};
			handle.port.postMessage({
				type: "initialize",
				id: 1,
				protocolVersion: MAGIC_WORKER_PROTOCOL_VERSION,
				hostTools: [],
			});
			return await ready.promise;
		} finally {
			clearTimeout(timeout);
			await handle.release();
		}
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		child?.kill();
		await child?.exited;
		await rm(directory, { recursive: true, force: true });
	}
}

test.each(["observer.ts", "Scripts With Spaces/observer.js"])(
	"a Bun observer's Pi argument does not block initialization: %s",
	async (scriptName) => {
		const ready = await initializeWithProcess(`/usr/bin/bun ${scriptName} --pi /opt/pi-coding-agent/pi`, scriptName);
		expect(ready.events).toContain("context");
		expect(ready.tools.map((tool) => tool.name)).toContain("ctx_search");
	},
);

test.each([
	"/usr/bin/pi --print task",
	"/usr/bin/omp --print task",
	"/usr/bin/oh-my-pi --print task",
	"/usr/bin/bun /opt/pi-coding-agent/dist/cli.js",
	"/usr/bin/node /opt/pi-coding-agent/dist/cli.js",
	"/usr/bin/deno /opt/pi-coding-agent/cli.ts",
	"/usr/bin/node /opt/pi.js",
	"/usr/bin/bun /opt/pi.mjs",
	"/usr/bin/node /opt/pi.cjs",
	"/usr/bin/node --enable-source-maps /opt/pi-coding-agent/dist/cli.js",
	"/usr/bin/bun run /opt/pi-coding-agent/cli.ts",
	"/usr/bin/deno run --allow-read /opt/pi-coding-agent/cli.ts",
])("an OS-listed Pi candidate still blocks migration when argv is unreadable: %s", async (command) => {
	const ready = await initializeWithProcess(command);
	expect(ready.events).not.toContain("context");
	expect(ready.tools).toEqual([]);
});

test.each([
	"pi.js",
	"pi-coding-agent/cli.js",
	"Pi Tools/pi-coding-agent/cli.js",
	"folder.js with spaces/pi-coding-agent/cli.js",
])("a real interpreted Pi entrypoint still blocks migration: %s", async (scriptName) => {
	const ready = await initializeWithProcess(`/usr/bin/bun ${scriptName}`, scriptName);
	expect(ready.events).not.toContain("context");
	expect(ready.tools).toEqual([]);
});

test("unreadable argv retains conservative migration protection", async () => {
	const ready = await initializeWithProcess("/usr/bin/bun observer.ts --pi /opt/pi-coding-agent/pi");
	expect(ready.events).not.toContain("context");
	expect(ready.tools).toEqual([]);
});
