import ts from "typescript";

const DIRECT_PROVIDER_API_FILES = new Set([
	"anysearch.ts",
	"brave.ts",
	"brightdata.ts",
	"exa.ts",
	"kagi.ts",
	"ollama.ts",
	"openai-search.ts",
	"parallel.ts",
	"perplexity.ts",
	"querit.ts",
	"search1api.ts",
	"searchinfinity.ts",
	"serpbase.ts",
	"serpdive.ts",
	"tavily.ts",
	"tinyfish.ts",
	"xai-search.ts",
]);

export function auditProviderRedirectPolicy(path: string, source: string) {
	const prefix = "packages/pi-stuff/src/web/runtime/";
	if (!path.startsWith(prefix) || !DIRECT_PROVIDER_API_FILES.has(path.slice(prefix.length))) return [];
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	let fetchCalls = 0;
	let redirectErrors = 0;
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch")
			fetchCalls += 1;
		if (
			ts.isPropertyAssignment(node) &&
			node.name.getText(file).replaceAll(/["']/gu, "") === "redirect" &&
			ts.isStringLiteral(node.initializer) &&
			node.initializer.text === "error"
		)
			redirectErrors += 1;
		ts.forEachChild(node, visit);
	}
	visit(file);
	// ponytail: declaration parity preserves the existing source gate; use per-adapter redirect tests when RequestInit data flow changes.
	return fetchCalls === redirectErrors
		? []
		: [{ path, rule: `provider-api-redirect-declarations:${redirectErrors}/${fetchCalls}` }];
}
