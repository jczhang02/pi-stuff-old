import { expect, test } from "bun:test";
import { deferredModule } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/deferred-module.ts";

test("shares first-use timer opportunities with concurrent callers and reuses the warm result", async () => {
	const stages: string[] = [];
	const module = {};
	const load = deferredModule(async () => {
		stages.push("import");
		setTimeout(() => stages.push("after import"), 0);
		return module;
	});
	expect(stages).toEqual([]);
	setTimeout(() => stages.push("before import"), 0);
	const first = load();
	expect(load()).toBe(first);
	expect(await first).toBe(module);
	expect(stages).toEqual(["before import", "import", "after import"]);
	expect(load()).toBe(first);
	expect(await load()).toBe(module);
	expect(stages).toHaveLength(3);
});

test("retries a rejected import without retaining its failure or duplicating concurrent work", async () => {
	const failure = new Error("first import rejected");
	let attempts = 0;
	const load = deferredModule(async () => {
		attempts++;
		if (attempts === 1) throw failure;
		return "ready";
	});
	const failed = load();
	expect(load()).toBe(failed);
	await expect(failed).rejects.toBe(failure);
	const retry = load();
	expect(retry).not.toBe(failed);
	expect(load()).toBe(retry);
	expect(await retry).toBe("ready");
	expect(attempts).toBe(2);
});
