import { expect, spyOn, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readFixtureRecords,
	waitForFixtureRecords,
	writeFixtureLogEvidence,
} from "../../../scripts/ui-pty-interactions.ts";
import { waitForPersistedSessionValue } from "../../../scripts/ui-pty-thinking-evidence.ts";

test("PTY readers wait for the complete appended JSONL record", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-records-"));
	const log = join(root, "fixture.jsonl");
	try {
		await writeFile(log, '{"type":"inventory","theme":"catppuccin');
		expect(await readFixtureRecords(log)).toEqual([]);
		const waiting = waitForFixtureRecords(log, "inventory", 1);
		await appendFile(log, '-mocha"}\n');
		expect(await waiting).toEqual([{ type: "inventory", theme: "catppuccin-mocha" }]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("PTY snapshots preserve complete records but never publish a partial UTF-8 tail", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-records-"));
	const log = join(root, "fixture.jsonl");
	const prefix = '{"type":"inventory"}\n';
	const next = Buffer.from('{"type":"theme-switch","theme":"中文"}\n');
	try {
		for (const split of [1, next.indexOf(Buffer.from("中")) + 1, next.length - 1]) {
			await writeFile(log, Buffer.concat([Buffer.from(prefix), next.subarray(0, split)]));
			expect(await readFixtureRecords(log)).toEqual([{ type: "inventory" }]);
			await appendFile(log, next.subarray(split));
			expect(await readFixtureRecords(log)).toEqual([
				{ type: "inventory" },
				{ type: "theme-switch", theme: "中文" },
			]);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("completed malformed JSON and invalid records fail rather than being ignored", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-records-"));
	const log = join(root, "fixture.jsonl");
	try {
		await writeFile(log, '{"type":"inventory}\n');
		await expect(readFixtureRecords(log)).rejects.toBeInstanceOf(SyntaxError);
		await writeFile(log, '{"type":42}\n');
		await expect(readFixtureRecords(log)).rejects.toThrow("malformed record");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a permanently incomplete record fails at the existing wait deadline", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-records-"));
	const log = join(root, "fixture.jsonl");
	const clock = spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(30_000);
	try {
		await writeFile(log, '{"type":"inventory');
		await expect(waitForFixtureRecords(log, "inventory", 1)).rejects.toThrow(
			"fixture log did not reach 1 inventory record(s)",
		);
	} finally {
		clock.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});

test("failure evidence survives fixture cleanup without repairing a partial record or leaking its root", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-records-"));
	const evidence = await mkdtemp(join(tmpdir(), "pi-stuff-evidence-"));
	const log = join(root, "fixture.jsonl");
	try {
		await writeFile(log, `{"type":"inventory","path":"${root}/session"}\n{"type":"inven`);
		await writeFixtureLogEvidence(evidence, "failed", log, root);
		await rm(root, { recursive: true });
		const saved = join(evidence, "failed.jsonl");
		expect(await readFile(saved, "utf8")).toBe('{"type":"inventory","path":"[fixture]/session"}\n{"type":"inven');
		expect((await stat(saved)).mode & 0o777).toBe(0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(evidence, { recursive: true, force: true });
	}
});

test("Host Session evidence also ignores only an unfinished appended tail", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-records-"));
	try {
		await writeFile(join(root, "session.jsonl"), '{"content":"retained thinking"}\n{"type":"message');
		await expect(
			waitForPersistedSessionValue(root, "retained thinking", "original Thinking"),
		).resolves.toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failure log redaction preserves a tail cut inside a UTF-8 code point", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-中文-"));
	const evidence = await mkdtemp(join(tmpdir(), "pi-stuff-evidence-"));
	try {
		const tail = Buffer.from("中文").subarray(0, 1);
		const log = join(root, "fixture.jsonl");
		await writeFile(log, Buffer.concat([Buffer.from(`${root}\n`), tail]));
		await writeFixtureLogEvidence(evidence, "cut", log, root);
		expect(await readFile(join(evidence, "cut.jsonl"))).toEqual(Buffer.concat([Buffer.from("[fixture]\n"), tail]));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(evidence, { recursive: true, force: true });
	}
});
