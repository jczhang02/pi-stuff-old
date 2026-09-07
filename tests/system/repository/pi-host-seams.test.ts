import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyPiHostSeams } from "../../../scripts/verify-pi-host-seams.ts";

test(
	"Pi public Host seams preserve lifecycle ownership",
	() =>
		verifyPiHostSeams({
			piBinary: resolvePiBinary(),
			packagePath: resolve(import.meta.dirname, "../../../packages/pi-stuff"),
		}),
	120_000,
);
