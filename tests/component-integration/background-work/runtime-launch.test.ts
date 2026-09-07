import { afterEach, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import {
	activateDiagnosticChannel,
	type BackgroundWorkOutcome,
	BoundedOutputFile,
	captureProcessIdentityWithRetry,
	cleanupRuntimeFixtures,
	closeSync,
	configuredRuntime,
	context,
	DiagnosticChannel,
	existsSync,
	foregroundOutputSnapshot,
	join,
	mkdirSync,
	processExists,
	projectNotificationBatch,
	Readable,
	readdirSync,
	renameSync,
	resolve,
	statSync,
	TEST_WORK_AUTHORITY_KEY,
	temporaryRoot,
	tryReadBoundedTail,
	WorkRunStorage,
	waitUntil,
	writeFileSync,
} from "../../work/runtime-fixtures.js";

afterEach(cleanupRuntimeFixtures);

test("bounds durable output while retaining the newest evidence", () => {
	const root = temporaryRoot();
	const path = join(root, "output");
	let observedPublicationBoundary = false;
	let readBetweenPublications: string | undefined;
	const output = new BoundedOutputFile(path, 256, {
		renameSync: (source, destination) => {
			renameSync(source, destination);
			if (destination === path) {
				observedPublicationBoundary = true;
				readBetweenPublications = tryReadBoundedTail(path);
			}
		},
	});
	const initialInode = statSync(path).ino;
	output.append(Buffer.from(`\u001b[31m${"x".repeat(70_000)}\u001b[0m`));
	output.append(Buffer.from("LATEST-EVIDENCE\n"));
	output.close();

	expect(statSync(path).size).toBeLessThanOrEqual(256);
	expect(statSync(path).ino).not.toBe(initialInode);
	expect(observedPublicationBoundary).toBeTrue();
	expect(readBetweenPublications).toContain("earlier output bytes omitted");
	expect(output.overflowed).toBeTrue();
	expect(output.durable).toBeTrue();
	expect(tryReadBoundedTail(path, 1_024)).toEndWith("LATEST-EVIDENCE");
	expect(tryReadBoundedTail(path, 1_024)).toContain("earlier output bytes omitted");
	expect(tryReadBoundedTail(path, 80)).toStartWith("…[68");
	expect(output.recentText(1_024)).toContain("LATEST-EVIDENCE");
	expect(output.recentText(1_024)).toContain("earlier output bytes omitted");
	expect(output.recentText()).not.toContain("\u001b[");
	expect(output.recentText()).not.toContain("stopped this task");
	expect(foregroundOutputSnapshot(path, output.recentText()).details).toMatchObject({
		omittedBytes: expect.any(Number),
		retainedOutputPath: path,
	});
});

test("retains the newest suffix with room for subsequent appends", () => {
	const path = join(temporaryRoot(), "full-retained-suffix");
	const output = new BoundedOutputFile(path, 70_000);
	output.append(Buffer.from("a".repeat(60_000)));
	output.append(Buffer.from("b".repeat(20_000)));
	output.close();

	expect(statSync(path).size).toBe(35_000);
	expect(tryReadBoundedTail(path, 80_000)).toStartWith("…[43.9KB earlier output bytes omitted]\n");
	expect(tryReadBoundedTail(path, 80_000)).toEndWith("b".repeat(20_000));
});

test("keeps the prior output generation readable when rollover publication fails", () => {
	const path = join(temporaryRoot(), "failed-rollover-publication");
	const output = new BoundedOutputFile(path, 70_000, {
		renameSync: (source, destination) => {
			if (destination === path) throw Object.assign(new Error("injected rename EIO"), { code: "EIO" });
			renameSync(source, destination);
		},
	});
	output.append(Buffer.from(`PRIOR-${"a".repeat(59_994)}`));
	output.append(Buffer.from("b".repeat(20_000)));
	output.close();

	expect(output.durable).toBeFalse();
	expect(tryReadBoundedTail(path, 70_000)).toStartWith("PRIOR-");
});

test("keeps published output readable when metadata compaction fails", () => {
	const path = join(temporaryRoot(), "failed-metadata-compaction");
	let metadataRenames = 0;
	const output = new BoundedOutputFile(path, 256, {
		renameSync: (source, destination) => {
			if (destination === `${path}.omitted-bytes` && ++metadataRenames === 2) {
				throw Object.assign(new Error("injected compact EIO"), { code: "EIO" });
			}
			renameSync(source, destination);
		},
	});
	output.append(Buffer.from("x".repeat(1_000)));
	output.close();

	expect(output.durable).toBeTrue();
	expect(tryReadBoundedTail(path)).toContain("earlier output bytes omitted");
});

test("preserves terminal newlines and UTF-8 boundaries in foreground suffixes", () => {
	const path = join(temporaryRoot(), "foreground-lines");
	writeFileSync(path, `${"界".repeat(20_000)}\n`, { mode: 0o600 });

	const snapshot = foregroundOutputSnapshot(path, undefined);
	expect(snapshot.text).not.toContain("�");
	expect(snapshot.text).toContain("\n\n\n[Showing last");
});

test("preserves cumulative omission in a truncated foreground result", () => {
	const root = temporaryRoot();
	const path = join(root, "foreground-output");
	const output = new BoundedOutputFile(path, 140_000);
	output.append(Buffer.from("x".repeat(200_000)));
	output.append(Buffer.from("\nLATEST-EVIDENCE\n"));
	output.close();

	const snapshot = foregroundOutputSnapshot(path, output.recentText());
	expect(snapshot.text).toStartWith("…[195.3KB");
	expect(snapshot.text).toContain("LATEST-EVIDENCE");
	expect(snapshot.text).toContain("Retained output:");
	expect(snapshot.text).not.toContain("Full output:");
	expect(snapshot.details).toMatchObject({ omittedBytes: 130_000, retainedOutputPath: path });
	expect(snapshot.details).not.toHaveProperty("fullOutputPath");
});

test("counts malformed UTF-8 bytes exactly in retained output", () => {
	const path = join(temporaryRoot(), "binary-output");
	const output = new BoundedOutputFile(path, 70_000);
	output.append(Buffer.alloc(100_000, 0xff));
	output.close();

	const snapshot = foregroundOutputSnapshot(path, output.recentText());
	expect(snapshot.text).toStartWith("…[81.0KB earlier output bytes omitted]");
	const truncation = snapshot.details?.truncation;
	if (!truncation) throw new Error("expected malformed output truncation details");
	expect(truncation.totalBytes).toBe(100_000);
	expect(truncation.outputBytes).toBeLessThanOrEqual(50 * 1_024);
});

test("falls back instead of pairing output with mismatched omission metadata", () => {
	const path = join(temporaryRoot(), "mismatched-generation");
	const output = new BoundedOutputFile(path, 256);
	output.append(Buffer.from("x".repeat(1_000)));
	output.close();
	writeFileSync(`${path}.omitted-bytes`, "0:0:123", { mode: 0o600 });

	expect(tryReadBoundedTail(path)).toBeUndefined();
	expect(foregroundOutputSnapshot(path, "MEMORY-FALLBACK").text).toBe("MEMORY-FALLBACK");
});

test("preserves a multibyte character split across a durable rollover", () => {
	const path = join(temporaryRoot(), "split-utf8-output");
	const output = new BoundedOutputFile(path, 64);
	output.append(Buffer.concat([Buffer.from("x".repeat(64)), Buffer.from([0xe2])]));
	output.append(Buffer.from([0x82, 0xac]));
	output.close();

	const retained = tryReadBoundedTail(path) ?? "";
	expect(retained).toEndWith("€");
	expect(retained).not.toContain("�");
});

test("preserves command output that resembles an internal omission marker", () => {
	const path = join(temporaryRoot(), "literal-marker-output");
	const literal = "…[123 earlier output bytes omitted]\nREAL-OUTPUT";
	writeFileSync(path, literal, { mode: 0o600 });

	expect(tryReadBoundedTail(path)).toBe(literal);
	expect(foregroundOutputSnapshot(path, undefined).text).toBe(literal);
});

test("rejects timer slices that the runtime cannot schedule safely", () => {
	expect(() => configuredRuntime(temporaryRoot(), { maxTimeoutSliceMs: 2_147_483_648 })).toThrow(
		"timer slice must be a positive safe integer no greater than 2147483647",
	);
});

test("degrades write and close failures to the bounded in-memory tail", () => {
	const root = temporaryRoot();
	const writeFailure = new BoundedOutputFile(join(root, "write-failure"), 1_024, {
		writeSync: () => {
			throw Object.assign(new Error("injected write EIO"), { code: "EIO" });
		},
	});
	expect(writeFailure.append(Buffer.from("MEMORY-WRITE-TAIL\n"))).toBe(true);
	expect(writeFailure.durable).toBe(false);
	expect(writeFailure.recentText()).toContain("MEMORY-WRITE-TAIL");
	expect(writeFailure.recentText()).toContain("injected write EIO");
	expect(() => writeFailure.close()).not.toThrow();

	const closeFailure = new BoundedOutputFile(join(root, "close-failure"), 1_024, {
		closeSync: (fd) => {
			closeSync(fd);
			throw Object.assign(new Error("injected close EIO"), { code: "EIO" });
		},
	});
	expect(closeFailure.append(Buffer.from("MEMORY-CLOSE-TAIL\n"))).toBe(true);
	expect(() => closeFailure.close()).not.toThrow();
	expect(closeFailure.durable).toBe(false);
	expect(closeFailure.recentText()).toContain("MEMORY-CLOSE-TAIL");
	expect(closeFailure.recentText()).toContain("injected close EIO");
});

test("keeps in-memory and on-disk UTF-8 tails on character boundaries", () => {
	const root = temporaryRoot();
	const path = join(root, "multibyte-output");
	const output = new BoundedOutputFile(path, 1_024);
	expect(output.append(Buffer.from("界".repeat(1_000), "utf-8"))).toBe(true);
	const memoryTail = output.recentText(5);
	output.close();
	const diskTail = tryReadBoundedTail(path, 5) ?? "";

	expect(memoryTail).toEndWith("界");
	expect(diskTail).toEndWith("界");
	expect(memoryTail).not.toContain("�");
	expect(diskTail).not.toContain("�");
});

test("keeps every projected notification body below its hard byte cap", () => {
	const outcomes = Array.from({ length: 1_000 }, (_, index) => ({
		endedAt: 2,
		id: `task-${String(index)}-${"界<&".repeat(100)}`,
		kind: "shell" as const,
		recentOutput: "payload".repeat(10_000),
		startedAt: 1,
		status: "completed" as const,
		summary: "summary<&界".repeat(100),
		title: "title".repeat(100),
	}));
	const projected = projectNotificationBatch(outcomes);
	expect(Buffer.byteLength(projected.content, "utf-8")).toBeLessThanOrEqual(64 * 1024);
	expect(projected.content).toContain('count="1000"');
	expect(projected.outcomes).toHaveLength(1_000);
});

test("uses a real line break in truncated inline notification output", () => {
	const projected = projectNotificationBatch([
		{
			endedAt: 2,
			id: "truncated-output",
			kind: "shell",
			recentOutput: "payload".repeat(10_000),
			startedAt: 1,
			status: "completed",
			summary: "done",
			title: "truncated output",
		},
	]);
	expect(projected.content).toContain("<recent_output>[earlier output omitted]\n");
	expect(projected.content).not.toContain("[earlier output omitted]\\n");
	expect(projected.outcomes[0]?.recentOutput).toStartWith("[earlier output omitted]\n");
});

test("uses bounded inline output when an existing output path is too long to disclose", () => {
	const root = temporaryRoot();
	let directory = root;
	while (Buffer.byteLength(join(directory, "output.log"), "utf-8") <= 2_100) {
		directory = join(directory, "p".repeat(100));
	}
	mkdirSync(directory, { recursive: true });
	const outputPath = join(directory, "output.log");
	writeFileSync(outputPath, "FULL");
	const [outcome] = projectNotificationBatch([
		{
			endedAt: 2,
			id: "long-path",
			kind: "shell",
			outputPath,
			recentOutput: "INLINE-FALLBACK",
			startedAt: 1,
			status: "completed",
			summary: "done",
			title: "long path",
		},
	]).outcomes;
	expect(outcome?.outputPath).toBeUndefined();
	expect(outcome?.recentOutput).toBe("INLINE-FALLBACK");
});

test("keeps an unverified stale runtime in diagnostics without raising a main-UI notice", async () => {
	const root = temporaryRoot();
	const diagnostics = new DiagnosticChannel();
	activateDiagnosticChannel(diagnostics);
	const active = configuredRuntime(root, {
		reconcileStale: async () => ({ cleanedDirectories: 0, killedProcesses: 0, unresolvedDirectories: 1 }),
	});

	await active.prepare();
	expect(diagnostics.list()).toHaveLength(1);
	expect(diagnostics.list()[0]?.summary).toContain("unverified stale runtime directory was left untouched");
	expect(diagnostics.listNotices()).toEqual([]);
	await active.shutdown();
});

test("retries stale-runtime preparation after a transient failure", async () => {
	const root = temporaryRoot();
	let attempts = 0;
	const active = configuredRuntime(root, {
		reconcileStale: async () => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error("injected recovery EIO"), { code: "EIO" });
			return { cleanedDirectories: 0, killedProcesses: 0, unresolvedDirectories: 0 };
		},
	});

	await expect(active.prepare()).rejects.toThrow("injected recovery EIO");
	await expect(active.prepare()).resolves.toBeUndefined();
	expect(attempts).toBe(2);
	await active.shutdown();
});

