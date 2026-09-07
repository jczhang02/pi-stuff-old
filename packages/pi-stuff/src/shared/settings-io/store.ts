/** Effect-owned per-namespace settings over the single merged settings file. */

import { isDeepStrictEqual } from "node:util";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { isRuntimeString } from "../runtime-type.ts";
import {
	mergeNamespaceRecordEffect,
	readNamespaceEffect,
	SettingsFormatError,
	SettingsNamespaceError,
	type SettingsRecord,
} from "./file.ts";
import { mergedSettingsPath, resolveSettingsLockPath } from "./paths.ts";

export type NamespaceRecord = SettingsRecord;
export type NamespaceNormalizer<T extends NamespaceRecord> = <Value>(value: Value) => T;
export type EffectNamespaceWriter = (
	path: string,
	namespace: string,
	record: NamespaceRecord,
) => Effect.Effect<void, Error>;
export type EffectNamespaceLock = (lockPath: string, owner: string) => Effect.Effect<void, Error, Scope.Scope>;
export type EffectNamespaceLegacyReader = (legacyPath: string) => Effect.Effect<NamespaceRecord | undefined, Error>;

export interface NamespaceStoreDiagnostic {
	readonly action: "settings-load";
	readonly capability: "pi-stuff";
	readonly details: string;
	readonly error: unknown;
	readonly key: string;
	readonly severity: "warning";
	readonly summary: string;
	readonly visibility: "notice";
}

export type NamespaceDiagnosticReporter = (diagnostic: NamespaceStoreDiagnostic) => void;

export interface EffectNamespaceStoreOptions {
	/** Override the merged file path for tests. */
	readonly path?: string;
	/** Override the Effect writer for tests. */
	readonly writer?: EffectNamespaceWriter;
	/** Legacy per-Capability file to read without mutating it. */
	readonly legacyPath?: string;
	/** Parse a legacy file as an in-memory fallback when the namespace is absent. */
	readonly legacyReader?: EffectNamespaceLegacyReader;
	/** Acquire the whole-file lock before persisting. */
	readonly acquireLock?: EffectNamespaceLock;
	/** Capability-owned diagnostic adapter; the shared store has no UI dependency. */
	readonly reportDiagnostic?: NamespaceDiagnosticReporter;
}

type ExistingNamespace =
	| { readonly kind: "invalid" | "missing" }
	| { readonly kind: "loaded"; readonly record: SettingsRecord };

export class EffectNamespacedSettingsStore<T extends NamespaceRecord> {
	private readonly gate = Semaphore.makeUnsafe(1);
	private readonly listeners = new Set<(value: T) => void>();
	private readonly acquireLock: EffectNamespaceLock | undefined;
	private readonly lockPath: string;
	private readonly namespace: string;
	private readonly normalize: NamespaceNormalizer<T> | undefined;
	private readonly path: string;
	private readonly reportDiagnostic: NamespaceDiagnosticReporter | undefined;
	private readonly writer: EffectNamespaceWriter;
	private persistedValue: T;
	private value: T;

	private constructor(
		namespace: string,
		path: string,
		value: T,
		writer: EffectNamespaceWriter,
		acquireLock: EffectNamespaceLock | undefined,
		reportDiagnostic: NamespaceDiagnosticReporter | undefined,
		normalize: NamespaceNormalizer<T> | undefined,
	) {
		this.acquireLock = acquireLock;
		this.lockPath = path ? resolveSettingsLockPath(path) : "";
		this.namespace = namespace;
		this.normalize = normalize;
		this.path = path;
		this.reportDiagnostic = reportDiagnostic;
		this.writer = writer;
		this.value = value;
		this.persistedValue = value;
	}

	static load<T extends NamespaceRecord>(
		namespace: string,
		defaults: T,
		normalize: NamespaceNormalizer<T>,
		options: EffectNamespaceStoreOptions = {},
	): Effect.Effect<EffectNamespacedSettingsStore<T>, Error> {
		return Effect.gen(function* () {
			const path = options.path ?? mergedSettingsPath();
			const writer: EffectNamespaceWriter =
				options.writer ??
				((settingsPath, settingsNamespace, record) =>
					Effect.asVoid(mergeNamespaceRecordEffect(settingsPath, settingsNamespace, record)));
			const store = new EffectNamespacedSettingsStore(
				namespace,
				path,
				defaults,
				writer,
				options.acquireLock,
				options.reportDiagnostic,
				normalize,
			);
			yield* store.initialize(defaults, options.legacyPath, options.legacyReader);
			return store;
		});
	}

	static memory<T extends NamespaceRecord>(value: T): EffectNamespacedSettingsStore<T> {
		return new EffectNamespacedSettingsStore("", "", value, () => Effect.void, undefined, undefined, undefined);
	}

	get(): T {
		return this.value;
	}

