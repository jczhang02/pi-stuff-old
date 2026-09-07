import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatInstalledToolFailure, probeInstalledTool } from "../../../scripts/installed-tools.ts";

test("probes installed tools by executable, version, and probe status", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-installed-tools-"));
	try {
		const wrong = join(directory, "wrong");
		const valid = join(directory, "valid");
		await writeFile(wrong, "#!/bin/sh\necho rtk 0.44.0\n");
		await writeFile(valid, "#!/bin/sh\necho rtk 0.45.0\n");
		await chmod(wrong, 0o755);
		await chmod(valid, 0o755);
		expect((await probeInstalledTool("RTK", "rtk 0.45.0", join(directory, "missing"))).status).toBe("missing");
		expect((await probeInstalledTool("RTK", "rtk 0.45.0", wrong)).status).toBe("wrong-version");
		expect((await probeInstalledTool("RTK", "rtk 0.45.0", valid)).status).toBe("ready");
		await chmod(valid, 0o644);
		expect((await probeInstalledTool("RTK", "rtk 0.45.0", valid)).status).toBe("nonexecutable");
		await chmod(valid, 0o755);
		await writeFile(valid, "#!/bin/sh\necho broken >&2\nexit 1\n");
		const failed = await probeInstalledTool("RTK", "rtk 0.45.0", valid);
		expect(failed.status).toBe("failed-probe");
		expect(formatInstalledToolFailure(failed, "rtk 0.45.0")).toContain(valid);
		expect(formatInstalledToolFailure(failed, "rtk 0.45.0")).toContain("broken");
		await writeFile(valid, "#!/bin/sh\necho 'rtk v0.45.0'\n");
		expect((await probeInstalledTool("RTK", "rtk 0.45.0", valid)).status).toBe("ready");
		expect((await probeInstalledTool("Pi", "0.85.1", directory)).status).toBe("nonexecutable");
		expect(formatInstalledToolFailure({ name: "RTK", status: "missing" }, "rtk 0.45.0")).toContain("RTK is missing");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
