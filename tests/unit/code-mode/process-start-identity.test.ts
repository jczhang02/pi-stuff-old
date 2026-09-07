import { expect, test } from "bun:test";
import { readProcessStartIdentity } from "../../../packages/pi-stuff/src/code-mode/host/process-start-identity.js";

test("reads a boot-bound Linux process generation without depending on the command name", () => {
	const fields = Array.from({ length: 20 }, () => "0");
	fields[0] = "S";
	fields[19] = "987654";
	const files = new Map([
		["/proc/sys/kernel/random/boot_id", "fixture-boot\n"],
		["/proc/42/stat", `42 (a command ) with spaces) ${fields.join(" ")}\n`],
	]);
	expect(
		readProcessStartIdentity(42, {
			platform: "linux",
			readTextFile(path) {
				const value = files.get(path);
				if (value === undefined) throw new Error(`unexpected path: ${path}`);
				return value;
			},
		}),
	).toBe("fixture-boot:987654");
});

test("reads Darwin and FreeBSD process generations through bounded ps output", () => {
	for (const platform of ["darwin", "freebsd"] as const) {
		let invocation: readonly string[] = [];
		expect(
			readProcessStartIdentity(73, {
				platform,
				run(command, arguments_) {
					invocation = [command, ...arguments_];
					return { status: 0, stdout: " Tue Aug 11 17:01:02 2026 \n" };
				},
			}),
		).toBe(`${platform}:Tue Aug 11 17:01:02 2026`);
		expect(invocation).toEqual(["/bin/ps", "-o", "lstart=", "-p", "73"]);
	}
});

test("reads a Windows process generation through an absolute noninteractive PowerShell", () => {
	let invocation: readonly string[] = [];
	expect(
		readProcessStartIdentity(91, {
			platform: "win32",
			run(command, arguments_) {
				invocation = [command, ...arguments_];
				return { status: 0, stdout: "638905572620000000\r\n" };
			},
			systemRoot: "C:\\Windows",
		}),
	).toBe("win32:638905572620000000");
	expect(invocation[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	expect(invocation).toContain("-NonInteractive");
	expect(invocation.at(-1)).toContain("Get-Process -Id 91");
});

test("fails closed for invalid identities, command failures, and unsupported platforms", () => {
	expect(readProcessStartIdentity(0)).toBeUndefined();
	expect(
		readProcessStartIdentity(1, {
			platform: "darwin",
			run: () => ({ status: 1, stdout: "" }),
		}),
	).toBeUndefined();
	expect(
		readProcessStartIdentity(1, {
			platform: "win32",
			run: () => ({ status: 0, stdout: "not-a-timestamp" }),
		}),
	).toBeUndefined();
	expect(readProcessStartIdentity(1, { platform: "aix" })).toBeUndefined();
});
