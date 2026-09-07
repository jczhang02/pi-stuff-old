import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { Guard } from "typebox/guard";
import {
	createBoundedPipeForwarder,
	POST_EXIT_OUTPUT_HARD_MS,
	POST_EXIT_OUTPUT_IDLE_MS,
} from "./writer-protocol-forwarder.mjs";

function isRuntimeNumber(value) {
	return (
		Guard.IsNumber(value) ||
		Object.is(value, Number.NaN) ||
		Object.is(value, Number.POSITIVE_INFINITY) ||
		Object.is(value, Number.NEGATIVE_INFINITY)
	);
}

function processStartIdentity(pid) {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) return undefined;
			const started = stat
				.slice(commandEnd + 1)
				.trim()
				.split(/\s+/u)[19];
			return started ? `linux:${started}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform !== "darwin" && process.platform !== "freebsd") return undefined;
	const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
	const started = result.status === 0 ? result.stdout.trim() : "";
	return started ? `${process.platform}:${started}` : undefined;
}

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && Guard.IsObject(error) && error.code === "EPERM";
	}
}

function linuxGroupMembers() {
	if (process.platform !== "linux") return [];
	const members = [];
	for (const entry of readdirSync("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
		const pid = Number(entry.name);
		if (pid === process.pid) continue;
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) continue;
			const fields = stat
				.slice(commandEnd + 1)
				.trim()
				.split(/\s+/u);
			if (Number(fields[2]) !== process.pid) continue;
			const started = fields[19];
			if (started) members.push({ pid, started: `linux:${started}` });
		} catch (error) {
			// ENOENT means this particular process exited between readdir and stat.
			// Any other failure makes the whole group scan inconclusive.
			if (!error || !Guard.IsObject(error) || (error.code !== "ENOENT" && error.code !== "ESRCH")) throw error;
		}
	}
	return members;
}

function bsdGroupMembers() {
	if (process.platform !== "darwin" && process.platform !== "freebsd") return [];
	const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,lstart="], {
		encoding: "utf-8",
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw (
			result.error ?? new Error(`Unable to inspect Agent writer process group (ps exited ${String(result.status)}).`)
		);
	}
	const members = [];
	for (const line of result.stdout.split(/\r?\n/u)) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const pgid = Number(match[2]);
		const started = match[3];
		if (pid === process.pid || pgid !== process.pid || !started) continue;
		members.push({ pid, started: `${process.platform}:${started}` });
	}
	return members;
}

function groupMembers() {
	if (process.platform === "linux") return linuxGroupMembers();
	if (process.platform === "darwin" || process.platform === "freebsd") return bsdGroupMembers();
	return child?.pid && childStarted ? [{ pid: child.pid, started: childStarted }] : [];
}

function signalMembers(signal, source) {
	let members;
	try {
		members = groupMembers();
	} catch {
		return false;
	}
	for (const member of members) {
		if (processStartIdentity(member.pid) !== member.started) continue;
		try {
			process.kill(member.pid, signal);
			rememberManagerSignal(member, signal, source);
		} catch {
			// The member may exit after the final identity check.
		}
	}
	return true;
}

function createControlChannel(input) {
	return Effect.gen(function* () {
		const events = yield* Queue.unbounded();
		let buffer = "";
		let ended = false;
		const finish = () => {
			if (ended) return;
			ended = true;
			if (buffer) Queue.offerUnsafe(events, { done: false, value: buffer });
			buffer = "";
			Queue.offerUnsafe(events, { done: true, value: undefined });
		};
		input.setEncoding("utf8");
		input.on("data", (chunk) => {
			if (ended) return;
			buffer += chunk;
			if (buffer.length > 4_096) {
				finish();
				return;
			}
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				Queue.offerUnsafe(events, { done: false, value: buffer.slice(0, newline).replace(/\r$/u, "") });
				buffer = buffer.slice(newline + 1);
			}
		});
		input.once("end", finish);
		input.once("close", finish);
		input.once("error", finish);
		input.resume();
		return {
			next: () => Queue.take(events),
			close() {
				finish();
				input.pause();
				input.destroy();
			},
		};
	});
}

function createFileControlChannel(filePath, token, parentPid, parentStarted) {
	return Effect.gen(function* () {
		const changes = yield* Queue.sliding(1);
		let lineCursor = 0;
		let lastSequence = 0;
		let closed = false;
		let changed = true;
		let watcher;
		try {
			watcher = watch(filePath, () => {
				changed = true;
				Queue.offerUnsafe(changes, undefined);
			});
		} catch {
			// The bounded liveness fallback below also observes appended commands.
		}
		const waitForChange = () => {
			if (changed) {
				changed = false;
				return Effect.void;
			}
			return Effect.raceFirst(Queue.take(changes), Effect.sleep(250)).pipe(Effect.asVoid);
		};
		const invalid = () => {
			closed = true;
			watcher?.close();
			return { done: false, value: "invalid" };
		};
		return {
			next: () =>
				Effect.gen(function* () {
					while (!closed) {
						if (processStartIdentity(parentPid) !== parentStarted) return { done: true, value: undefined };
						try {
							const content = readFileSync(filePath, "utf8");
							if (content.length > 64 * 1024) return invalid();
							const lines = content.split("\n");
							const completeLineCount = lines.length - 1;
							while (lineCursor < completeLineCount) {
								const line = lines[lineCursor++];
								let record;
								try {
									record = JSON.parse(line);
								} catch {
									return invalid();
								}
								if (
									record?.version !== 1 ||
									record.token !== token ||
									!Number.isSafeInteger(record.sequence) ||
									record.sequence <= lastSequence ||
									!Guard.IsString(record.command)
								) {
									return invalid();
								}
								lastSequence = record.sequence;
								return { done: false, value: record.command };
							}
						} catch (error) {
							if (!error || !Guard.IsObject(error) || error.code !== "ENOENT") return invalid();
						}
						yield* waitForChange();
					}
					return { done: true, value: undefined };
				}),
			close() {
				closed = true;
				watcher?.close();
				Queue.offerUnsafe(changes, undefined);
			},
		};
	});
}

function captureStartIdentity(pid, timeoutMs = 250) {
	const deadline = Date.now() + timeoutMs;
	return Effect.gen(function* () {
		for (;;) {
			const identity = processStartIdentity(pid);
			if (identity) return identity;
			if (!processExists(pid) || Date.now() >= deadline) return undefined;
			yield* Effect.sleep(20);
		}
	});
}

const encoded = process.argv[2];
if (!encoded) throw new Error("Agent writer supervisor requires a launch envelope.");
const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));

let child;
let childStarted;
let controlLines;
let lifecycleEvents;
let outputFibers = [];
let childOutputError;
let terminationSignal;
let pendingStop;
let settled = false;
let parentCheckAt;
let terminationForceAt;
let terminationForceArmed = false;
let terminationForceSource;
let finalizationForceAt;
let finalizationActive = false;
const managerSignalsByMember = new Map();

function wakeLifecycle() {
	if (lifecycleEvents) Queue.offerUnsafe(lifecycleEvents, { type: "wake" });
}

function memberKey(member) {
	return `${member.pid}:${member.started}`;
}

function rememberManagerSignal(member, signal, source) {
	const key = memberKey(member);
	const signals = managerSignalsByMember.get(key) ?? new Map();
	const sources = signals.get(signal) ?? new Set();
	sources.add(source);
	signals.set(signal, sources);
	managerSignalsByMember.set(key, signals);
}

function forgetManagerSignalSource(source) {
	for (const [key, signals] of managerSignalsByMember) {
		for (const [signal, sources] of signals) {
			sources.delete(source);
			if (sources.size === 0) signals.delete(signal);
		}
		if (signals.size === 0) managerSignalsByMember.delete(key);
	}
}

function managerSignalSourceForChild(signal) {
	if (!child?.pid || !childStarted || !Guard.IsString(signal)) return undefined;
	const sources = managerSignalsByMember.get(memberKey({ pid: child.pid, started: childStarted }))?.get(signal);
	// Same-signal deliveries cannot be causally disambiguated from the eventual
	// exit tuple. Fail closed: if an external delivery ever preceded or raced a
	// manager delivery to this exact process identity, preserve it as a crash.
	if (sources?.has("external")) return "external";
	if (sources?.has("termination")) return "termination";
	if (sources?.has("finalization")) return "finalization";
	return undefined;
}

function signalFromExitCode(code) {
	if (!isRuntimeNumber(code) || code <= 128 || code > 255) return undefined;
	const signalNumber = code - 128;
	return Object.entries(osConstants.signals).find(([, value]) => value === signalNumber)?.[0];
}

function writeTerminalDisposition(value) {
	if (!Guard.IsString(envelope.dispositionPath) || !envelope.dispositionPath) return;
	const temporary = `${envelope.dispositionPath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
	renameSync(temporary, envelope.dispositionPath);
}

