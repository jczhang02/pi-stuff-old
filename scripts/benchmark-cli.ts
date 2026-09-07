/** Shared command-boundary handling for Capability Benchmarks. */
export function handleBenchmarkMeta(arguments_: readonly string[], usage: string, entries: readonly string[]): void {
	if (arguments_.length === 0) return;
	const flag = arguments_[0];
	if (flag !== "--help" && flag !== "--list") return;
	if (arguments_.length !== 1) throw new Error(`unknown argument: ${String(arguments_[1])}`);
	process.stdout.write(`${flag === "--help" ? `${usage}\n` : `${entries.join("\n")}\n`}`);
	process.exit(0);
}

export async function writeBenchmarkReport(output: string, report: JsonInputValue): Promise<void> {
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, serialized);
	process.stdout.write(serialized);
}

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonInputValue } from "../packages/pi-stuff/src/shared/json-value.js";
