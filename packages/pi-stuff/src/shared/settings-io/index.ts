/**
 * Single-file shared settings I/O for Pi Stuff Package-owned configuration.
 *
 * All Package-owned settings converge into one JSON file at the agent directory:
 * `<agentDir>/pi-stuff.json`. Each Capability owns one namespace (top-level key)
 * inside that file and reads/writes only its own section. The whole file is one
 * locked, atomically-replaced document so concurrent writes from different
 * Capabilities serialize through one flock instead of one lock per file.
 *
 * Format is plain JSON (`JSON.parse` / `JSON.stringify`, no comments) for
 * machine-written determinism. The file is a plain `pi-stuff.json`.
 */

export {
	mergeNamespaceRecordEffect,
	readNamespaceEffect,
	readSettingsFileEffect,
	readTextFileEffect,
	SettingsFormatError,
	SettingsNamespaceError,
	type SettingsRecord,
} from "./file.ts";
// `acquireSettingsLockNative` (lock.js) is NOT re-exported here. It imports `bun:ffi`
// and must not be pulled into Node-only module graphs (e.g. compiled Goal
// upstream tests). Consumers that need the lock import it directly from
// `./lock.js`.
export { MERGED_SETTINGS_FILE, mergedSettingsPath, resolveSettingsLockPath } from "./paths.ts";
export {
	EffectNamespacedSettingsStore,
	type EffectNamespaceLegacyReader,
	type EffectNamespaceLock,
	type EffectNamespaceStoreOptions,
	type EffectNamespaceWriter,
	type NamespaceRecord,
} from "./store.ts";
