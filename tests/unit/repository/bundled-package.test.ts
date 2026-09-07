import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseJsonValue } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { CERTIFIED_PI_VERSION } from "../../../scripts/pi-host-contract.ts";
import {
	type PackageManifest,
	verifyInstalledRuntimeDependencies,
	verifyPackageManifest,
	verifyPackageSource,
} from "../../../scripts/verify-package.ts";

const packageDirectory = resolve(import.meta.dir, "../../../packages/pi-stuff");

async function packageManifest(): Promise<PackageManifest> {
	// SAFETY: this repository-controlled fixture is validated by the source Package test before mutation cases.
	return parseJsonValue(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as PackageManifest;
}

test("the source Package satisfies its manifest and resource constraints", async () => {
	await verifyPackageSource(packageDirectory);
});

test("every exact runtime dependency is installed at its declared identity", async () => {
	await verifyInstalledRuntimeDependencies(packageDirectory);
});

test("Package manifest rejects publication and nested Package boundaries", async () => {
	const manifest = await packageManifest();
	expect(() => verifyPackageManifest({ ...manifest, private: false })).toThrow("must remain a private local Package");
	expect(() => verifyPackageManifest({ ...manifest, bundledDependencies: ["typebox"] })).toThrow(
		"must not use bundledDependencies",
	);
	expect(() => verifyPackageManifest({ ...manifest, dependencies: { "@jczhang02/pi-stuff": "1.0.0" } })).toThrow(
		"only external runtime dependencies",
	);
});

test("Host peers remain wildcard contracts with certified development versions", async () => {
	const packageMetadata = Value.Parse(
		Type.Object({ peerDependencies: Type.Record(Type.String(), Type.String()) }),
		JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")),
	);
	const development = Value.Parse(
		Type.Object({ devDependencies: Type.Record(Type.String(), Type.String()) }),
		JSON.parse(await readFile(resolve(packageDirectory, "../../package.json"), "utf8")),
	);
	expect(packageMetadata.peerDependencies).toEqual({
		"@earendil-works/pi-agent-core": "*",
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
	});
	for (const dependency of Object.keys(packageMetadata.peerDependencies))
		expect(development.devDependencies[dependency]).toBe(CERTIFIED_PI_VERSION);
});
