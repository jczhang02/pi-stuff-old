import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { writeMagicWorkerSyncResponse } from "../../../packages/pi-stuff/src/context-management/magic-worker-host.js";
import { MagicWorkerTransport } from "../../../packages/pi-stuff/src/context-management/magic-worker-transport.js";

const ENVIRONMENT_KEYS = [
	"HF_HUB_OFFLINE",
	"HOME",
	"MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION",
	"MAGIC_CONTEXT_LOG_PATH",
	"MAGIC_CONTEXT_TEST_DATA_DIR",
	"PI_OFFLINE",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
] as const;

const SCHEMA_VERSION_ROW_SCHEMA = Type.Object({ version: Type.Number() });
const TABLE_COLUMN_ROW_SCHEMA = Type.Object({ name: Type.String() });

function schemaVersion(database: Database): number {
	const row: unknown = database.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get();
	if (!Check(SCHEMA_VERSION_ROW_SCHEMA, row)) {
		throw new Error("Magic Context returned an invalid schema version row.");
	}
	return row.version;
}

function hasColumn(database: Database, table: string, column: string): boolean {
	return database
		.query(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => Check(TABLE_COLUMN_ROW_SCHEMA, row) && row.name === column);
}

async function initializeWorker() {
	const fatals: Error[] = [];
	const transport = new MagicWorkerTransport({
		onEffect: () => undefined,
		onFatal: (error) => fatals.push(error),
		onSyncEffect: (message) => {
			writeMagicWorkerSyncResponse(message.buffer, 2, "Synchronous Host effects are outside schema certification.");
		},
	});
	const ready = await Effect.runPromise(Effect.scoped(transport.initialize(1, [])));
	expect(fatals).toEqual([]);
	return ready;
}

test("Magic Context migrates v81 storage to v82 and rejects a stale v81 binary", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-magic-context-schema-"));
	const configDirectory = join(root, "config", "cortexkit");
	const dataDirectory = join(root, "data");
	const databasePath = join(dataDirectory, "cortexkit", "magic-context", "context.db");
	const logPath = join(root, "magic-context.log");
	const originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
	try {
		await mkdir(configDirectory, { recursive: true });
		await writeFile(
			join(configDirectory, "magic-context.jsonc"),
			`${JSON.stringify({
				dreamer: { disable: true },
				embedding: { provider: "off" },
				fail_closed_blocking: false,
				sidekick: { disable: true },
				todowrite: { enabled: false, overlay: false },
			})}\n`,
		);
		Object.assign(process.env, {
			HF_HUB_OFFLINE: "1",
			HOME: root,
			MAGIC_CONTEXT_LOG_PATH: logPath,
			MAGIC_CONTEXT_TEST_DATA_DIR: dataDirectory,
			PI_OFFLINE: "1",
			XDG_CONFIG_HOME: join(root, "config"),
		});
		delete process.env["XDG_DATA_HOME"];
		delete process.env["MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION"];

		expect((await initializeWorker()).commands.some((command) => command.name === "ctx-status")).toBeTrue();
		const initial = new Database(databasePath);
		expect(schemaVersion(initial)).toBe(82);
		expect(hasColumn(initial, "memory_verifications", "mapping_origin")).toBeTrue();
		initial.exec(
			"ALTER TABLE memory_verifications DROP COLUMN mapping_origin; DELETE FROM schema_migrations WHERE version = 82;",
		);
		expect(schemaVersion(initial)).toBe(81);
		initial.close();

		expect((await initializeWorker()).commands.some((command) => command.name === "ctx-status")).toBeTrue();
		const migrated = new Database(databasePath);
		expect(schemaVersion(migrated)).toBe(82);
		expect(hasColumn(migrated, "memory_verifications", "mapping_origin")).toBeTrue();
		migrated.close();

		process.env["MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION"] = "81";
		const stale = await initializeWorker();
		expect(stale.commands).toEqual([]);
		expect(stale.events).toEqual(["session_shutdown"]);
		expect(stale.tools).toEqual([]);
	} finally {
		for (const key of ENVIRONMENT_KEYS) {
			const value = originalEnvironment[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { force: true, recursive: true });
	}
});
