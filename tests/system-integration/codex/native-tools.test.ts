import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseNativeJson,
	resolveNativeBinary,
	runNativeTool,
} from "../../../packages/pi-stuff/src/codex/native-runner.js";
import { IMAGE_GENERATION_MODEL } from "../../../packages/pi-stuff/src/codex/tools.js";
import { isRuntimeObject, isRuntimeString } from "../../../packages/pi-stuff/src/shared/runtime-type.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-codex-native-"));
	temporaryRoots.push(root);
	return root;
}

test("apply_patch executes directly and accepts shell case/esac text", async () => {
	const root = await temporaryRoot();
	const patch = [
		"*** Begin Patch",
		"*** Add File: sample.sh",
		'+case "$1" in',
		"+  start) echo started ;;",
		"+  *) echo unknown ;;",
		"+esac",
		"*** End Patch",
	].join("\n");
	const result = await runNativeTool({
		cwd: root,
		env: { ...process.env, PI_APPLY_PATCH_JSON: "1" },
		input: patch,
		tool: "apply_patch",
	});
	expect(result.status).toBe(0);
	expect(parseNativeJson(result.stdout, "apply_patch")).toMatchObject({ status: "success" });
	expect(await readFile(join(root, "sample.sh"), "utf8")).toBe(
		'case "$1" in\n  start) echo started ;;\n  *) echo unknown ;;\nesac\n',
	);
});

test("view_image returns an inline image payload", async () => {
	const root = await temporaryRoot();
	const path = join(root, "pixel.png");
	await writeFile(
		path,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		),
	);
	const result = await runNativeTool({ arguments: [JSON.stringify({ path })], cwd: root, tool: "view_image" });
	expect(result.status).toBe(0);
	const parsed = parseNativeJson(result.stdout, "view_image");
	if (
		!isRuntimeObject(parsed) ||
		parsed === null ||
		!("image_url" in parsed) ||
		!isRuntimeString(parsed["image_url"])
	) {
		throw new Error("Expected view_image to return an image_url");
	}
	expect(parsed["image_url"]).toStartWith("data:image/png;base64,");
});

test("only gpt-image-2 is exposed for image generation", () => {
	expect(IMAGE_GENERATION_MODEL).toBe("gpt-image-2");
	expect(resolveNativeBinary("imagegen", { arch: "arm64", platform: "linux" })).toBeUndefined();
});
