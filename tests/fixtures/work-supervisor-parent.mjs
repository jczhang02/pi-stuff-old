import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

function processStartIdentity(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		const end = stat.lastIndexOf(")");
		const started = stat
			.slice(end + 1)
			.trim()
			.split(/\s+/u)[19];
		return started ? `linux:${started}` : undefined;
	} catch {
		return undefined;
	}
}

const [, , supervisorPath, readyPath, treePath] = process.argv;
if (!supervisorPath || !readyPath || !treePath) throw new Error("missing supervisor fixture arguments");
const parentStarted = processStartIdentity(process.pid);
if (!parentStarted) throw new Error("cannot identify fixture parent");
const commandAuthorizationPath = `${readyPath}.command`;
const commandAuthorizationToken = `fixture-${process.pid}-${Date.now()}`;
const envelope = Buffer.from(
	JSON.stringify({
		commandAuthorizationPath,
		commandAuthorizationToken,
		commandTransport: "argv",
		cwd: process.cwd(),
		parentPid: process.pid,
		parentStarted,
		shell: "/bin/sh",
		shellArgs: ["-c"],
	}),
	"utf-8",
).toString("base64url");
const supervisor = spawn(process.execPath, [supervisorPath, envelope], {
	detached: true,
	stdio: ["ignore", "pipe", "ignore"],
});
const command = `trap '' TERM HUP INT; sh -c 'trap "" TERM HUP INT; while :; do sleep 1; done' & echo "$$ $!" > ${JSON.stringify(treePath)}; wait`;
const temporary = `${commandAuthorizationPath}.tmp`;
writeFileSync(temporary, `${JSON.stringify({ version: 1, token: commandAuthorizationToken, command })}\n`, {
	mode: 0o600,
});
renameSync(temporary, commandAuthorizationPath);
let buffer = "";
supervisor.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf-8");
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		const event = JSON.parse(line);
		if (event.type === "started") {
			writeFileSync(
				readyPath,
				JSON.stringify({ commandPid: event.pid, parentPid: process.pid, supervisorPid: supervisor.pid }),
			);
		}
	}
});
setInterval(() => {}, 1_000);