test("does not open an output file when command authorization path resolution fails", async () => {
	const root = temporaryRoot();
	class AuthorizationPathFailsStorage extends WorkRunStorage {
		override commandAuthorizationPath(): string {
			throw Object.assign(new Error("injected command path EIO"), { code: "EIO" });
		}
	}
	let outputFactoryCalls = 0;
	const active = configuredRuntime(root, {
		outputFactory: (filePath) => {
			outputFactoryCalls += 1;
			return new BoundedOutputFile(filePath);
		},
		storage: new AuthorizationPathFailsStorage(root, "work-test-session", {
			authorityKey: TEST_WORK_AUTHORITY_KEY,
		}),
	});

	await expect(active.executeBash({ command: "printf 'must-not-start\\n'" }, context(root))).rejects.toThrow(
		"injected command path EIO",
	);
	expect(active.detachActiveForeground()).toBeFalse();
	expect(outputFactoryCalls).toBe(0);
	expect(
		readdirSync(resolve(root, ".pi", "tasks"), { recursive: true }).some((entry) =>
			String(entry).endsWith(".output"),
		),
	).toBeFalse();
	await active.shutdown();
});

test("shutdown cleans and awaits a supervisor when launch identity capture fails", async () => {
	const root = temporaryRoot();
	const marker = join(root, "must-not-run");
	const { promise: identityGate, resolve: releaseIdentity } = Promise.withResolvers<void>();
	const { promise: captureStarted, resolve: identityCaptureStarted } = Promise.withResolvers<void>();
	let supervisorPid: number | undefined;
	const storage = new WorkRunStorage(root, "work-test-session", { authorityKey: TEST_WORK_AUTHORITY_KEY });
	const active = configuredRuntime(root, {
		captureSupervisorIdentity: async (pid) => {
			supervisorPid = pid;
			identityCaptureStarted();
			await identityGate;
			throw new Error("injected supervisor identity EIO");
		},
		storage,
	});

	const execution = active.executeBash({ command: `touch ${JSON.stringify(marker)}` }, context(root));
	await captureStarted;
	let shutdownSettled = false;
	const shutdown = active.shutdown().then(() => {
		shutdownSettled = true;
	});
	await Bun.sleep(25);
	expect(shutdownSettled).toBeFalse();
	releaseIdentity();
	await expect(execution).rejects.toThrow("injected supervisor identity EIO");
	await shutdown;

	expect(supervisorPid).toBeNumber();
	const supervisorSurvived = supervisorPid !== undefined && processExists(supervisorPid);
	if (supervisorPid !== undefined && supervisorSurvived) process.kill(supervisorPid, "SIGKILL");
	expect(supervisorSurvived).toBeFalse();
	expect(existsSync(marker)).toBeFalse();
	expect(active.snapshot()).toHaveLength(0);
	const runtimeFiles = storage.directory ? readdirSync(storage.directory) : [];
	expect(runtimeFiles.some((entry) => entry.endsWith(".command") || entry.endsWith(".ack"))).toBeFalse();
});

