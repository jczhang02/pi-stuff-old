import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { UiSettingsStore } from "../../packages/pi-stuff/src/conversation-ui/settings.js";
import { mergeNamespaceRecordEffect } from "../../packages/pi-stuff/src/shared/settings-io/index.js";

const [settingsPath, barrierPath, activeWriterPath, overlapPath, workerId] = process.argv.slice(2);
if (!settingsPath || !barrierPath || !activeWriterPath || !overlapPath || !workerId) {
	throw new Error("expected settings race worker arguments");
}

const store = await Effect.runPromise(
	UiSettingsStore.load(settingsPath, (path, namespace, settings) =>
		Effect.tryPromise({
			try: async () => {
				let ownsMarker = false;
				try {
					await mkdir(activeWriterPath);
					ownsMarker = true;
				} catch (error) {
					if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
					await writeFile(overlapPath, `overlap observed by worker ${workerId}\n`);
				}
				try {
					await Bun.sleep(40);
					await Effect.runPromise(mergeNamespaceRecordEffect(path, namespace, settings));
				} finally {
					if (ownsMarker) await rm(activeWriterPath, { force: true, recursive: true });
				}
			},
			catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
		}),
	),
);

await writeFile(join(barrierPath, `${workerId}.ready`), "ready\n");
while (!(await Bun.file(join(barrierPath, "go")).exists())) await Bun.sleep(1);

const setting = Number(workerId) % 2 === 0 ? "statusline" : "inputHighlighting";
await Effect.runPromise(store.set(setting, false));