function writeGroupMemberProof() {
	if (
		!Guard.IsString(envelope.groupMemberProofPath) ||
		!envelope.groupMemberProofPath ||
		!child?.pid ||
		!childStarted
	) {
		return;
	}
	const leaderStarted = processStartIdentity(process.pid);
	if (!leaderStarted) throw new Error("Agent writer supervisor lost its process-start identity.");
	const temporary = `${envelope.groupMemberProofPath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(
		temporary,
		`${JSON.stringify({
			version: 1,
			groupLeaderPid: process.pid,
			groupLeaderProcessStartIdentity: leaderStarted,
			memberPid: child.pid,
			memberProcessStartIdentity: childStarted,
		})}\n`,
		{ encoding: "utf-8", mode: 0o600, flag: "wx" },
	);
	renameSync(temporary, envelope.groupMemberProofPath);
}

function requestStop(signal, source = "termination") {
	const childSignal = signal === "SIGINT" ? "SIGINT" : "SIGTERM";
	if (source === "termination" && !terminationSignal) terminationSignal = childSignal;
	if (!child?.pid || !childStarted) {
		// A bare signal can arrive after the supervisor installs handlers but
		// before the child identity is captured. Preserve it and fail closed;
		// otherwise the subsequently spawned Pi process would run un-stopped.
		if (!pendingStop || source === "external") pendingStop = { signal: childSignal, source };
		return;
	}
	finalizationActive = false;
	finalizationForceAt = undefined;
	forgetManagerSignalSource("finalization");
	signalMembers(childSignal, source);
	if (!terminationForceArmed) {
		terminationForceArmed = true;
		terminationForceSource = source;
		terminationForceAt = Date.now() + 3_000;
	}
	wakeLifecycle();
}

function requestFinalization() {
	if (terminationSignal || finalizationActive || settled) return;
	finalizationActive = true;
	signalMembers("SIGTERM", "finalization");
	finalizationForceAt = Date.now() + 3_000;
	wakeLifecycle();
}

function cancelFinalization() {
	if (terminationSignal || settled) return;
	finalizationActive = false;
	finalizationForceAt = undefined;
	// Cancellation stops the future hard-kill, but cannot erase a SIGTERM that
	// was already delivered to this exact process identity. Retaining that
	// causal history distinguishes a delayed response to our signal from an
	// unrelated external signal of a different kind.
	wakeLifecycle();
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	// Only the private stdin control channel grants manager provenance. A bare
	// OS signal may come from a user, OOM supervisor, or unrelated process and
	// must remain an external crash even though we still reap the child safely.
	process.on(signal, () => requestStop(signal, "external"));
}

function handleControlCommand(command) {
	if (command === "finalize") requestFinalization();
	else if (command === "cancel-finalize") cancelFinalization();
	else if (command === "terminate-sigint") requestStop("SIGINT", "termination");
	else if (command === "terminate-sigterm") requestStop("SIGTERM", "termination");
	else requestStop("SIGTERM", "external");
}

function nextLifecycleDeadline(postExitAt, forwarders) {
	let deadline;
	const postExitDeadline =
		postExitAt === undefined
			? undefined
			: Math.min(
					postExitAt + POST_EXIT_OUTPUT_HARD_MS,
					Math.max(postExitAt, ...forwarders.map((forwarder) => forwarder.lastReadAt())) +
						POST_EXIT_OUTPUT_IDLE_MS,
				);
	for (const candidate of [parentCheckAt, terminationForceAt, finalizationForceAt, postExitDeadline]) {
		if (candidate !== undefined && (deadline === undefined || candidate < deadline)) deadline = candidate;
	}
	return deadline;
}

function processLifecycleDeadlines(postExitAt, forwarders) {
	const now = Date.now();
	if (terminationForceAt !== undefined && terminationForceAt <= now) {
		terminationForceAt = undefined;
		signalMembers("SIGKILL", terminationForceSource ?? "termination");
	}
	if (finalizationForceAt !== undefined && finalizationForceAt <= now) {
		finalizationForceAt = undefined;
		if (finalizationActive && !settled) signalMembers("SIGKILL", "finalization");
	}
	if (parentCheckAt !== undefined && parentCheckAt <= now) {
		if (processStartIdentity(envelope.parentPid) !== envelope.parentStarted) requestStop("SIGTERM", "external");
		parentCheckAt = now + 250;
	}
	if (postExitAt !== undefined) {
		const lastActivity = Math.max(postExitAt, ...forwarders.map((forwarder) => forwarder.lastReadAt()));
		if (now >= postExitAt + POST_EXIT_OUTPUT_HARD_MS || now - lastActivity >= POST_EXIT_OUTPUT_IDLE_MS) {
			for (const forwarder of forwarders) forwarder.close();
			return undefined;
		}
	}
	return postExitAt;
}

function awaitChildClose(forwarders) {
	return Effect.gen(function* () {
		let childExitTuple;
		let controlOpen = true;
		let postExitAt;
		for (;;) {
			let wait = Queue.take(lifecycleEvents);
			if (controlOpen) {
				wait = Effect.raceFirst(
					wait,
					controlLines.next().pipe(Effect.map((value) => ({ type: "control", value }))),
				);
			}
			const deadline = nextLifecycleDeadline(postExitAt, forwarders);
			if (deadline !== undefined) {
				wait = Effect.raceFirst(
					wait,
					Effect.sleep(Math.max(0, deadline - Date.now())).pipe(Effect.as({ type: "wake" })),
				);
			}
			const event = yield* wait;
			if (event.type === "close") return childExitTuple ?? event;
			if (event.type === "error") {
				childExitTuple = { code: 1, error: event.error, signal: null };
				postExitAt = Date.now();
			} else if (event.type === "exit") {
				childExitTuple = { code: event.code, signal: event.signal };
				postExitAt = Date.now();
			} else if (event.type === "control") {
				if (event.value.done) controlOpen = false;
				else handleControlCommand(event.value.value.trim());
			}
			postExitAt = processLifecycleDeadlines(postExitAt, forwarders);
		}
	});
}

function reapMembers() {
	return Effect.gen(function* () {
		let termRequested = false;
		let nextKillAt = 0;
		for (;;) {
			let members;
			try {
				members = groupMembers();
			} catch {
				// Never turn a transient group scan failure into false proof of exit.
				// The live supervisor remains the authenticated PGID anchor and retries.
				yield* Effect.sleep(250);
				continue;
			}
			if (members.length === 0) return true;
			if (!termRequested) {
				signalMembers("SIGTERM", "reap");
				termRequested = true;
				yield* Effect.sleep(150);
				continue;
			}
			if (Date.now() >= nextKillAt) {
				signalMembers("SIGKILL", "reap");
				nextKillAt = Date.now() + 1_000;
			}
			yield* Effect.sleep(100);
		}
	});
}

function settle(code, signal) {
	if (settled) return Effect.void;
	settled = true;
	parentCheckAt = undefined;
	terminationForceAt = undefined;
	finalizationForceAt = undefined;
	controlLines?.close();
	return Effect.gen(function* () {
		// `readline.close()` stops line parsing but does not close the inherited pipe.
		// Keeping that stdin handle referenced prevents Bun/Node from exiting after
		// the writer has settled, so the parent runner never observes `close`.
		if (!Guard.IsString(envelope.controlPath)) {
			process.stdin.pause();
			process.stdin.destroy();
		}
		const reaped = yield* reapMembers();
		for (const fiber of outputFibers) yield* Fiber.join(fiber);
		const observedSignal = signal ?? signalFromExitCode(code);
		// Preserve an unexpected external signal. A prior manager SIGTERM does not
		// authorize us to relabel a later external SIGKILL as manager-owned. Only a
		// signal actually sent to this exact child process identity establishes that
		// provenance; when it does, report the initiating manager signal so the
		// parent can recognize its own final-drain sequence.
		const managerSource = managerSignalSourceForChild(observedSignal);
		const signalCode =
			managerSource === "termination"
				? (terminationSignal ?? observedSignal)
				: managerSource === "finalization"
					? "SIGTERM"
					: observedSignal;
		const signalNumber = Guard.IsString(signalCode) ? osConstants.signals[signalCode] : undefined;
		try {
			const disposition = {
				version: 1,
				supervisorPid: process.pid,
				supervisorProcessStartIdentity: processStartIdentity(process.pid),
				childPid: child?.pid,
				childProcessStartIdentity: childStarted,
				exitCode: isRuntimeNumber(code) ? code : null,
				// Keep the child's raw exit tuple authoritative. `observedSignal` may be
				// inferred from an explicit 128+N exit code solely for provenance.
				signal: signal ?? null,
				origin:
					managerSource === "termination"
						? "manager-request"
						: managerSource === "finalization"
							? "manager-final-drain"
							: observedSignal
								? "external"
								: null,
				reaped,
			};
			if (childOutputError) {
				disposition.outputForwardingError = String(
					childOutputError instanceof Error ? childOutputError.message : childOutputError,
				).slice(0, 1_000);
			}
			writeTerminalDisposition(disposition);
		} catch (error) {
			process.stderr.write(
				`Agent writer supervisor failed to persist terminal disposition: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
		const supervisorExitCode =
			!reaped || childOutputError ? 1 : signalNumber ? 128 + signalNumber : isRuntimeNumber(code) ? code : 1;
		// Let inherited stdout/stderr drain after the child exit. Calling
		// `process.exit()` here can close the shared pipe before a fast Pi writer's
		// final JSON frames reach the parent runner.
		process.exitCode = supervisorExitCode;
	});
}

