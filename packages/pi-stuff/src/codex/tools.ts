// biome-ignore-all lint/complexity/useLiteralKeys: TypeScript enforces bracket access for untrusted index-signature data.
import { readFile, stat } from "node:fs/promises";
import {
	type AgentToolUpdateCallback,
	detectSupportedImageMimeTypeFromFile,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import {
	activityKey,
	registerSuiteOwnedTool,
	type SuiteToolRegistrationHost,
	singleActivity,
} from "../tool-display/index.ts";
import { isOpenAICodexResponsesModel, resolveCodexAccount, supportsCodexImages } from "./account.ts";
import { parseNativeJson, runNativeTool } from "./native-runner.ts";

export const IMAGE_GENERATION_MODEL = "gpt-image-2";

const APPLY_PATCH_PARAMETERS = Type.Object({
	input: Type.String({
		description: "Full patch text using *** Begin Patch / *** End Patch and Add, Update, or Delete File sections",
	}),
});
const VIEW_IMAGE_PARAMETERS = Type.Object({
	path: Type.String(),
	detail: Type.Optional(Type.Literal("original")),
});
const IMAGE_GENERATION_PARAMETERS = Type.Object({
	prompt: Type.String(),
	action: Type.Optional(Type.Union([Type.Literal("generate"), Type.Literal("edit")])),
	images: Type.Optional(Type.Array(Type.String())),
});

type ApplyPatchParams = Static<typeof APPLY_PATCH_PARAMETERS>;
type ViewImageParams = Static<typeof VIEW_IMAGE_PARAMETERS>;
type ImageGenerationParams = Static<typeof IMAGE_GENERATION_PARAMETERS>;

interface CodexToolArgumentAliases {
	readonly detail?: unknown;
	readonly file_path?: unknown;
	readonly image_path?: unknown;
	readonly input?: unknown;
	readonly patch?: unknown;
	readonly patchText?: unknown;
	readonly path?: unknown;
}

function argumentAliases<Value>(value: Value): CodexToolArgumentAliases {
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return {};
	// SAFETY: compatibility preparation reads only the declared aliases and leaves schema validation to Pi.
	return value as Value & CodexToolArgumentAliases;
}

const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_IMAGES = 4;

const CODEX_TOOL_NAMES = ["apply_patch", "view_image", "imagegen"] as const;

interface ApplyPatchResult {
	readonly changedFiles: string[];
	readonly createdFiles: string[];
	readonly deletedFiles: string[];
	readonly fuzz: number;
	readonly movedFiles: string[];
}

interface ApplyPatchNativeResult {
	readonly error?: string | null;
	readonly result?: ApplyPatchResult;
	readonly status?: "failure" | "success";
}

interface ImageContent {
	readonly data: string;
	readonly mimeType: string;
	readonly type: "image";
}

interface ViewImageDetails {
	readonly mimeType: string;
	readonly path: string;
}

interface GeneratedImage {
	readonly absolute_path?: string;
	readonly latest_path?: string;
	readonly path?: string;
}

interface ImageGenerationNativeResult {
	readonly images?: GeneratedImage[];
	readonly latest_path?: string;
	readonly path: string;
}

interface ImageGenerationDetails extends ImageGenerationNativeResult {
	readonly model: typeof IMAGE_GENERATION_MODEL;
}

function stringArray<Value>(value: Value): string[] | undefined {
	return Array.isArray(value) && value.every(isRuntimeString) ? [...value] : undefined;
}

function parseApplyPatchResult<Value>(value: Value): ApplyPatchResult | undefined {
	if (
		!isRuntimeObject(value) ||
		value === null ||
		!("changedFiles" in value) ||
		!("createdFiles" in value) ||
		!("deletedFiles" in value) ||
		!("movedFiles" in value) ||
		!("fuzz" in value) ||
		!isRuntimeNumber(value.fuzz)
	) {
		return undefined;
	}
	const changedFiles = stringArray(value.changedFiles);
	const createdFiles = stringArray(value.createdFiles);
	const deletedFiles = stringArray(value.deletedFiles);
	const movedFiles = stringArray(value.movedFiles);
	if (!changedFiles || !createdFiles || !deletedFiles || !movedFiles) return undefined;
	return { changedFiles, createdFiles, deletedFiles, fuzz: value.fuzz, movedFiles };
}

function parseApplyPatchNativeResult<Value>(value: Value): ApplyPatchNativeResult | undefined {
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return undefined;
	const parsed: ApplyPatchNativeResult = {};
	if ("error" in value && value.error !== undefined) {
		if (value.error !== null && !isRuntimeString(value.error)) return undefined;
		Object.assign(parsed, { error: value.error });
	}
	if ("status" in value && value.status !== undefined) {
		if (value.status !== "failure" && value.status !== "success") return undefined;
		Object.assign(parsed, { status: value.status });
	}
	if ("result" in value && value.result !== undefined) {
		const result = parseApplyPatchResult(value.result);
		if (!result) return undefined;
		Object.assign(parsed, { result });
	}
	return parsed;
}

function parseGeneratedImage<Value>(value: Value): GeneratedImage | undefined {
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return undefined;
	const image: GeneratedImage = {};
	if ("absolute_path" in value && value["absolute_path"] !== undefined) {
		if (!isRuntimeString(value["absolute_path"])) return undefined;
		Object.assign(image, { absolute_path: value["absolute_path"] });
	}
	if ("latest_path" in value && value["latest_path"] !== undefined) {
		if (!isRuntimeString(value["latest_path"])) return undefined;
		Object.assign(image, { latest_path: value["latest_path"] });
	}
	if ("path" in value && value["path"] !== undefined) {
		if (!isRuntimeString(value["path"])) return undefined;
		Object.assign(image, { path: value["path"] });
	}
	return image;
}

function parseImageGenerationNativeResult<Value>(value: Value): ImageGenerationNativeResult | undefined {
	if (
		!isRuntimeObject(value) ||
		value === null ||
		Array.isArray(value) ||
		!("path" in value) ||
		!isRuntimeString(value.path)
	) {
		return undefined;
	}
	const parsed: ImageGenerationNativeResult = { path: value.path };
	if ("latest_path" in value && value.latest_path !== undefined) {
		if (!isRuntimeString(value.latest_path)) return undefined;
		Object.assign(parsed, { latest_path: value.latest_path });
	}
	if ("images" in value && value.images !== undefined) {
		if (!Array.isArray(value.images)) return undefined;
		const images = value.images.flatMap((image) => {
			const parsedImage = parseGeneratedImage(image);
			return parsedImage ? [parsedImage] : [];
		});
		if (images.length !== value.images.length) return undefined;
		Object.assign(parsed, { images });
	}
	return parsed;
}

function oneLine(value: string): string {
	return value
		.split("")
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
		})
		.join("")
		.replaceAll(/\s+/gu, " ")
		.trim();
}

