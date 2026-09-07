import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyNotificationPty } from "../../../scripts/verify-notification-pty.ts";

test(
	"Notification interactions in the real terminal",
	() =>
		verifyNotificationPty({
			piBinary: resolvePiBinary(),
			packagePath: resolve(import.meta.dirname, "../../../packages/pi-stuff"),
			columns: 64,
			rows: 28,
		}),
	120_000,
);
