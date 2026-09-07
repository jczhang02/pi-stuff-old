import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import ts from "typescript";

export const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;
const TEST_LEVELS = ["unit", "component-integration", "system", "system-integration", "acceptance"] as const;

export function discoverTestFiles(root: string): string[] {
	const files: string[] = [];
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && (TEST_FILE_PATTERN.test(entry.name) || entry.name.endsWith(".node.ts")))
				files.push(path);
		}
	}
	visit(root);
	return files.sort();
}

export function suiteCapabilities(root: string): Set<string> {
	try {
		const suite = Value.Parse(
			Type.Object({ capabilities: Type.Array(Type.String()) }),
			JSON.parse(readFileSync(resolve(root, "packages/pi-stuff/suite.json"), "utf8")),
		);
		return new Set(suite.capabilities);
	} catch {
		return new Set();
	}
}

export function testCapability(file: string, capabilities?: Set<string>): string | undefined {
	const parts = file.split("/");
	if (parts[0] !== "tests" || !TEST_LEVELS.some((level) => level === parts[1])) return undefined;
	const candidate = parts[2];
	return candidate && (!capabilities || capabilities.has(candidate) || candidate === "repository")
		? candidate
		: undefined;
}

export function importsOf(root: string, file: string) {
	const source = ts.createSourceFile(file, readFileSync(resolve(root, file), "utf8"), ts.ScriptTarget.Latest, true);
	const specifiers = new Set<string>();
	let opaque = false;
	const record = (node: ts.Node | undefined): void => {
		if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text);
		else opaque = true;
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier) record(node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			record(node.moduleReference.expression);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require"))
		)
			record(node.arguments[0]);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { specifiers: [...specifiers], opaque };
}

export function resolveImport(root: string, from: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const result = ts.resolveModuleName(
		specifier,
		resolve(root, from),
		{ allowJs: true, resolveJsonModule: true, moduleResolution: ts.ModuleResolutionKind.Bundler },
		ts.sys,
	).resolvedModule?.resolvedFileName;
	return result && !result.includes("node_modules") ? relative(root, result) : undefined;
}
