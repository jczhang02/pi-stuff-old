import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonValue, parseJsonValue } from "../shared/json-value.ts";

export type NativeToolName = "apply_patch" | "imagegen" | "view_image";

export interface NativeToolResult {
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

export interface NativeToolInvocation {
	readonly arguments?: readonly string[] | undefined;
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv | undefined;
	readonly input?: string | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly tool: NativeToolName;
}

const BINARY_DIRECTORIES = {
	apply_patch: "apply-patch",
	imagegen: "imagegen",
	view_image: "view-image",
} satisfies Readonly<Record<NativeToolName, string>>;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

function binaryName(tool: NativeToolName, platform: NodeJS.Platform): string {
	return platform === "win32" ? `${tool}.exe` : tool;
}

export function resolveNativeBinary(
	tool: NativeToolName,
	target: { readonly arch?: string; readonly platform?: NodeJS.Platform } = {},
): string | undefined {
	const platform = target.platform ?? process.platform;
	const arch = target.arch ?? process.arch;
	const path = join(
		PACKAGE_DIRECTORY,
		"native",
		BINARY_DIRECTORIES[tool],
		`${platform}-${arch}`,
		binaryName(tool, platform),
	);
	return existsSync(path) ? path : undefined;
}

export function parseNativeJson(stdout: string, label: string): JsonValue {
	const lines = stdout.trimEnd().split("\n");
	let line: string | undefined;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index]?.trimStart().startsWith("{")) {
			line = lines[index];
			break;
		}
	}
	if (!line) throw new Error(`${label} returned no structured result.`);
	try {
		return parseJsonValue(line);
	} catch {
		throw new Error(`${label} returned invalid structured JSON.`);
	}
}

export async function runNativeTool(invocation: NativeToolInvocation): Promise<NativeToolResult> {
	const binary = resolveNativeBinary(invocation.tool);
	if (!binary) {
		throw new Error(
			`${invocation.tool} is unavailable on ${process.platform}-${process.arch}; Pi remains usable without this Tool.`,
		);
	}
	if (invocation.signal?.aborted) throw new Error(`${invocation.tool} was cancelled.`);

	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn([binary, ...(invocation.arguments ?? [])], {
			cwd: invocation.cwd,
			env: invocation.env ?? process.env,
			stdin: invocation.input === undefined ? "ignore" : new Blob([invocation.input]),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		throw new Error(`${invocation.tool} could not start: ${error instanceof Error ? error.message : String(error)}`);
	}

	let outputBytes = 0;
	let aborted = false;
	const abort = (): void => {
		aborted = true;
		try {
			child.kill();
		} catch {
			// Process exit racing cancellation is harmless.
		}
	};
	const readOutput = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
		const reader = stream.getReader();
		const chunks: Buffer[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			outputBytes += value.byteLength;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				abort();
				throw new Error(`${invocation.tool} output exceeded ${String(MAX_OUTPUT_BYTES)} bytes.`);
			}
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks).toString("utf8");
	};

	invocation.signal?.addEventListener("abort", abort, { once: true });
	try {
		if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
			abort();
			throw new Error(`${invocation.tool} could not open its output pipes.`);
		}
		const [status, stdout, stderr] = await Promise.all([
			child.exited,
			readOutput(child.stdout),
			readOutput(child.stderr),
		]);
		if (aborted) throw new Error(`${invocation.tool} was cancelled.`);
		return { status, stderr, stdout };
	} finally {
		invocation.signal?.removeEventListener("abort", abort);
	}
}
