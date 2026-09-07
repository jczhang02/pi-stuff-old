import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { importsOf, resolveImport } from "./test-inventory.ts";

const DECLARATIONS = Type.Record(
	Type.String(),
	Type.Object({
		sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		dependencies: Type.Array(Type.String()),
		reason: Type.String(),
	}),
);

export function verificationDependencies(root: string, files: readonly string[], tests: readonly string[]) {
	const declarationPath = resolve(root, "config/verification-dependencies.json");
	const declarations = Value.Parse(
		DECLARATIONS,
		existsSync(declarationPath) ? JSON.parse(readFileSync(declarationPath, "utf8")) : {},
	);
	const known = new Set(files);
	const pending = new Set([...files.filter((file) => file.startsWith("packages/pi-stuff/src/")), ...tests]);
	const reverse = new Map<string, Set<string>>();
	let uncertain = false;
	const addDependency = (file: string, target: string): void => {
		const dependents = reverse.get(target) ?? new Set<string>();
		dependents.add(file);
		reverse.set(target, dependents);
		if (known.has(target)) pending.add(target);
	};
	for (const file of pending) {
		const imports = importsOf(root, file);
		if (imports.opaque) {
			const declared = declarations[file];
			const digest = createHash("sha256")
				.update(readFileSync(resolve(root, file)))
				.digest("hex");
			if (!declared || declared.sha256 !== digest) uncertain = true;
			else
				for (const dependency of declared.dependencies) {
					const targets = files.filter((target) =>
						dependency.endsWith("/") ? target.startsWith(dependency) : target === dependency,
					);
					if (!targets.length) uncertain = true;
					for (const target of targets) addDependency(file, target);
				}
		}
		for (const specifier of imports.specifiers) {
			if (!specifier.startsWith(".")) continue;
			const direct = relative(root, resolve(root, dirname(file), specifier));
			// Relative imports into the installed Host remain external dependency boundaries.
			if (direct.split("/").includes("node_modules")) continue;
			const target =
				resolveImport(root, file, specifier) ?? (existsSync(resolve(root, direct)) ? direct : undefined);
			if (!target) uncertain = true;
			else {
				if (/\.[cm]?[jt]sx?$/u.test(target) && !known.has(target)) uncertain = true;
				addDependency(file, target);
			}
		}
	}
	return { reverse, uncertain };
}
