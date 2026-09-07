import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyGoalLifecycle } from "../../../scripts/verify-goal-lifecycle.ts";

test(
	"Goal lifecycle through the complete Suite",
	() =>
		verifyGoalLifecycle({
			piBinary: resolvePiBinary(),
			packagePath: resolve(import.meta.dirname, "../../../packages/pi-stuff"),
		}),
	120_000,
);
