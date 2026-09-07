import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { boundTerminalLine } from "../tool-display/index.js";

const RESOLVE_TIMEOUT_MS = 600;
const VERSION_TIMEOUT_MS = 1_000;
const REWRITE_TIMEOUT_MS = 2_500;

export const CERTIFIED_RTK_VERSION = "0.45.0";

export type RtkRuntimeState = "drifted" | "ready" | "unavailable" | "unchecked";

export interface RtkRuntimeSnapshot {
	readonly lastError?: string;
	readonly path?: string;
	readonly sha256?: string;
	readonly state: RtkRuntimeState;
	readonly version?: string;
}

export interface RtkRuntimeOptions {
	readonly expectedVersion?: string;
	readonly resolveTimeoutMs?: number;
	readonly rewriteTimeoutMs?: number;
	readonly versionTimeoutMs?: number;
}

interface RuntimeCertificate {
	readonly fingerprint: string;
	readonly path: string;
	readonly selectedPath: string;
	readonly sha256: string;
	readonly version: string;
}

interface VerifyOptions {
	readonly refresh?: boolean;
}

type RtkProcessHost = Pick<ExtensionAPI, "exec">;

function cleanOneLine(cause: unknown): string {
	const text = cause instanceof Error ? cause.message : String(cause);
	return boundTerminalLine(text, 220);
}

function firstNonEmptyLine(value: string): string | undefined {
	return value
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.find(Boolean);
}

export function parseRtkVersion(value: string): string | undefined {
	return value.match(/(?:^|\s)rtk\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u)?.[1];
}

function effectiveCommandStartsWithRtk(command: string): boolean {
	const withoutAssignments = command
		.trimStart()
		.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/u, "");
	return withoutAssignments === "rtk" || withoutAssignments.startsWith("rtk ");
}

function sha256File(path: string): Effect.Effect<string, Error> {
	return Effect.map(
		Effect.tryPromise({
			try: (signal) => readFile(path, { signal }),
			catch: normalizeError,
		}),
		(content) => createHash("sha256").update(content).digest("hex"),
	);
}

function fileFingerprint(path: string): Effect.Effect<string, Error> {
	return Effect.tryPromise({
		try: async () => {
			const info = await stat(path);
			if (!info.isFile()) throw new Error("resolved RTK path is not a regular file");
			return [info.dev, info.ino, info.size, info.mtimeMs, info.mode].join(":");
		},
		catch: normalizeError,
	});
}

function resolveRealPath(path: string): Effect.Effect<string, Error> {
	return Effect.tryPromise({ try: () => realpath(path), catch: normalizeError });
}

/** Certifies one local RTK executable and fails open whenever that identity changes. */
export class RtkRuntime {
	private certificate: RuntimeCertificate | undefined;
	private readonly expectedVersion: string;
	private generation = 0;
	private readonly resolveTimeoutMs: number;
	private readonly rewriteTimeoutMs: number;
	private snapshotValue: RtkRuntimeSnapshot = { state: "unchecked" };
	private readonly verificationGate = Semaphore.makeUnsafe(1);
	private readonly versionTimeoutMs: number;

	constructor(options: RtkRuntimeOptions = {}) {
		this.expectedVersion = options.expectedVersion ?? CERTIFIED_RTK_VERSION;
		this.resolveTimeoutMs = options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS;
		this.rewriteTimeoutMs = options.rewriteTimeoutMs ?? REWRITE_TIMEOUT_MS;
		this.versionTimeoutMs = options.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
	}

	snapshot(): RtkRuntimeSnapshot {
		return { ...this.snapshotValue };
	}

	reset(): void {
		this.generation += 1;
		this.certificate = undefined;
		this.snapshotValue = { state: "unchecked" };
	}

	verify(pi: RtkProcessHost, options: VerifyOptions = {}): Effect.Effect<RtkRuntimeSnapshot> {
		return this.verificationGate.withPermit(
			Effect.suspend(() => {
				if (options.refresh) this.reset();
				if (this.certificate || this.snapshotValue.state !== "unchecked") {
					return Effect.succeed(this.snapshot());
				}
				const generation = this.generation;
				return this.certify(pi).pipe(
					Effect.map((certificate) => {
						if (generation === this.generation) {
							this.certificate = certificate;
							this.snapshotValue = {
								path: certificate.path,
								sha256: certificate.sha256,
								state: "ready",
								version: certificate.version,
							};
						}
						return this.snapshot();
					}),
					Effect.catch((error) =>
						Effect.sync(() => {
							this.markUnavailable(`RTK verification failed: ${cleanOneLine(error)}`, generation);
							return this.snapshot();
						}),
					),
				);
			}),
		);
	}