test("bounds shutdown when an external monitor ignores cancellation", async () => {
	const root = temporaryRoot();
	const active = configuredRuntime(root, {
		shutdownGraceMs: 10,
	});
	active.registerMonitor({
		cancel: async () => new Promise<BackgroundWorkOutcome>(() => undefined),
		id: "m-stalled-cleanup",
		outcome: new Promise<BackgroundWorkOutcome>(() => undefined),
		readOutput: () => "still running",
		snapshot: () => ({
			id: "m-stalled-cleanup",
			kind: "monitor",
			startedAt: 1,
			status: "running",
			title: "Stalled cleanup",
		}),
	});

	const startedAt = performance.now();
	await active.shutdown();

	expect(performance.now() - startedAt).toBeLessThan(100);
	expect(active.snapshot()).toHaveLength(0);
});

test("reserves the sixteenth activity slot before supervisor identity capture completes", async () => {
	const root = temporaryRoot();
	const { promise: captureGate, resolve: releaseCaptures } = Promise.withResolvers<void>();
	let captureCalls = 0;
	const active = configuredRuntime(root, {
		captureSupervisorIdentity: async (pid) => {
			captureCalls += 1;
			await captureGate;
			return captureProcessIdentityWithRetry(pid);
		},
	});
	for (let index = 0; index < 15; index += 1) {
		const id = `m-reserved-slot-${String(index)}`;
		const outcome: BackgroundWorkOutcome = {
			endedAt: 2,
			id,
			kind: "monitor",
			startedAt: 1,
			status: "stopped",
			summary: "Monitor stopped",
			title: "Capacity fixture",
		};
		active.registerMonitor({
			cancel: async () => outcome,
			id,
			outcome: new Promise<BackgroundWorkOutcome>(() => {}),
			readOutput: () => "Waiting for the condition.",
			snapshot: () => ({
				id,
				kind: "monitor",
				startedAt: 1,
				status: "running",
				title: "Capacity fixture",
			}),
		});
	}

	const launches = Array.from({ length: 2 }, () => active.executeBash({ command: ":" }, context(root)));
	const outcomesPromise = Promise.allSettled(launches);
	await waitUntil(() => captureCalls === 1);
	releaseCaptures();
	const outcomes = await outcomesPromise;
	expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
	const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
	expect(rejected).toHaveLength(1);
	expect(String(rejected[0]?.reason)).toContain("At most 16 Background Work activities");
	expect(captureCalls).toBe(1);
	await active.shutdown();
});

