import { expect, test } from "bun:test";
import { readHostProxyProperty } from "../../../packages/pi-stuff/src/shared/host-proxy.js";

class HostSurface {
	label: string;

	constructor(label: string) {
		this.label = label;
	}

	get decoratedLabel(): string {
		return `[${this.label}]`;
	}
}

test("Host proxy lookup uses ordinary target access and preserves target Proxy traps", () => {
	const target = new HostSurface("target");
	const receiver = new HostSurface("receiver");
	const reads: PropertyKey[] = [];
	const proxied = new Proxy(target, {
		get(inner, property) {
			reads.push(property);
			// SAFETY: this test Proxy forwards only HostSurface keys supplied by the property reads below.
			return inner[property as keyof HostSurface];
		},
	});

	expect(readHostProxyProperty(proxied, "decoratedLabel")).toBe("[target]");
	expect(readHostProxyProperty(proxied, "label")).toBe("target");
	expect(readHostProxyProperty(proxied, "missing")).toBeUndefined();
	expect(reads).toEqual(["decoratedLabel", "label", "missing"]);
	expect(receiver.decoratedLabel).toBe("[receiver]");
});
