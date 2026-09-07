import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CERTIFIED_RTK_VERSION } from "../../../packages/pi-stuff/src/rtk/runtime.ts";
import { formatInstalledToolFailure, probeInstalledTool, resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyRtkPty } from "../../../scripts/verify-rtk-pty.ts";

test("RTK settings and projection use the exact renamed override in the real terminal", async () => {
	const probe = await probeInstalledTool("RTK", `rtk ${CERTIFIED_RTK_VERSION}`);
	if (probe.status !== "ready" || !probe.path)
		throw new Error(formatInstalledToolFailure(probe, `rtk ${CERTIFIED_RTK_VERSION}`));
	const piBinary = resolvePiBinary();
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-rtk override-"));
	const selected = join(directory, "selected-runtime");
	const originalRtkBinary = process.env["RTK_BIN"];
	try {
		const quotedOriginal = `'${probe.path.replaceAll("'", "'\\''")}'`;
		await writeFile(selected, `#!/bin/sh\nexec ${quotedOriginal} "$@"\n`, { mode: 0o755 });
		await writeFile(join(directory, "rtk"), "#!/bin/sh\necho 'rtk 0.44.0'\n", { mode: 0o755 });
		process.env["RTK_BIN"] = selected;
		await verifyRtkPty({ piBinary, packagePath: resolve(import.meta.dirname, "../../../packages/pi-stuff") });
	} finally {
		if (originalRtkBinary === undefined) delete process.env["RTK_BIN"];
		else process.env["RTK_BIN"] = originalRtkBinary;
		await rm(directory, { recursive: true, force: true });
	}
}, 120_000);
