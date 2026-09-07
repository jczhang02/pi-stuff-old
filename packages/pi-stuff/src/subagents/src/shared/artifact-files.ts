import * as fs from "node:fs";
import * as path from "node:path";
import { isRuntimeFunction, isRuntimeObject } from "../../../shared/runtime-type.ts";
import { shardedDurableClaimName, tryAcquireKernelClaim } from "./durable-claim.ts";
import { type ArtifactDirPreference, type ArtifactPaths, TEMP_ARTIFACTS_DIR } from "./types.ts";

export const ARTIFACT_CLEANUP_CONTROL_DIRECTORY = ".artifact-cleanup-control";
export const ARTIFACT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const PROJECT_ARTIFACT_ROOT = ".pi-subagents";
const ARTIFACT_WRITE_CLAIM_ATTEMPTS = 100;
const ARTIFACT_WRITE_CLAIM_WAIT_MS = 5;
const ARTIFACT_SUFFIXES = ["_input.md", "_output.md", "_transcript.jsonl", "_meta.json", ".jsonl"] as const;
const cachedArtifactClaims = new Map<
	string,
	{
		claim: NonNullable<ReturnType<typeof tryAcquireKernelClaim>>;
		users: number;
	}
>();

export function hasErrorCode<Cause>(cause: Cause, code: string): boolean {
	return isRuntimeObject(cause) && cause !== null && "code" in cause && cause.code === code;
}

export function getProjectArtifactsDir(cwd: string): string {
	return path.join(cwd, PROJECT_ARTIFACT_ROOT, "artifacts");
}

export function getArtifactsDir(
	sessionFile: string | null,
	projectCwd?: string,
	dirPreference: ArtifactDirPreference = "session",
): string {
	switch (dirPreference) {
		case "session":
			if (sessionFile) {
				const sessionDir = path.dirname(sessionFile);
				return path.join(sessionDir, "subagent-artifacts");
			}
			return TEMP_ARTIFACTS_DIR;
		case "temp":
			return TEMP_ARTIFACTS_DIR;
		case "project":
			if (projectCwd) return getProjectArtifactsDir(projectCwd);
			if (sessionFile) {
				const sessionDir = path.dirname(sessionFile);
				return path.join(sessionDir, "subagent-artifacts");
			}
			return TEMP_ARTIFACTS_DIR;
		default:
			throw new Error(
				`Unsupported artifactDir ${JSON.stringify(dirPreference)}; expected "project", "session", or "temp".`,
			);
	}
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		transcriptPath: path.join(artifactsDir, `${base}_transcript.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

export function formatOutputArtifactContent(input: {
	output: string;
	error?: string;
	transcriptPath?: string;
	metadataPath?: string;
}): string {
	if (input.output.trim() || !input.error) return input.output;
	const lines = ["Subagent run failed before producing output.", "", "Error:", input.error];
	if (input.transcriptPath) lines.push("", `Transcript: ${input.transcriptPath}`);
	if (input.metadataPath) lines.push(`Metadata: ${input.metadataPath}`);
	return lines.join("\n");
}

export function appendJsonl(filePath: string, line: string): void {
	fs.appendFileSync(filePath, `${line}\n`);
}

export function appendArtifactJsonl(filePath: string, line: string): void {
	withArtifactGroupWriteClaim(filePath, () => fs.appendFileSync(filePath, `${line}\n`));
}

export function artifactBaseName(fileName: string): string | undefined {
	for (const suffix of ARTIFACT_SUFFIXES) {
		if (fileName.endsWith(suffix) && fileName.length > suffix.length) return fileName.slice(0, -suffix.length);
	}
	return undefined;
}

export function artifactGroupNames(base: string): string[] {
	return ARTIFACT_SUFFIXES.map((suffix) => `${base}${suffix}`);
}

function ensureArtifactCleanupControlDirectorySync(directory: string): string {
	const parent = fs.lstatSync(directory);
	const currentUid = process.getuid?.();
	if (parent.isSymbolicLink() || !parent.isDirectory() || (currentUid !== undefined && parent.uid !== currentUid)) {
		throw new Error("Invalid artifact directory.");
	}
	const control = path.join(directory, ARTIFACT_CLEANUP_CONTROL_DIRECTORY);
	try {
		fs.mkdirSync(control, { mode: 0o700 });
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
	}
	const stat = fs.lstatSync(control);
	if (stat.isSymbolicLink() || !stat.isDirectory() || (currentUid !== undefined && stat.uid !== currentUid)) {
		throw new Error("Invalid artifact cleanup control directory.");
	}
	fs.chmodSync(control, 0o700);
	return control;
}

function pauseForArtifactClaim(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ARTIFACT_WRITE_CLAIM_WAIT_MS);
}

function acquireArtifactGroupWriteClaim(control: string, claimName: string): () => void {
	const controlStat = fs.lstatSync(control);
	const cacheKey = `${String(controlStat.dev)}:${String(controlStat.ino)}:${claimName}`;
	let cached = cachedArtifactClaims.get(cacheKey);
	if (cached) {
		cached.users += 1;
	} else {
		let claim: ReturnType<typeof tryAcquireKernelClaim>;
		for (let attempt = 0; attempt < ARTIFACT_WRITE_CLAIM_ATTEMPTS; attempt += 1) {
			claim = tryAcquireKernelClaim(control, claimName);
			if (claim) break;
			pauseForArtifactClaim();
		}
		if (!claim) throw new Error("Timed out waiting for the Agent artifact group writer claim.");
		cached = { claim, users: 1 };
		cachedArtifactClaims.set(cacheKey, cached);
	}
	const acquired = cached;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		acquired.users -= 1;
		if (acquired.users > 0) return;
		if (cachedArtifactClaims.get(cacheKey) === acquired) cachedArtifactClaims.delete(cacheKey);
		acquired.claim.release();
	};
}

/** Coordinate optional artifact writers with age-based cleanup of the same group. */
export function withArtifactGroupWriteClaim<T>(filePath: string, operation: () => T): T {
	const base = artifactBaseName(path.basename(filePath));
	if (!base) throw new Error(`Unknown Agent artifact path '${filePath}'.`);
	const control = ensureArtifactCleanupControlDirectorySync(path.dirname(filePath));
	const claimName = shardedDurableClaimName("artifact-group", base);
	const release = acquireArtifactGroupWriteClaim(control, claimName);
	let releaseSynchronously = true;
	try {
		const result = operation();
		if (
			result !== null &&
			(isRuntimeObject(result) || isRuntimeFunction(result)) &&
			"then" in result &&
			isRuntimeFunction(result.then)
		) {
			releaseSynchronously = false;
			// SAFETY: the runtime thenable check proves this branch preserves the operation's asynchronous T contract.
			return Promise.resolve(result).finally(release) as T;
		}
		return result;
	} finally {
		if (releaseSynchronously) release();
	}
}
