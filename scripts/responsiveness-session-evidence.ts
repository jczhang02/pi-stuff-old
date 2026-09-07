import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseJsonValue } from "../packages/pi-stuff/src/shared/json-value.js";

async function readSessionEntries(directory: string) {
	const files = (await readdir(join(directory, "sessions"))).filter((name) => name.endsWith(".jsonl"));
	assert.equal(files.length, 1, "Expected one parent Session");
	const file = files[0];
	assert(file);
	return (await readFile(join(directory, "sessions", file), "utf8")).trim().split("\n").map(parseJsonValue);
}

export async function readGoalCompletion(directory: string): Promise<boolean> {
	const entries = await readSessionEntries(directory);
	const terminal = Type.Object({
		type: Type.Literal("custom"),
		customType: Type.Literal("goal-state"),
		data: Type.Object({
			goal: Type.Object({ text: Type.Literal("PSYON_MEASURE"), status: Type.Literal("complete") }),
		}),
	});
	const final = Type.Object({
		type: Type.Literal("message"),
		message: Type.Object({
			role: Type.Literal("assistant"),
			content: Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
		}),
	});
	const terminalIndex = entries.findIndex((entry) => Check(terminal, entry));
	const successfulTool = Type.Object({
		type: Type.Literal("message"),
		message: Type.Object({
			role: Type.Literal("toolResult"),
			toolName: Type.Literal("goal_complete"),
			isError: Type.Literal(false),
		}),
	});
	const results = entries.flatMap((entry, index) => (Check(successfulTool, entry) ? [index] : []));
	assert.equal(results.length, 1, "Expected one persisted successful Goal completion Tool result");
	const finals = entries.flatMap((entry, index) =>
		Check(final, entry) &&
		entry.message.content.some((part) => part.type === "text" && part.text === "PSYON_CADENCE_DONE")
			? [index]
			: [],
	);
	assert.equal(finals.length, 1, "Expected one persisted Goal Final Response");
	assert(
		terminalIndex >= 0 && terminalIndex < (results[0] ?? -1) && (results[0] ?? Infinity) < (finals[0] ?? -1),
		"Goal state, successful Tool result and final response were not persisted in order",
	);
	return true;
}

export async function readBackgroundOutcomes(directory: string, expectedChildren: number) {
	const entries = await readSessionEntries(directory);
	const identity = Type.Object({ type: Type.Literal("custom"), customType: Type.Literal("pi-stuff-agent-outcome") });
	const outcomes = entries.filter((entry) => Check(identity, entry));
	const completed = Type.Object({
		data: Type.Object({
			version: Type.Literal(1),
			key: Type.String({ minLength: 1 }),
			count: Type.Literal(1),
			status: Type.Literal("completed"),
		}),
	});
	const keys = outcomes.map((entry) => {
		assert(Check(completed, entry), "Background Agent outcome was not completed");
		return entry.data.key;
	});
	assert.equal(outcomes.length, expectedChildren, "Missing or duplicate durable Agent outcomes");
	assert.equal(new Set(keys).size, expectedChildren, "Repeated Agent outcome identity");
	const delivery = Type.Object({
		type: Type.Literal("custom_message"),
		customType: Type.Literal("pi-stuff-agent-complete"),
		content: Type.String(),
		details: Type.Object({ keys: Type.Array(Type.String(), { minItems: 1 }) }),
	});
	const deliveries = entries.filter((entry) => Check(delivery, entry));
	assert.deepEqual(
		deliveries.flatMap((entry) => entry.details.keys).sort(),
		keys.sort(),
		"Every retained result must be delivered exactly once",
	);
	for (const entry of deliveries)
		assert(
			entry.content.includes("PSYON_CHILD_DONE") && entry.content.includes("Canonical output:"),
			"Background delivery omitted canonical child output",
		);
	return { outcomes: outcomes.length, deliveries: deliveries.length };
}
