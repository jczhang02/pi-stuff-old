import { test } from "bun:test";
import { resolve } from "node:path";
import { verifyWebIntegration } from "../../../scripts/verify-web-integration.ts";

test(
	"Web integrates with local HTTP fixtures",
	() => verifyWebIntegration({ packagePath: resolve(import.meta.dirname, "../../../packages/pi-stuff") }),
	120_000,
);
