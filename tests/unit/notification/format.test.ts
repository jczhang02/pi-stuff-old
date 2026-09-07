import { describe, expect, test } from "bun:test";
import {
	extractNotificationPreview,
	formatNotificationContent,
} from "../../../packages/pi-stuff/src/notification/format.ts";

describe("Notification content", () => {
	test("the first prose paragraph becomes a bounded plain-text preview", () => {
		const preview = extractNotificationPreview([
			{
				text: [
					"# Result",
					"",
					"```sh",
					"printf 'secret'",
					"```",
					"",
					"**已修复** [tmux](https://example.invalid) 下的通知。\u001b]9;hidden\u0007",
					"",
					"第二段不会进入通知。",
				].join("\n"),
				type: "text",
			},
			{ thinking: "private reasoning", type: "thinking" },
		]);

		expect(preview).toBe("已修复 tmux 下的通知。");
	});

	test("semantic copy keeps the session and status in the title", () => {
		expect(
			formatNotificationContent({
				includeResponsePreview: true,
				outcome: "completion",
				preview: "已修复 tmux 下的通知。",
				session: "ps-9e7",
			}),
		).toEqual({ body: "已修复 tmux 下的通知。", title: "Pi · ps-9e7 — Ready" });

		expect(
			formatNotificationContent({
				includeResponsePreview: false,
				outcome: "completion",
				session: "ps-9e7",
			}),
		).toEqual({ body: "Ready for review.", title: "Pi · ps-9e7 — Ready" });

		expect(
			formatNotificationContent({
				includeResponsePreview: true,
				outcome: "failure",
				preview: "partial provider output",
				session: "ps-9e7",
			}),
		).toEqual({ body: "The run ended with an error.", title: "Pi · ps-9e7 — Needs attention" });
	});
});
