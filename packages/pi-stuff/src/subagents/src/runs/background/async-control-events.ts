/** Bounded cursor-based observation of durable async control events. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { isRuntimeNumber } from "../../../../shared/runtime-type.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { errnoCode } from "../../shared/private-directory.ts";
import type { AsyncJobState } from "../../shared/types.ts";
import { DIAGNOSTIC_EVENT_HEADER_BYTES, diagnosticEventOffset } from "./runner-output.ts";

const CONTROL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CONTROL_EVENT_LINE_BYTES = 1024 * 1024;
const CONTROL_EVENT_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;

type ControlEventRead = { changed: boolean; more: boolean };

function openControlEvents(job: AsyncJobState, eventsPath: string): Effect.Effect<fs.promises.FileHandle | undefined> {
	const noFollow = isRuntimeNumber(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
	return Effect.tryPromise({
		try: () => fs.promises.open(eventsPath, fs.constants.O_RDONLY | noFollow),
		catch: (error) => error,
	}).pipe(
		Effect.catch((error) =>
			Effect.sync(() => {
				if (errnoCode(error) === "ENOENT") {
					if (job.controlEventCursorPending) {
						job.controlEventCursor = 0;
						job.controlEventCursorPending = false;
					}
				} else {
					reportAgentDiagnostic(`Failed to open async control events for '${job.asyncDir}':`, error);
				}
				return undefined;
			}),
		),
	);
}

function readOpenControlEvents(
	job: AsyncJobState,
	handle: fs.promises.FileHandle,
	onLine: (line: string) => boolean,
): Effect.Effect<ControlEventRead> {
	return Effect.gen(function* () {
		let changed = false;
		let more = false;
		const result = yield* Effect.tryPromise({
			try: async () => {
				const stat = await handle.stat();
				const currentUid = process.getuid?.();
				if (!stat.isFile() || (currentUid !== undefined && stat.uid !== currentUid)) return { changed, more };
				const identity = `${String(stat.dev)}:${String(stat.ino)}`;
				if (job.controlEventIdentity !== identity) {
					const header = Buffer.alloc(Math.min(stat.size, DIAGNOSTIC_EVENT_HEADER_BYTES));
					await handle.read(header, 0, header.length, 0);
					const offset = diagnosticEventOffset(header);
					if (job.controlEventIdentity !== undefined) {
						job.controlEventCursor =
							offset === undefined
								? 0
								: Math.max(0, (job.controlEventCursor ?? 0) + (job.controlEventOffset ?? 0) - offset);
					}
					job.controlEventOffset = offset ?? 0;
					job.controlEventIdentity = identity;
				}
				if (job.controlEventCursorPending) {
					job.controlEventCursor = stat.size;
					job.controlEventCursorPending = false;
					return { changed, more };
				}
				const savedCursor = job.controlEventCursor;
				let cursor = stat.size < (savedCursor ?? 0) ? 0 : (savedCursor ?? 0);
				const startedFromTail = savedCursor === undefined && stat.size > CONTROL_EVENT_SCAN_WINDOW_BYTES;
				if (startedFromTail) cursor = stat.size - CONTROL_EVENT_SCAN_WINDOW_BYTES;
				if (stat.size <= cursor) return { changed, more };
				const scanEnd = Math.min(stat.size, cursor + CONTROL_EVENT_SCAN_WINDOW_BYTES);
				const buffer = Buffer.alloc(scanEnd - cursor);
				let offset = 0;
				while (offset < buffer.length) {
					const toRead = Math.min(CONTROL_EVENT_READ_CHUNK_BYTES, buffer.length - offset);
					const { bytesRead } = await handle.read(buffer, offset, toRead, cursor + offset);
					if (bytesRead === 0) break;
					offset += bytesRead;
				}
				const observed = offset === buffer.length ? buffer : buffer.subarray(0, offset);
				let lineStart = 0;
				let committedCursor = cursor;
				if (startedFromTail) {
					const newline = observed.indexOf(0x0a);
					if (newline === -1) {
						job.controlEventCursor = cursor + observed.length;
						return { changed, more: job.controlEventCursor < stat.size };
					}
					lineStart = newline + 1;
					committedCursor = cursor + lineStart;
				}
				for (let index = lineStart; index < observed.length; index += 1) {
					if (observed[index] !== 0x0a) continue;
					const line = observed.subarray(lineStart, index);
					if (line.length <= MAX_CONTROL_EVENT_LINE_BYTES) changed = onLine(line.toString("utf-8")) || changed;
					lineStart = index + 1;
					committedCursor = cursor + lineStart;
					job.controlEventCursor = committedCursor;
				}
				if (observed.length - lineStart > MAX_CONTROL_EVENT_LINE_BYTES) {
					job.controlEventCursor = cursor + observed.length;
				} else if (committedCursor > cursor) {
					job.controlEventCursor = committedCursor;
				}
				more = (job.controlEventCursor ?? 0) < stat.size;
				return { changed, more };
			},
			catch: (error) => error,
		}).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					reportAgentDiagnostic(`Failed to read async control events for '${job.asyncDir}':`, error);
					return { changed, more };
				}),
			),
		);
		return result;
	});
}

export function readNewAsyncControlEvents(
	job: AsyncJobState,
	onLine: (line: string) => boolean,
): Effect.Effect<ControlEventRead, unknown> {
	const eventsPath = path.join(job.asyncDir, "events.jsonl");
	return openControlEvents(job, eventsPath).pipe(
		Effect.flatMap((handle) =>
			handle
				? Effect.acquireUseRelease(
						Effect.succeed(handle),
						(open) => readOpenControlEvents(job, open, onLine),
						(open) => Effect.tryPromise({ try: () => open.close(), catch: (error) => error }),
					)
				: Effect.succeed({ changed: false, more: false }),
		),
	);
}