test("queues a manual foreground detach while supervisor identity is still being captured", async () => {
	const root = temporaryRoot();
	const { promise: captureGate, resolve: releaseCapture } = Promise.withResolvers<void>();
	const { promise: started, resolve: captureStarted } = Promise.withResolvers<void>();
	const active = configuredRuntime(root, {
		captureSupervisorIdentity: async (pid) => {
			captureStarted();
			await captureGate;
			return captureProcessIdentityWithRetry(pid);
		},
	});

	const execution = active.executeBash({ command: "sleep 30" }, context(root));
	await started;
	expect(active.detachActiveForeground()).toBeTrue();
	expect(active.detachActiveForeground()).toBeFalse();
	releaseCapture();
	const result = await execution;
	const text = result.content.find((item) => item.type === "text");
	expect(text?.type === "text" ? text.text : "").toContain("manually moved to background task");
	const activeTasks = active.snapshot();
	expect(activeTasks).toHaveLength(1);
	expect(result.details?.backgroundTaskId).toBe(activeTasks[0]?.id);
	expect(result.details?.fullOutputPath).toBe(activeTasks[0]?.outputPath);
	await active.shutdown();
});

test("keeps the Host event loop responsive while concurrent supervisor identities become readable", async () => {
	const attempts = new Map<number, number>();
	let heartbeat = 0;
	const timer = setInterval(() => {
		heartbeat += 1;
	}, 1);
	try {
		const identities = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				captureProcessIdentityWithRetry(10_000 + index, 250, {
					capture: (pid) => {
						const attempt = (attempts.get(pid) ?? 0) + 1;
						attempts.set(pid, attempt);
						return attempt >= 4 ? { pid, started: `test:${pid}` } : undefined;
					},
					exists: () => true,
				}),
			),
		);
		expect(identities).toHaveLength(20);
		expect(identities.every(Boolean)).toBeTrue();
		expect(heartbeat).toBeGreaterThan(5);
	} finally {
		clearInterval(timer);
	}
});

