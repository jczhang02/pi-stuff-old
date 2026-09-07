import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHostSharedResource } from "../../../packages/pi-stuff/src/shared/host-resource.js";

type Events = ExtensionAPI["events"];

test("Host resource discovery fails initialization instead of creating a facade-local duplicate", () => {
	const local = new WeakMap<object, object>();
	let creates = 0;
	// SAFETY: this test controls the value and supplies every Events member exercised by this case.
	const emitFailure = {
		emit: () => {
			throw new Error("injected discovery failure");
		},
		on: () => () => {},
	} as Events;
	expect(() =>
		getHostSharedResource(emitFailure, local, "test:resource", () => {
			creates += 1;
			return {};
		}),
	).toThrow("injected discovery failure");
	expect(creates).toBe(0);

	// SAFETY: this test controls the value and supplies every Events member exercised by this case.
	const registrationFailure = {
		emit: () => {},
		on: () => {
			throw new Error("injected registration failure");
		},
	} as Events;
	expect(() => getHostSharedResource(registrationFailure, local, "test:resource", () => ({}))).toThrow(
		"injected registration failure",
	);
	expect(local.has(registrationFailure)).toBe(false);
});

test("Host resource cleanup remains idempotent when its event unsubscribe fails", () => {
	const local = new WeakMap<object, object>();
	const cleanups: Array<() => void> = [];
	let unsubscribeCalls = 0;
	// SAFETY: this test controls the value and supplies every Events member exercised by this case.
	const events = {
		emit: () => {},
		on: () => () => {
			unsubscribeCalls += 1;
			throw new Error("injected unsubscribe failure");
		},
	} as Events;
	const resource = getHostSharedResource(events, local, "test:resource", () => ({}), {
		registerOwnerCleanup: (cleanup) => cleanups.push(cleanup),
	});
	expect(local.get(events)).toBe(resource);
	expect(cleanups).toHaveLength(1);

	expect(() => cleanups[0]?.()).not.toThrow();
	expect(() => cleanups[0]?.()).not.toThrow();
	expect(unsubscribeCalls).toBe(1);
	expect(local.has(events)).toBe(false);
});
