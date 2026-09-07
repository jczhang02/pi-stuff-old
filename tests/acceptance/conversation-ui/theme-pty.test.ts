import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { selectAcceptanceMatrix } from "../../../scripts/acceptance-matrix.ts";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyThemeLifecyclePty } from "../../../scripts/verify-ui-pty.ts";

const PI_BIN = resolvePiBinary();
const aggregatePackage = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("real Pi discovers, switches, reloads, and resumes the selected Catppuccin matrix", async () => {
	const evidence = await verifyThemeLifecyclePty({ piBinary: PI_BIN, packagePath: aggregatePackage });
	const fallbackEvidence = await verifyThemeLifecyclePty({
		colorMode: "256",
		piBinary: PI_BIN,
		packagePath: aggregatePackage,
	});

	expect(evidence.themes).toEqual(
		selectAcceptanceMatrix(
			["catppuccin-latte", "catppuccin-frappe", "catppuccin-macchiato", "catppuccin-mocha"],
			["catppuccin-latte", "catppuccin-frappe"],
		),
	);
	expect(evidence.verified).toHaveLength(4);
	expect(evidence.sizes).toEqual(selectAcceptanceMatrix(["64x28", "100x32"], ["100x32"]));
	expect(evidence.colorMode).toBe("truecolor");
	expect(fallbackEvidence.colorMode).toBe("256");
	expect(fallbackEvidence.sizes).toEqual(evidence.sizes);
	expect(fallbackEvidence.themes).toEqual(evidence.themes);
}, 90_000);
