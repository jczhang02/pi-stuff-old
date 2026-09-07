import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectAcceptanceMatrix } from "../../../scripts/acceptance-matrix.ts";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { TmuxPiSession } from "../../../scripts/ui-pty-session.ts";
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

test("real Pi preserves failure log and screen evidence before fixture cleanup", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fail-"));
	const evidence = join(root, "evidence");
	const previous = {
		TMPDIR: process.env["TMPDIR"],
		PI_STUFF_UI_PTY_ARTIFACT_DIR: process.env["PI_STUFF_UI_PTY_ARTIFACT_DIR"],
	};
	const originalSend = TmuxPiSession.prototype.sendKey;
	const input = spyOn(TmuxPiSession.prototype, "sendKey").mockImplementation(function (
		this: TmuxPiSession,
		key: string,
	) {
		if (key === "F9") throw new Error("injected PTY input failure");
		originalSend.call(this, key);
	});
	try {
		process.env["TMPDIR"] = root;
		process.env["PI_STUFF_UI_PTY_ARTIFACT_DIR"] = evidence;
		await expect(verifyThemeLifecyclePty({ piBinary: PI_BIN, packagePath: aggregatePackage })).rejects.toThrow(
			"injected PTY input failure",
		);
		expect((await readdir(root)).filter((path) => path.startsWith("pi-stuff-theme-pty-"))).toEqual([]);
		for (const extension of ["jsonl", "txt", "ansi"]) {
			const saved = await readFile(join(evidence, `theme-lifecycle-truecolor-failure.${extension}`), "utf8");
			expect(saved.length).toBeGreaterThan(0);
			expect(saved).not.toContain(root);
			expect(saved).not.toContain(aggregatePackage);
			expect(saved).toContain(extension === "jsonl" ? "inventory" : "Welcome back!");
		}
	} finally {
		input.mockRestore();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
