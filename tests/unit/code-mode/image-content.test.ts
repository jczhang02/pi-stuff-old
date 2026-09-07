import { expect, test } from "bun:test";
import {
	assertDecodableSupportedCodeModeImages,
	codeModeImageFromDataUrl,
	hasCompleteCodeModeImageEnvelope,
	INVALID_CODE_MODE_IMAGE_MESSAGE,
	sanitizeCodeModeContent,
} from "../../../packages/pi-stuff/src/code-mode/image-content.js";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NoAAAAggCB3UNq9AAAAABJRU5ErkJggg==";

test("accepts complete supported image data URLs", () => {
	expect(codeModeImageFromDataUrl(`data:image/png;base64,${PNG_DATA}`)).toEqual({
		data: PNG_DATA,
		mimeType: "image/png",
		type: "image",
	});
	expect(
		hasCompleteCodeModeImageEnvelope({
			data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
			mimeType: "image/gif",
			type: "image",
		}),
	).toBe(true);
});

test("rejects an image whose container looks complete but cannot be decoded", async () => {
	const bytes = Buffer.from(PNG_DATA, "base64");
	bytes[45] = (bytes[45] ?? 0) ^ 0xff;
	const corrupt = { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
	expect(hasCompleteCodeModeImageEnvelope(corrupt)).toBe(true);
	await expect(assertDecodableSupportedCodeModeImages([corrupt])).rejects.toThrow(INVALID_CODE_MODE_IMAGE_MESSAGE);
});

test("rejects truncated Base64 even when its text remains syntactically valid", () => {
	const truncatedTail = Buffer.alloc(38_400, 1).toString("base64");
	expect(truncatedTail).toHaveLength(51_200);
	expect(() => codeModeImageFromDataUrl(`data:image/jpeg;base64,${truncatedTail}`)).toThrow(
		INVALID_CODE_MODE_IMAGE_MESSAGE,
	);
});

test("quarantines image payloads contaminated by truncation notices", () => {
	const contaminated = `${Buffer.alloc(38_400, 1).toString("base64")}
[Output truncated from 299560 to 51200 characters]
<system-reminder>retry</system-reminder>`;
	const original = [{ type: "image" as const, data: contaminated, mimeType: "image/jpeg" }];
	const sanitized = sanitizeCodeModeContent(original);

	expect(sanitized).toEqual({
		content: [{ type: "text", text: INVALID_CODE_MODE_IMAGE_MESSAGE }],
		rejected: 1,
	});
	expect(original[0]?.data).toBe(contaminated);
});
