import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { GeneratedSessionName } from "./model.ts";
import type { NamingMessage } from "./prompt.ts";
import type { SessionNamingSettings } from "./settings.ts";
import {
	getLastRenameMarker,
	getSessionNameTimestamp,
	namingMessages,
	type RenameMarker,
	type RenameMode,
} from "./state.ts";

export type SessionNamingState = "disabled" | "failed" | "fallback" | "named" | "running" | "unnamed";

export interface SessionNamingControllerHost {
	appendMarker(marker: RenameMarker): void;
	generate(
		messages: readonly NamingMessage[],
		currentName: string | undefined,
	): Effect.Effect<GeneratedSessionName | undefined, Error>;
	getBranch(): readonly SessionEntry[];
	getSessionName(): string | undefined;
	now(): number;
	setSessionName(name: string): void;
}

export class SessionNamingController {
	private generation = 0;
	private readonly host: SessionNamingControllerHost;
	private lastGeneratedName: string | undefined;
	private lastRenameTime = 0;
	private manualName: string | undefined;
	private readonly settings: SessionNamingSettings;
	private state: SessionNamingState;

	constructor(settings: SessionNamingSettings, host: SessionNamingControllerHost) {
		this.settings = settings;
		this.host = host;
		this.state = settings.enabled ? "unnamed" : "disabled";
	}

	restore(): void {
		const existingName = this.host.getSessionName()?.trim();
		const branch = this.host.getBranch();
		const marker = getLastRenameMarker(branch);
		this.lastGeneratedName = undefined;
		this.manualName = undefined;
		this.lastRenameTime = 0;
		if (!existingName) {
			this.state = this.settings.enabled ? "unnamed" : "disabled";
			return;
		}
		if (!marker || marker.name !== existingName) {
			this.manualName = existingName;
			this.lastRenameTime = getSessionNameTimestamp(branch, existingName) ?? this.host.now();
			this.state = this.settings.enabled ? "named" : "disabled";
			return;
		}
		this.lastRenameTime = marker.timestamp || this.host.now();
		if (marker.source === "user") this.manualName = marker.name;
		else this.lastGeneratedName = marker.name;
		this.state =
			this.settings.enabled && existingName
				? marker.source === "fallback"
					? "fallback"
					: "named"
				: this.settings.enabled
					? "unnamed"
					: "disabled";
	}

	getState(): SessionNamingState {
		return this.state;
	}

	handleSettled(): Effect.Effect<string | undefined> {
		return Effect.suspend(() => {
			if (!this.settings.enabled || this.state === "running") return Effect.succeed(undefined);
			if (this.settings.respectManualName && this.manualName) return Effect.succeed(undefined);
			const existingName = this.host.getSessionName()?.trim();
			if (this.state === "unnamed" || this.state === "failed" || this.state === "fallback" || !existingName) {
				return this.rename("initial");
			}
			const cooldownMs = this.settings.cooldownMinutes * 60_000;
			return this.host.now() - this.lastRenameTime >= cooldownMs
				? this.rename("periodic")
				: Effect.succeed(undefined);
		});
	}

	renameManually(): Effect.Effect<string | undefined> {
		return this.rename("forced");
	}

	observeSessionNameChange(name: string | undefined): boolean {
		const normalized = name?.trim();
		if (normalized && normalized === this.lastGeneratedName) return false;
		this.lastGeneratedName = undefined;
		this.generation += 1;
		if (!normalized) {
			this.manualName = undefined;
			if (this.settings.enabled) this.state = "unnamed";
			return true;
		}
		this.manualName = normalized;
		this.lastRenameTime = this.host.now();
		this.state = this.settings.enabled ? "named" : "disabled";
		this.host.appendMarker({ name: normalized, source: "user", timestamp: this.lastRenameTime });
		return true;
	}

	shutdown(): void {
		this.generation += 1;
		this.state = "disabled";
	}

	private rename(mode: RenameMode): Effect.Effect<string | undefined> {
		return Effect.suspend(() => {
			const generation = ++this.generation;
			this.state = "running";
			return Effect.gen({ self: this }, function* () {
				const input = yield* Effect.try({
					try: () => ({
						currentName: this.host.getSessionName()?.trim(),
						messages: namingMessages(this.host.getBranch(), mode === "initial"),
					}),
					catch: normalizeError,
				});
				const result = yield* this.host.generate(input.messages, input.currentName);
				if (generation !== this.generation) return undefined;
				if (!result) {
					this.state = this.settings.enabled ? "failed" : "disabled";
					return undefined;
				}
				return yield* Effect.try({
					try: () => {
						const { name, source } = result;
						this.lastGeneratedName = name;
						this.manualName = undefined;
						if (this.host.getSessionName()?.trim() !== name) this.host.setSessionName(name);
						this.lastRenameTime = this.host.now();
						this.host.appendMarker({ mode, name, source, timestamp: this.lastRenameTime });
						this.state = this.settings.enabled ? (source === "fallback" ? "fallback" : "named") : "disabled";
						return name;
					},
					catch: normalizeError,
				});
			}).pipe(
				Effect.catch(() =>
					Effect.sync(() => {
						if (generation === this.generation) this.state = this.settings.enabled ? "failed" : "disabled";
						return undefined;
					}),
				),
			);
		});
	}
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
