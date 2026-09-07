import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { parseRtkVersion } from "../packages/pi-stuff/src/rtk/runtime.ts";

type InstalledToolStatus = "ready" | "missing" | "nonexecutable" | "wrong-version" | "failed-probe";

type InstalledToolProbe = {
	readonly name: "Pi" | "RTK";
	readonly path?: string;
	readonly version?: string;
	readonly status: InstalledToolStatus;
};

const configuredPath = (name: "pi" | "rtk"): string | undefined => {
	const configured = process.env[name === "pi" ? "PI_BIN" : "RTK_BIN"]?.trim();
	const value = configured || name;
	// bun run prepends the development SDK's Node CLI; it is not the installed Pi Host.
	const path = (process.env["PATH"] ?? "")
		.split(delimiter)
		.filter((directory) => configured || name !== "pi" || !resolve(directory).endsWith(join("node_modules", ".bin")))
		.join(delimiter);
	return Bun.which(value, { PATH: path }) || configured || undefined;
};

export function resolvePiBinary(): string {
	const path = configuredPath("pi");
	if (!path)
		throw new Error(
			"Pi is missing; set PI_BIN to an installed executable or put pi on PATH outside node_modules/.bin",
		);
	return path;
}

export async function probeInstalledTool(
	name: "Pi" | "RTK",
	expectedVersion: string,
	path = configuredPath(name === "Pi" ? "pi" : "rtk"),
): Promise<InstalledToolProbe> {
	if (!path) return { name, status: "missing" };
	if (
		!(await access(path, constants.F_OK).then(
			() => true,
			() => false,
		))
	)
		return { name, path, status: "missing" };
	if (
		!(await access(path, constants.X_OK).then(
			() => true,
			() => false,
		))
	)
		return { name, path, status: "nonexecutable" };
	try {
		if (!(await stat(path)).isFile()) return { name, path, status: "nonexecutable" };
		const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const output = stdout.trim() || stderr.trim();
		const parsed = name === "RTK" ? parseRtkVersion(`${stdout}\n${stderr}`) : undefined;
		const version = parsed ? `rtk ${parsed}` : output;
		if (exitCode !== 0) return { name, path, version, status: "failed-probe" };
		if (version !== expectedVersion) return { name, path, version, status: "wrong-version" };
		return { name, path, version, status: "ready" };
	} catch {
		return { name, path, status: "failed-probe" };
	}
}

export function formatInstalledToolFailure(probe: InstalledToolProbe, expectedVersion: string): string {
	const target = probe.path ? ` at ${probe.path}` : "";
	if (probe.status === "missing")
		return `${probe.name}${target} is missing; set ${probe.name === "Pi" ? "PI_BIN" : "RTK_BIN"} to an installed executable or put ${probe.name.toLowerCase()} on PATH`;
	if (probe.status === "nonexecutable")
		return `${probe.name}${target} is not executable; point ${probe.name === "Pi" ? "PI_BIN" : "RTK_BIN"} at an executable file`;
	if (probe.status === "wrong-version")
		return `${probe.name}${target} reports ${probe.version || "no version"}, expected ${expectedVersion}; point ${probe.name === "Pi" ? "PI_BIN" : "RTK_BIN"} at an installed ${expectedVersion}`;
	return `${probe.name}${target} failed its --version probe${probe.version ? ` (${probe.version})` : ""}; point ${probe.name === "Pi" ? "PI_BIN" : "RTK_BIN"} at a working installed executable`;
}