	subscribe(listener: (value: T) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	whenIdle(): Effect.Effect<void> {
		return this.gate.withPermit(Effect.void);
	}

	update(patch: Partial<T>): Effect.Effect<T, Error> {
		return this.commit((current) => ({ ...current, ...patch }), true);
	}

	updateWith(apply: (current: T) => T): Effect.Effect<T, Error> {
		return this.commit(apply, true);
	}

	replace(next: T): Effect.Effect<T, Error> {
		return this.commit(() => next, false);
	}

	private commit(apply: (current: T) => T, readCurrent: boolean): Effect.Effect<T, Error> {
		return this.gate.withPermit(
			Effect.gen({ self: this }, function* () {
				if (!this.path) {
					const next = yield* Effect.try({
						try: () => apply(this.value),
						catch: (error) => (error instanceof Error ? error : new Error(String(error))),
					});
					this.replaceValue(next);
					return this.value;
				}
				return yield* this.persistNamespace(apply, readCurrent);
			}),
		);
	}

	private initialize(
		defaults: T,
		legacyPath: string | undefined,
		legacyReader: EffectNamespaceLegacyReader | undefined,
	): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			if (!this.path || !this.normalize) return;
			const existing = yield* this.readExisting();
			if (existing.kind !== "missing" || !legacyReader || !legacyPath) {
				const value =
					existing.kind === "loaded" ? yield* this.normalizeInitial(existing.record, defaults) : defaults;
				this.value = value;
				this.persistedValue = value;
				return;
			}

			yield* Effect.catch(
				Effect.gen({ self: this }, function* () {
					const legacy = yield* legacyReader(legacyPath);
					const value = legacy === undefined ? defaults : yield* this.normalizeValue(legacy);
					this.value = value;
					this.persistedValue = value;
				}),
				(error) => {
					if (isFileSystemError(error) && !isMissingFile(error)) return Effect.fail(error);
					return Effect.sync(() => {
						if (!isMissingFile(error)) {
							this.report(
								legacyPath,
								"invalid-legacy-settings",
								"Legacy settings were invalid and built-in defaults are active",
								error,
							);
						}
					});
				},
			);
		});
	}

	private readExisting(): Effect.Effect<ExistingNamespace, Error> {
		return Effect.catch(
			Effect.map(
				readNamespaceEffect(this.path, this.namespace),
				(record): ExistingNamespace => (record === undefined ? { kind: "missing" } : { kind: "loaded", record }),
			),
			(error) => {
				if (!(error instanceof SettingsFormatError || error instanceof SettingsNamespaceError)) {
					return Effect.fail(error);
				}
				return Effect.sync(() => {
					this.report(
						this.path,
						"invalid-settings",
						"Settings were invalid and built-in defaults are active",
						error,
					);
					return { kind: "invalid" } as const;
				});
			},
		);
	}

	private normalizeInitial(record: SettingsRecord, defaults: T): Effect.Effect<T> {
		return Effect.catch(this.normalizeValue(record), (error) =>
			Effect.sync(() => {
				this.report(this.path, "invalid-settings", "Settings were invalid and built-in defaults are active", error);
				return defaults;
			}),
		);
	}

	private normalizeValue(value: SettingsRecord): Effect.Effect<T, Error> {
		return Effect.try({
			try: () => this.normalize?.(value) ?? this.persistedValue,
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
	}

	private persistNamespace(apply: (current: T) => T, readCurrent: boolean): Effect.Effect<T, Error> {
		const persist = Effect.gen({ self: this }, function* () {
			const record = readCurrent ? yield* readNamespaceEffect(this.path, this.namespace) : undefined;
			const current =
				record === undefined || !this.normalize ? this.persistedValue : yield* this.normalizeValue(record);
			const next = yield* Effect.try({
				try: () => apply(current),
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			});
			if (readCurrent && isDeepStrictEqual(current, next)) {
				this.persistedValue = current;
				this.replaceValue(current);
				return this.value;
			}
			yield* this.writer(this.path, this.namespace, next);
			this.persistedValue = next;
			this.replaceValue(next);
			return this.value;
		});
		const criticalSection = Effect.uninterruptible(persist);
		const acquireLock = this.acquireLock;
		if (!acquireLock) return criticalSection;
		return Effect.scoped(
			Effect.gen({ self: this }, function* () {
				yield* acquireLock(this.lockPath, "pi-stuff");
				return yield* criticalSection;
			}),
		);
	}

	private replaceValue(next: T): void {
		if (isDeepStrictEqual(this.value, next)) return;
		this.value = next;
		for (const listener of this.listeners) {
			try {
				listener(this.value);
			} catch {
				// Presentation observers cannot block persistence.
			}
		}
	}

	private report(details: string, key: string, summary: string, cause: unknown): void {
		this.reportDiagnostic?.({
			action: "settings-load",
			capability: "pi-stuff",
			details,
			error: cause,
			key,
			severity: "warning",
			summary,
			visibility: "notice",
		});
	}
}

function isMissingFile(cause: unknown): cause is NodeJS.ErrnoException {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function isFileSystemError(cause: unknown): cause is NodeJS.ErrnoException {
	return cause instanceof Error && "code" in cause && isRuntimeString(cause.code);
}