function nativeError(
	label: string,
	result: { readonly status: number | null; readonly stderr: string; readonly stdout: string },
): Error {
	const message = oneLine(result.stderr || result.stdout) || `${label} exited with status ${String(result.status)}.`;
	return new Error(message);
}

function patchTargets(patch: string): string[] {
	return [...patch.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gmu)]
		.map((match) => oneLine(match[1] ?? ""))
		.filter(Boolean);
}

function patchTarget(patch: string): string {
	const targets = patchTargets(patch);
	if (targets.length === 0) return "";
	return targets.length === 1 ? (targets[0] ?? "") : `${targets[0] ?? ""} +${String(targets.length - 1)}`;
}

function patchSummary(result: ApplyPatchResult): string {
	const changed = result.changedFiles.length;
	return changed === 1 ? "changed 1 file" : `changed ${String(changed)} files`;
}

function createApplyPatchTool() {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a structured patch to files",
		promptSnippet: "Use apply_patch for text-file edits; split oversized patches",
		parameters: APPLY_PATCH_PARAMETERS,
		executionMode: "sequential" as const,
		prepareArguments<Args>(args: Args) {
			const source = argumentAliases(args);
			for (const value of [source.input, source.patch, source.patchText]) {
				if (isRuntimeString(value)) return { input: value };
			}
			// SAFETY: unchanged invalid input is returned only so Pi's owning schema validator can reject it.
			return args as Args & ApplyPatchParams;
		},
		async execute(
			_toolCallId: string,
			params: ApplyPatchParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<ApplyPatchResult> | undefined,
			ctx: ExtensionContext,
		) {
			if (!isRuntimeString(params.input)) throw new Error("apply_patch requires a string input.");
			const native = await withFileMutationQueue(ctx.cwd, () =>
				runNativeTool({
					cwd: ctx.cwd,
					env: { ...process.env, PI_APPLY_PATCH_JSON: "1" },
					input: params.input,
					signal,
					tool: "apply_patch",
				}),
			);
			let parsed: ApplyPatchNativeResult | undefined;
			try {
				parsed = parseApplyPatchNativeResult(parseNativeJson(native.stdout, "apply_patch"));
			} catch (error) {
				if (native.status !== 0) throw nativeError("apply_patch", native);
				throw error;
			}
			if (!parsed || native.status !== 0 || parsed.status !== "success" || !parsed.result) {
				const partial = parsed?.result?.changedFiles.length
					? ` Earlier actions changed ${String(parsed.result.changedFiles.length)} file(s); inspect them before retrying.`
					: "";
				throw new Error(`${oneLine(parsed?.error ?? "") || nativeError("apply_patch", native).message}${partial}`);
			}
			return {
				content: [{ type: "text" as const, text: `Applied patch successfully. ${patchSummary(parsed.result)}.` }],
				details: parsed.result,
			};
		},
	};
}