test("accepts a command acknowledgement after a fast supervisor exit", async () => {
	const root = temporaryRoot();
	const supervisorIdentity = { pid: 987_654, started: "test:fast-supervisor" };
	const active = configuredRuntime(root, {
		captureSupervisorIdentity: async () => supervisorIdentity,
		supervisorFactory: (_executable, encoded) => {
			const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
			let resolveCompletion!: (value: { code: number; signal: null }) => void;
			const completion = new Promise<{ code: number; signal: null }>((resolve) => {
				resolveCompletion = resolve;
			});
			setTimeout(() => {
				writeFileSync(
					envelope.commandAcknowledgementPath,
					`${JSON.stringify({
						version: 1,
						token: envelope.commandAuthorizationToken,
						supervisorPid: supervisorIdentity.pid,
						supervisorStarted: supervisorIdentity.started,
					})}\n`,
					{ mode: 0o600 },
				);
				resolveCompletion({ code: 0, signal: null });
			}, 0);
			const control = Readable.from([Buffer.from('{"type":"ready"}\n')]);
			return {
				closeControl: () => control.destroy(),
				completion,
				control,
				kill: () => {},
				output: Readable.from([]),
				pid: supervisorIdentity.pid,
				unref: () => {},
			};
		},
	});

	const result = await active.executeBash({ command: ":" }, context(root));
	expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
	await active.shutdown();
});

