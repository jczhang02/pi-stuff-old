import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const recordPath = process.argv[2];
if (!recordPath) throw new Error("Expected a process record path");
const exitAfterSpawn = process.argv[3] === "exit-after-spawn";

const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);'], {
	stdio: exitAfterSpawn ? ["ignore", "inherit", "inherit"] : "ignore",
});
writeFileSync(recordPath, `${JSON.stringify({ childPid: child.pid, parentPid: process.pid })}\n`);
if (exitAfterSpawn) process.exit(0);
setInterval(() => {}, 1_000);