function parseImageDataUrl(stdout: string): ImageContent {
	const value = parseNativeJson(stdout, "view_image");
	if (!isRuntimeObject(value) || value === null || !("image_url" in value) || !isRuntimeString(value["image_url"])) {
		throw new Error("view_image returned no image.");
	}
	const match = value["image_url"].match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u);
	if (!match?.[1] || !match[2]) throw new Error("view_image returned an unsupported image payload.");
	return { data: match[2], mimeType: match[1], type: "image" };
}

function createViewImageTool() {
	return {
		name: "view_image",
		label: "view_image",
		description: "View a local image",
		promptSnippet: "Use view_image to inspect local image files",
		parameters: VIEW_IMAGE_PARAMETERS,
		prepareArguments<Args>(args: Args) {
			if (!isRuntimeObject(args) || args === null || Array.isArray(args)) {
				// SAFETY: unchanged invalid input is returned only so Pi's owning schema validator can reject it.
				return args as Args & ViewImageParams;
			}
			const source = argumentAliases(args);
			const path = source.path ?? source.file_path ?? source.image_path;
			// SAFETY: non-string aliases remain unchanged only so Pi's owning schema validator can reject them.
			const preparedPath = isRuntimeString(path) && path.startsWith("@") ? path.slice(1) : (path as string);
			const prepared: ViewImageParams = { path: preparedPath };
			if (source.detail === "original") prepared.detail = "original";
			return prepared;
		},
		async execute(
			_toolCallId: string,
			params: ViewImageParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<ViewImageDetails> | undefined,
			ctx: ExtensionContext,
		) {
			if (!supportsCodexImages(ctx.model))
				throw new Error("view_image requires an image-capable OpenAI Codex model.");
			if (!isRuntimeString(params.path) || !params.path.trim()) throw new Error("view_image requires a path.");
			const native = await runNativeTool({
				arguments: [JSON.stringify(params)],
				cwd: ctx.cwd,
				signal,
				tool: "view_image",
			});
			if (native.status !== 0) throw nativeError("view_image", native);
			const image = parseImageDataUrl(native.stdout);
			return {
				content: [image],
				details: { mimeType: image.mimeType, path: params.path } satisfies ViewImageDetails,
			};
		},
	};
}

async function inlineGeneratedImages(images: readonly GeneratedImage[]): Promise<ImageContent[]> {
	const content: ImageContent[] = [];
	for (const image of images.slice(0, MAX_INLINE_IMAGES)) {
		if (!image.absolute_path) continue;
		try {
			const metadata = await stat(image.absolute_path);
			if (!metadata.isFile() || metadata.size > MAX_INLINE_IMAGE_BYTES) continue;
			const mimeType = await detectSupportedImageMimeTypeFromFile(image.absolute_path);
			if (!mimeType) continue;
			content.push({
				data: (await readFile(image.absolute_path)).toString("base64"),
				mimeType,
				type: "image",
			});
		} catch {
			// Persisted path remains in the text result when inline rendering cannot read it.
		}
	}
	return content;
}