test("waits for delayed supervisor readiness before publishing command authorization", async () => {
	const root = temporaryRoot();
	if (!Bun.which("node")) throw new Error("node is required for the delayed supervisor fixture");
	const wrapper = join(root, "delayed-supervisor");
	writeFileSync(wrapper, '#!/bin/sh\nsleep 3.2\nexec node "$@"\n');
	chmodSync(wrapper, 0o755);
	const active = configuredRuntime(root, { supervisorExecutable: wrapper });

	const result = await active.executeBash({ command: "printf 'delayed-ready\\n'" }, context(root));

	expect(result.content).toEqual([{ type: "text", text: "delayed-ready\n" }]);
	await active.shutdown();
});

test("a supervisor that exits before readiness never receives the command", async () => {
	const root = temporaryRoot();
	const marker = join(root, "must-not-run");
	const wrapper = join(root, "failed-supervisor");
	writeFileSync(wrapper, "#!/bin/sh\nsleep 0.1\nexit 7\n", { mode: 0o755 });
	const active = configuredRuntime(root, { supervisorExecutable: wrapper });
	await expect(active.executeBash({ command: `touch '${marker}'` }, context(root))).rejects.toThrow(
		"exited before becoming ready",
	);
	await active.shutdown();
	expect(existsSync(marker)).toBeFalse();
	expect(active.snapshot()).toHaveLength(0);
});

test("shutdown cancels a pending readiness handshake without releasing the command", async () => {
	const root = temporaryRoot();
	const marker = join(root, "must-not-run");
	const wrapper = join(root, "not-ready.mjs");
	writeFileSync(wrapper, "#!/usr/bin/env node\nsetTimeout(() => process.exit(7), 1000);\n", { mode: 0o755 });
	let supervisorPid: number | undefined;
	const active = configuredRuntime(root, {
		supervisorExecutable: wrapper,
		captureSupervisorIdentity: async (pid) => {
			supervisorPid = pid;
			return captureProcessIdentityWithRetry(pid);
		},
	});
	const execution = active.executeBash({ command: `touch '${marker}'` }, context(root));
	const rejected = expect(execution).rejects.toThrow();
	await waitUntil(() => supervisorPid !== undefined);
	await Bun.sleep(25);
	await active.shutdown();
	await rejected;
	expect(existsSync(marker)).toBeFalse();
	expect(supervisorPid !== undefined && processExists(supervisorPid)).toBeFalse();
	expect(active.snapshot()).toHaveLength(0);
});

test("amortizes rollover writes across small output chunks", () => {
	const path = join(temporaryRoot(), "amortized-output");
	let replacementBytes = 0;
	const output = new BoundedOutputFile(path, 64_000, {
		renameSync: (source, destination) => {
			if (destination === path) replacementBytes += statSync(source).size;
			renameSync(source, destination);
		},
	});
	output.append(Buffer.alloc(64_000));
	for (let index = 0; index < 100; index++) output.append(Buffer.alloc(1_000));
	output.close();
	expect(output.durable).toBeTrue();
	expect(replacementBytes).toBeLessThan(164_000);
	expect(statSync(path).size).toBeLessThanOrEqual(64_000);
});
