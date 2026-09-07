import type { DescribeOutput, SearchOutput, SearchResult } from "./cloudflare/connector-types.ts";
import { sanitizeToolName, toolPath, toPascalCase } from "./cloudflare/utils.ts";

const RESULT_LIMIT = 5;
const RESPONSE_CHARS = 4_000;

function metadata(search: SearchOutput, included: number) {
	return {
		total: search.total,
		truncated: search.truncated || included < search.results.length,
	};
}

function signature(result: SearchResult, typed = true): string {
	if (result.kind === "snippet")
		return `codemode.run(${JSON.stringify(result.path)}, input?: unknown): Promise<unknown>`;
	const path = projectedPath(result);
	if (!typed) return `${path}(input: unknown): Promise<unknown>`;
	const typeName = toPascalCase(sanitizeToolName(result.method));
	return `${path}(input: ${typeName}Input): Promise<${typeName}Output>`;
}

function projectedPath(result: SearchResult): string {
	return result.kind === "snippet" ? result.path : toolPath(result.method, result.connector);
}

function signatureResult(result: SearchResult, typed = true) {
	const compact = { kind: result.kind, path: projectedPath(result), signature: signature(result, typed) };
	return result.requiresApproval ? { ...compact, requiresApproval: true } : compact;
}

function compactTypes(types: string): string {
	return types
		.split("\n")
		.filter((line) => !/^\s*(?:\/\*\*|\*\/?)/u.test(line))
		.join("\n");
}

function removeRepeatedDescription(description: DescribeOutput): DescribeOutput {
	if (!description.description) return description;
	const prefix = `${description.description}\n\n`;
	if (!description.types.startsWith(prefix)) return description;
	return { ...description, types: description.types.slice(prefix.length) };
}

function compactDescription(description: DescribeOutput) {
	const compact = {
		description: description.description,
		kind: description.kind,
		path: description.path,
		types: description.kind === "snippet" ? description.types : compactTypes(description.types),
	};
	return description.requiresApproval ? { ...compact, requiresApproval: true } : compact;
}

function describeRequiredResult(result: SearchResult) {
	const compact = { kind: result.kind, path: projectedPath(result) };
	return result.requiresApproval ? { ...compact, requiresApproval: true } : compact;
}

function encode(
	search: SearchOutput,
	representation: "definitions" | "typed-top" | "describe-required",
	results: readonly unknown[],
	definitions: readonly unknown[] = [],
	instruction?: string,
): string | undefined {
	const payload = {
		...metadata(search, results.length),
		definitions,
		representation,
		results,
	};
	const text = JSON.stringify(instruction ? { ...payload, instruction } : payload);
	return text.length <= RESPONSE_CHARS ? text : undefined;
}

function projection(search: SearchOutput, text: string, results: readonly { readonly path: string }[]) {
	return {
		paths: results.map((result) => result.path),
		text,
		truncated: metadata(search, results.length).truncated,
	};
}

export function projectCodeModeSearchResponse(
	search: SearchOutput,
	describe: (result: SearchResult) => DescribeOutput,
): ReturnType<typeof projection> {
	const results = search.results.slice(0, RESULT_LIMIT);
	if (results.length === 0) {
		return projection(search, JSON.stringify({ ...search, definitions: [], representation: "definitions" }), []);
	}

	const descriptions = results.map((result) =>
		removeRepeatedDescription({ ...describe(result), path: projectedPath(result) }),
	);
	const fullResults = results.map((result) => signatureResult(result));
	const fullText = encode(search, "definitions", fullResults, descriptions);
	if (fullText) return projection(search, fullText, fullResults);

	const topDescription = descriptions[0];
	const topResult = results[0];
	const topSignature = topResult ? signatureResult(topResult) : undefined;
	if (topDescription && topSignature) {
		let typedResults = [topSignature];
		const typedDescription = compactDescription(topDescription);
		let typedText = encode(search, "typed-top", typedResults, [typedDescription]);
		if (typedText) {
			for (const result of results.slice(1)) {
				const compact = signatureResult(result, false);
				const nextResults = [...typedResults, compact];
				const encoded = encode(search, "typed-top", nextResults, [typedDescription]);
				if (!encoded) continue;
				typedResults = nextResults;
				typedText = encoded;
			}
			return projection(search, typedText, typedResults);
		}
	}

	const instruction =
		"Call codemode.describe with a result's exact path before invoking it; if no result fits, refine the search. Do not guess input fields.";
	let compactResults: Array<ReturnType<typeof describeRequiredResult>> = [];
	let compactText = encode(search, "describe-required", compactResults, [], instruction);
	if (!compactText) throw new Error("Tool Discovery metadata exceeds its response budget.");
	for (const result of results) {
		const compact = describeRequiredResult(result);
		const nextResults = [...compactResults, compact];
		const encoded = encode(search, "describe-required", nextResults, [], instruction);
		if (!encoded) continue;
		compactResults = nextResults;
		compactText = encoded;
	}
	return projection(search, compactText, compactResults);
}
