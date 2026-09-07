import { expect, test } from "bun:test";
import {
	hasCredentialSource,
	requireCredential,
	resolveCredential,
} from "../../../packages/pi-stuff/src/web/runtime/credential-source.js";

test("1Password references are detected without executing and resolve through argv only on demand", async () => {
	let calls = 0;
	const options = {
		provider: "Parallel",
		configuredValue: "op://Private/Parallel/api-key",
		environment: { HOME: "/home/test", OP_SESSION_WORK: "session", UNRELATED_SECRET: "drop" },
		runProgram: async (
			program: string,
			args: readonly string[],
			command: { environment: Record<string, string>; timeoutMs: number },
		) => {
			calls += 1;
			expect(program).toBe("op");
			expect(args).toEqual(["read", "--no-newline", "op://Private/Parallel/api-key"]);
			expect(command.environment).toEqual({ HOME: "/home/test", OP_SESSION_WORK: "session" });
			expect(command.timeoutMs).toBe(60_000);
			return { stdout: "resolved-key\n" };
		},
	};
	expect(hasCredentialSource(options)).toBe(true);
	expect(calls).toBe(0);
	expect(await resolveCredential(options)).toBe("resolved-key");
	expect(calls).toBe(1);
});

test("1Password failures expose neither the reference nor subprocess detail", async () => {
	const reference = "op://Private/Parallel/highly-sensitive-item";
	try {
		await resolveCredential({
			provider: "Parallel",
			configuredValue: reference,
			runProgram: async () => {
				throw new Error(`failed to read ${reference}`);
			},
		});
		throw new Error("expected credential resolution to fail");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toBe("Parallel credential resolution failed: command-failed");
		expect(message).not.toContain(reference);
	}
});

test("1Password output remains bounded and terminal-safe", async () => {
	await expect(
		resolveCredential({
			provider: "Parallel",
			configuredValue: "op://Private/Parallel/api-key",
			runProgram: async () => ({ stdout: "bad\nkey" }),
		}),
	).rejects.toThrow("command-invalid-output");
});

test("required credentials preserve the provider's missing-key message", async () => {
	await expect(requireCredential({ provider: "Test" }, "Test key missing")).rejects.toThrow("Test key missing");
});