function createImageGenerationTool() {
	return {
		name: "imagegen",
		label: "imagegen",
		description: `Generate or edit images with ${IMAGE_GENERATION_MODEL}`,
		promptSnippet: `Use imagegen for image generation or editing with ${IMAGE_GENERATION_MODEL}`,
		parameters: IMAGE_GENERATION_PARAMETERS,
		async execute(
			_toolCallId: string,
			params: ImageGenerationParams,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<ImageGenerationDetails> | undefined,
			ctx: ExtensionContext,
		) {
			if (!supportsCodexImages(ctx.model)) throw new Error("imagegen requires an image-capable OpenAI Codex model.");
			if (!isRuntimeString(params.prompt) || !params.prompt.trim()) throw new Error("imagegen requires a prompt.");
			const account = await resolveCodexAccount(ctx);
			const native = await runNativeTool({
				arguments: [
					JSON.stringify({
						...params,
						cwd: ctx.cwd,
						model: IMAGE_GENERATION_MODEL,
					}),
				],
				cwd: ctx.cwd,
				env: {
					...process.env,
					PI_CODEX_ACCESS_TOKEN: account.token,
					PI_CODEX_ACCOUNT_ID: account.accountId,
					PI_CODEX_BASE_URL: account.baseUrl,
				},
				signal,
				tool: "imagegen",
			});
			if (native.status !== 0) throw nativeError("imagegen", native);
			const parsed = parseImageGenerationNativeResult(parseNativeJson(native.stdout, "imagegen"));
			if (!parsed) throw new Error("imagegen returned an invalid structured result.");
			const images = await inlineGeneratedImages(parsed.images ?? []);
			return {
				content: [{ type: "text" as const, text: `Generated image: ${parsed.path}` }, ...images],
				details: { ...parsed, model: IMAGE_GENERATION_MODEL } satisfies ImageGenerationDetails,
			};
		},
	};
}

export interface CodexToolController {
	deactivate(): void;
	sync(model: ExtensionContext["model"]): void;
}

export function registerCodexTools(pi: SuiteToolRegistrationHost): CodexToolController {
	const applyPatch = createApplyPatchTool();
	const viewImage = createViewImageTool();
	const imageGeneration = createImageGenerationTool();
	registerSuiteOwnedTool(pi, applyPatch, {
		activity: {
			categories: ["change-file"],
			classify: ({ args, result }) => {
				const paths = parseApplyPatchResult(result?.details)?.changedFiles ?? patchTargets(args.input);
				return [
					{
						category: "change-file",
						countKeys: paths.map((path) => activityKey(path)),
						target: patchTarget(args.input),
					},
				];
			},
		},
		detailLines: (_args, result) => parseApplyPatchResult(result.details)?.changedFiles ?? [],
		label: "Patch",
		runningSummary: "applying",
		summarize: (_args, result, state) => {
			const details = parseApplyPatchResult(result.details);
			if (details) return patchSummary(details);
			const text = result.content.find((item) => item.type === "text")?.text ?? state;
			return oneLine(text.split(/\r?\n/u)[0] ?? state) || state;
		},
		target: (args) => patchTarget(args.input),
	});
	registerSuiteOwnedTool(pi, viewImage, {
		activity: {
			categories: ["view-image"],
			classify: ({ args }) => singleActivity("view-image", { key: activityKey(args.path), target: args.path }),
		},
		detailLines: (_args, result) => [`${result.details.mimeType} · ${result.details.path}`],
		label: "View",
		runningSummary: "loading",
		summarize: () => "loaded",
		target: (args) => args.path,
	});
	registerSuiteOwnedTool(pi, imageGeneration, {
		activity: {
			categories: ["generate-image"],
			classify: ({ args, result }) => {
				const paths = [
					...(result?.details.images ?? []).map((image) => image.absolute_path ?? image.path ?? ""),
					result?.details.path ?? "",
				].filter(Boolean);
				return [
					{
						category: "generate-image",
						...(paths.length > 0 ? { countKeys: paths.map((path) => activityKey(path)) } : { count: 1 }),
						target: oneLine(args.prompt),
					},
				];
			},
		},
		detailLines: (_args, result) => [
			`${result.details.model} · ${result.details.path}`,
			...(result.details.latest_path ? [`latest · ${result.details.latest_path}`] : []),
		],
		label: "Image",
		runningSummary: "generating",
		summarize: () => "generated",
		target: (args) => oneLine(args.prompt),
	});

	const setActive = (names: readonly string[]): void => {
		const owned = new Set<string>(CODEX_TOOL_NAMES);
		const retained = pi.getActiveTools().filter((name) => !owned.has(name));
		pi.setActiveTools([...retained, ...names]);
	};
	const controller: CodexToolController = {
		deactivate: () => setActive([]),
		sync(model) {
			if (!isOpenAICodexResponsesModel(model)) {
				setActive([]);
				return;
			}
			setActive(supportsCodexImages(model) ? CODEX_TOOL_NAMES : ["apply_patch"]);
		},
	};
	return controller;
}
