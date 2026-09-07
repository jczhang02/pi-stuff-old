import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { configureRuntimeSsrfDefaults } from "./runtime/index.js";
import type { WebFetchInput } from "./url-policy.ts";

const FAKE_IP_CANARY = "example.com";
const FAKE_IP_RANGE = "198.18.0.0/15";

export interface DnsAddress {
	readonly address: string;
	readonly family?: number;
}

export type DnsLookup = (hostname: string) => Promise<readonly DnsAddress[]>;
export type ConfigureRuntimeSsrf = (defaults: { readonly allowRanges: readonly string[] }) => void;

function isFakeIpAddress(address: string): boolean {
	if (isIP(address) !== 4) return false;
	const [first, second] = address.split(".").map(Number);
	return first === 198 && (second === 18 || second === 19);
}

function onlyFakeIpAddresses(addresses: readonly DnsAddress[]): boolean {
	return addresses.length > 0 && addresses.every(({ address }) => isFakeIpAddress(address));
}

function urls(input: WebFetchInput): readonly string[] {
	return input.url === undefined ? (input.urls ?? []) : [input.url];
}

async function systemLookup(hostname: string): Promise<readonly DnsAddress[]> {
	return dnsLookup(hostname, { all: true, verbatim: true });
}

/** Detect a system TUN resolver lazily, then enable the fork's in-memory default. */
export class FakeIpCompatibility {
	private readonly configure: ConfigureRuntimeSsrf;
	private detection: Deferred.Deferred<boolean | undefined, Error> | undefined;
	private readonly lookup: DnsLookup;
	private state: "active" | "inactive" | "unknown" = "unknown";

	constructor(lookup: DnsLookup = systemLookup, configure: ConfigureRuntimeSsrf = configureRuntimeSsrfDefaults) {
		this.lookup = lookup;
		this.configure = configure;
	}

	prepare(input: WebFetchInput): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			if (this.state !== "unknown") return;
			let detection = this.detection;
			let ownsDetection = false;
			if (!detection) {
				detection = Deferred.makeUnsafe<boolean | undefined, Error>();
				this.detection = detection;
				ownsDetection = true;
			}
			const clearDetection = Effect.sync(() => {
				if (this.detection === detection) this.detection = undefined;
			});
			const result = ownsDetection
				? yield* this.detect(input).pipe(
						Effect.tap((value) => Deferred.succeed(detection, value)),
						Effect.tapError((error) => Deferred.fail(detection, error).pipe(Effect.andThen(clearDetection))),
						Effect.onInterrupt(() => Deferred.interrupt(detection).pipe(Effect.andThen(clearDetection))),
					)
				: yield* Deferred.await(detection);
			if (this.state !== "unknown") return;
			if (this.detection === detection) this.detection = undefined;
			if (result === undefined) return;
			this.state = result ? "active" : "inactive";
			if (result) {
				yield* Effect.try({
					try: () => this.configure({ allowRanges: [FAKE_IP_RANGE] }),
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				});
			}
		});
	}

	private detect(input: WebFetchInput): Effect.Effect<boolean | undefined, Error> {
		return Effect.gen({ self: this }, function* () {
			const hostnames = yield* Effect.try({
				try: () => [
					...new Set(
						urls(input)
							.map((raw) => new URL(raw).hostname.replace(/^\[|\]$/gu, "").toLowerCase())
							.filter((hostname) => hostname.length > 0 && isIP(hostname) === 0),
					),
				],
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			});
			let uncertain = false;
			for (const hostname of hostnames) {
				const targetUsesFakeIp = yield* this.hostnameUsesFakeIp(hostname);
				if (targetUsesFakeIp === undefined) {
					uncertain = true;
					continue;
				}
				if (!targetUsesFakeIp) continue;
				return yield* this.hostnameUsesFakeIp(FAKE_IP_CANARY);
			}
			return uncertain ? undefined : false;
		});
	}

	private hostnameUsesFakeIp(hostname: string): Effect.Effect<boolean | undefined> {
		return Effect.tryPromise({
			try: () => this.lookup(hostname),
			catch: () => undefined,
		}).pipe(
			Effect.map(onlyFakeIpAddresses),
			Effect.catch(() => Effect.succeed(undefined)),
		);
	}
}