function supervise() {
	return Effect.gen(function* () {
		lifecycleEvents = yield* Queue.unbounded();
		controlLines = yield* Guard.IsString(envelope.controlPath) && Guard.IsString(envelope.controlToken)
			? createFileControlChannel(
					envelope.controlPath,
					envelope.controlToken,
					envelope.parentPid,
					envelope.parentStarted,
				)
			: createControlChannel(process.stdin);
		const startupControl = yield* controlLines.next();
		if (startupControl.done || startupControl.value.trim() !== "proceed") process.exit(125);
		if (processStartIdentity(envelope.parentPid) !== envelope.parentStarted) process.exit(125);

		child = spawn(envelope.command, envelope.args, {
			cwd: process.cwd(),
			detached: false,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (!child.stdout || !child.stderr) {
			throw new Error("Agent writer supervisor failed to open child output pipes.");
		}
		child.once("error", (error) => Queue.offerUnsafe(lifecycleEvents, { type: "error", error }));
		child.once("exit", (code, signal) => Queue.offerUnsafe(lifecycleEvents, { type: "exit", code, signal }));
		child.once("close", (code, signal) => Queue.offerUnsafe(lifecycleEvents, { type: "close", code, signal }));

		const stdoutForwarder = createBoundedPipeForwarder(
			child.stdout,
			process.stdout,
			() => requestStop("SIGTERM", "termination"),
			true,
			wakeLifecycle,
		);
		const stderrForwarder = createBoundedPipeForwarder(
			child.stderr,
			process.stderr,
			() => requestStop("SIGTERM", "termination"),
			false,
			wakeLifecycle,
		);
		const outputForwarders = [stdoutForwarder, stderrForwarder];
		outputFibers = [];
		for (const forwarder of outputForwarders) {
			outputFibers.push(
				yield* Effect.forkScoped(
					forwarder.run.pipe(
						Effect.catch((error) =>
							Effect.sync(() => {
								childOutputError ??= error;
								requestStop("SIGTERM", "external");
							}),
						),
					),
					// Attach readers before Bun can drain an already-exited child's unobserved pipes.
					{ startImmediately: true },
				),
			);
		}

		childStarted = child.pid ? yield* captureStartIdentity(child.pid) : undefined;
		if (!child.pid || !childStarted) {
			try {
				child.kill("SIGKILL");
			} catch {}
			yield* settle(1, "SIGKILL");
			return;
		}
		writeGroupMemberProof();
		if (pendingStop) {
			const stop = pendingStop;
			pendingStop = undefined;
			requestStop(stop.signal, stop.source);
		} else if (terminationSignal) requestStop(terminationSignal);
		else parentCheckAt = Date.now() + 250;
		const result = yield* awaitChildClose(outputForwarders);
		if (result.error) process.stderr.write(`Agent writer spawn failed: ${result.error.message}\n`);
		yield* settle(result.code, result.signal);
	});
}

const supervisor = supervise().pipe(
	Effect.catchCause((cause) => {
		const error = Cause.squash(cause);
		return Effect.sync(() => {
			process.stderr.write(
				`Agent writer supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}).pipe(Effect.andThen(settle(1, null)));
	}),
);

await Effect.runPromise(Effect.scoped(supervisor));
