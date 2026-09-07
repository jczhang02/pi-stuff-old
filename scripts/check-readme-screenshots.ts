import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ASSET_ROOT = "docs/assets/readme/";
const SCREENSHOT_PATTERN =
	/<p align="center">\r?\n {2}<a href="([^"\r\n]+)">\r?\n {4}<img src="([^"\r\n]+)" alt="[^"\r\n]+" width="100%">\r?\n {2}<\/a>\r?\n {2}<br>\r?\n {2}<em>[^<\r\n]+<\/em>\r?\n<\/p>/gu;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface ReadmeScreenshotFinding {
	readonly path: string;
	readonly rule: string;
}

type ResolveTarget = (sourcePath: string, rawTarget: string) => string | undefined;

function screenshotTargets(path: string, markdown: string, resolveTarget: ResolveTarget) {
	return [...markdown.matchAll(SCREENSHOT_PATTERN)].map((match) => ({
		href: match[1] ?? "",
		src: match[2] ?? "",
		target: resolveTarget(path, match[2] ?? ""),
	}));
}

async function pngMetadata(
	root: string,
	path: string,
): Promise<{ readonly height: number; readonly sha256: string; readonly width: number } | undefined> {
	try {
		const png = await readFile(join(root, path));
		if (
			png.length < 24 ||
			!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
			png.toString("ascii", 12, 16) !== "IHDR"
		) {
			return undefined;
		}
		return {
			height: png.readUInt32BE(20),
			sha256: createHash("sha256").update(png).digest("hex"),
			width: png.readUInt32BE(16),
		};
	} catch {
		return undefined;
	}
}

export async function auditReadmeScreenshots(
	root: string,
	paths: readonly string[],
	markdown: ReadonlyMap<string, string>,
	resolveTarget: ResolveTarget,
): Promise<ReadmeScreenshotFinding[]> {
	const readmes = [...markdown.keys()].filter(
		(path) =>
			(path === "README.md" || path.endsWith("/README.md")) &&
			!path.startsWith("docs/i18n/zh-CN/") &&
			!path.startsWith("tests/"),
	);
	const findings: ReadmeScreenshotFinding[] = [];
	const owners = new Map<string, string>();
	const contentOwners = new Map<string, string>();
	const used = new Set<string>();
	const metadata = new Map<string, Awaited<ReturnType<typeof pngMetadata>>>();
	for (const path of readmes) {
		const screenshots = screenshotTargets(path, markdown.get(path) ?? "", resolveTarget);
		const expectedCount = path === "README.md" ? 3 : path === "packages/pi-stuff/README.md" ? 2 : 1;
		if (screenshots.length === 0) findings.push({ path, rule: "readme-screenshot-missing" });
		if (screenshots.length !== expectedCount) {
			findings.push({
				path,
				rule: `readme-screenshot-count:${String(screenshots.length)}/${String(expectedCount)}`,
			});
		}
		const sourceTargets = new Set<string>();
		for (const screenshot of screenshots) {
			if (screenshot.href !== screenshot.src) findings.push({ path, rule: "readme-screenshot-link-mismatch" });
			const { target } = screenshot;
			if (!target?.startsWith(ASSET_ROOT)) {
				findings.push({ path, rule: `readme-screenshot-invalid-target:${screenshot.src}` });
				continue;
			}
			sourceTargets.add(target);
			used.add(target);
			const owner = owners.get(target);
			if (owner && owner !== path) findings.push({ path, rule: `readme-screenshot-reused:${owner}` });
			else owners.set(target, path);
			if (!target.endsWith(".png")) {
				findings.push({ path, rule: "readme-screenshot-must-be-png" });
				continue;
			}
			if (!metadata.has(target)) metadata.set(target, await pngMetadata(root, target));
			const png = metadata.get(target);
			if (!png) findings.push({ path, rule: `readme-screenshot-missing-or-invalid:${target}` });
			else {
				if (png.width !== 1600 || png.height !== 900) {
					findings.push({ path, rule: `readme-screenshot-size:${String(png.width)}x${String(png.height)}` });
				}
				const contentOwner = contentOwners.get(png.sha256);
				if (contentOwner) {
					findings.push({ path, rule: `readme-screenshot-duplicate-content:${contentOwner}` });
				} else contentOwners.set(png.sha256, target);
			}
		}
		const mirrorPath = `docs/i18n/zh-CN/${path}`;
		const mirror = markdown.get(mirrorPath);
		if (mirror) {
			const mirrorTargets = new Set(
				screenshotTargets(mirrorPath, mirror, resolveTarget)
					.map(({ target }) => target)
					.filter((target): target is string => target !== undefined),
			);
			if (JSON.stringify([...sourceTargets].sort()) !== JSON.stringify([...mirrorTargets].sort())) {
				findings.push({ path: mirrorPath, rule: "readme-screenshot-translation-mismatch" });
			}
		}
	}
	for (const path of paths) {
		if (path.startsWith(ASSET_ROOT) && !used.has(path)) findings.push({ path, rule: "readme-screenshot-orphan" });
	}
	return findings;
}
