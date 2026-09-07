import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { beginSuiteNativeCompactionPreflight, reportDiagnostic } from "../conversation-ui/index.ts";
import type { NativeCompactionSettings } from "./magic-runtime.ts";

/** Native-only preparation for Suite custom turns while Magic is explicitly inactive. */
export class NativeContextPreflight {
	private pending: Deferred.Deferred<void> | undefined;
	private readonly readSettings: (ctx: ExtensionContext) => NativeCompactionSettings | undefined;
	constructor(readSettings: (ctx: ExtensionContext) => NativeCompactionSettings | undefined) {
		this.readSettings = readSettings;
	}
	wait(): Effect.Effect<void> {
		return this.pending ? Deferred.await(this.pending) : Effect.void;
	}
	run(ctx: ExtensionContext, requireIdle = true): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this.pending) return Deferred.await(this.pending);
			if (requireIdle) {
				try {
					if (!ctx.isIdle()) return Effect.void;
				} catch {
					return Effect.void;
				}
			}
			let settings: NativeCompactionSettings | undefined;
			try {
				settings = this.readSettings(ctx);
			} catch (error) {
				reportDiagnostic({
					capability: "Context",
					error,
					key: "native-custom-turn-settings",
					severity: "warning",
					summary: "Native compaction settings could not be read before a Suite custom turn",
					visibility: "silent",
				});
				return Effect.void;
			}
			if (!settings?.enabled || !Number.isFinite(settings.reserveTokens) || settings.reserveTokens < 0)
				return Effect.void;
			let usage: ReturnType<ExtensionContext["getContextUsage"]>;
			try {
				usage = ctx.getContextUsage();
			} catch {
				return Effect.void;
			}
			if (!usage || usage.tokens === null || usage.contextWindow <= 0) return Effect.void;
			if (usage.tokens <= usage.contextWindow - settings.reserveTokens) return Effect.void;
			const finishPreflight = beginSuiteNativeCompactionPreflight(ctx);
			const flight = Deferred.makeUnsafe<void>();
			this.pending = flight;
			return Effect.callback<void>((resume) => {
				let settled = false;
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					if (error) {
						reportDiagnostic({
							capability: "Context",
							error,
							key: "native-custom-turn-compaction",
							severity: "warning",
							summary: "Native compaction could not finish before a Suite custom turn",
							visibility: "silent",
						});
					}
					resume(Effect.void);
				};
				try {
					ctx.compact({ onComplete: () => finish(), onError: finish });
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			}).pipe(
				// Pi exposes no cancellation handle, so keep the flight published until its callback settles.
				Effect.uninterruptible,
				Effect.onExit((exit) => Deferred.done(flight, exit)),
				Effect.ensuring(
					Effect.sync(() => {
						finishPreflight();
						if (this.pending === flight) this.pending = undefined;
					}),
				),
			);
		});
	}
}