	rewrite(pi: RtkProcessHost, command: string): Effect.Effect<string | undefined> {
		if (!command.trim() || effectiveCommandStartsWithRtk(command)) return Effect.succeed(undefined);
		return Effect.gen({ self: this }, function* () {
			yield* this.verify(pi);
			const certificate = this.certificate;
			if (!certificate) return undefined;
			const generation = this.generation;

			const stable = yield* Effect.catch(Effect.as(this.assertStable(pi, certificate), true), (error) =>
				Effect.sync(() => {
					this.markDrifted(error, certificate, generation);
					return false;
				}),
			);
			if (!stable || !this.isCurrent(certificate, generation)) return undefined;

			const result = yield* Effect.catch(
				this.execute(pi, certificate.selectedPath, ["rewrite", command]).pipe(
					Effect.timeoutOption(this.rewriteTimeoutMs),
				),
				(error) =>
					Effect.sync(() => {
						this.markUnavailable(`RTK rewrite failed: ${cleanOneLine(error)}`, generation, certificate);
						return undefined;
					}),
			);
			if (result === undefined) return undefined;
			if (Option.isNone(result)) {
				this.markUnavailable("RTK rewrite timed out", generation, certificate);
				return undefined;
			}
			if (!this.isCurrent(certificate, generation)) return undefined;
			if (result.value.code === 1 || result.value.code === 2) return undefined;
			if (result.value.code !== 0 && result.value.code !== 3) {
				if (result.value.killed) this.markUnavailable("RTK rewrite timed out", generation, certificate);
				return undefined;
			}
			const rewritten = result.value.stdout.trim();
			return rewritten && rewritten !== command ? rewritten : undefined;
		});
	}

	private certify(pi: RtkProcessHost): Effect.Effect<RuntimeCertificate, Error> {
		return Effect.gen({ self: this }, function* () {
			const selectedPath = yield* this.resolveSelectedPath(pi);
			const path = yield* resolveRealPath(selectedPath);
			const [fingerprint, sha256, version] = yield* Effect.all(
				[fileFingerprint(path), sha256File(path), this.verifyVersion(pi, selectedPath)] as const,
				{ concurrency: "unbounded" },
			);
			return { fingerprint, path, selectedPath, sha256, version };
		});
	}

	private verifyVersion(pi: RtkProcessHost, path: string): Effect.Effect<string, Error> {
		return Effect.gen({ self: this }, function* () {
			const result = yield* this.execute(pi, path, ["--version"]).pipe(Effect.timeoutOption(this.versionTimeoutMs));
			if (Option.isNone(result)) return yield* Effect.fail(new Error("RTK version probe timed out"));
			const versionResult = result.value;
			const parsedVersion = parseRtkVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
			if (versionResult.code !== 0 || !parsedVersion)
				return yield* Effect.fail(new Error("RTK returned no valid version"));
			if (parsedVersion !== this.expectedVersion) {
				return yield* Effect.fail(
					new Error(`RTK ${parsedVersion} is not the certified ${this.expectedVersion} runtime`),
				);
			}
			return parsedVersion;
		});
	}

	private assertStable(pi: RtkProcessHost, certificate: RuntimeCertificate): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			const selectedPath = yield* this.resolveSelectedPath(pi);
			const path = yield* resolveRealPath(selectedPath);
			if (selectedPath !== certificate.selectedPath || path !== certificate.path) {
				return yield* Effect.fail(new Error("resolved RTK path changed after verification"));
			}
			const [fingerprint, sha256] = yield* Effect.all(
				[fileFingerprint(path), sha256File(path), this.verifyVersion(pi, selectedPath)] as const,
				{ concurrency: "unbounded" },
			);
			if (fingerprint !== certificate.fingerprint || sha256 !== certificate.sha256) {
				return yield* Effect.fail(new Error("RTK executable changed after verification"));
			}
		});
	}

	private resolveSelectedPath(pi: RtkProcessHost): Effect.Effect<string, Error> {
		const resolver = process.platform === "win32" ? "where" : "which";
		return this.execute(pi, resolver, ["rtk"]).pipe(
			Effect.timeoutOption(this.resolveTimeoutMs),
			Effect.flatMap((result) => {
				if (Option.isNone(result)) return Effect.fail(new Error(`${resolver} could not resolve rtk`));
				const selectedPath = firstNonEmptyLine(result.value.stdout);
				return result.value.code === 0 && selectedPath
					? Effect.succeed(selectedPath.replace(/^(["'])(.*)\1$/u, "$2"))
					: Effect.fail(new Error(`${resolver} could not resolve rtk`));
			}),
		);
	}

	private execute(pi: RtkProcessHost, command: string, args: string[]) {
		return Effect.tryPromise({
			try: (signal) => pi.exec(command, args, { signal }),
			catch: normalizeError,
		});
	}

	private isCurrent(certificate: RuntimeCertificate, generation: number): boolean {
		return generation === this.generation && this.certificate === certificate;
	}

	private markDrifted(cause: unknown, certificate: RuntimeCertificate, generation: number): void {
		if (!this.isCurrent(certificate, generation)) return;
		this.generation += 1;
		this.certificate = undefined;
		this.snapshotValue = {
			lastError: `RTK identity drift: ${cleanOneLine(cause)}`,
			path: certificate.path,
			sha256: certificate.sha256,
			state: "drifted",
			version: certificate.version,
		};
	}

	private markUnavailable(error: string, generation: number, certificate?: RuntimeCertificate): void {
		if (generation !== this.generation || (certificate !== undefined && certificate !== this.certificate)) return;
		this.generation += 1;
		this.certificate = undefined;
		const snapshot = { lastError: error, state: "unavailable" as const };
		if (certificate) {
			Object.assign(snapshot, { path: certificate.path, sha256: certificate.sha256, version: certificate.version });
		}
		this.snapshotValue = snapshot;
	}
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
