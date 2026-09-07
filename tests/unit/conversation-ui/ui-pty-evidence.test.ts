import { expect, test } from "bun:test";
import { sanitizePtyEvidence } from "../../../scripts/verify-ui-pty.js";

test("visual evidence removes machine-specific fixture roots", () => {
	for (const root of [
		"/tmp/pi-stuff-ui-pty-Ab12cd",
		"/var/tmp/pi-stuff-ui-pty-Ef34gh",
		"/var/tmp/agent/pi-stuff-ui-pty-Ij56kl",
	]) {
		expect(sanitizePtyEvidence(`project: ${root}/100x32/project`)).toBe("project: [fixture]/100x32/project");
	}
});
