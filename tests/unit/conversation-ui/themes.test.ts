import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dir, "../../../packages/pi-stuff");
const flavors = ["frappe", "latte", "macchiato", "mocha"] as const;
const paletteKeys = [
	"rosewater",
	"pink",
	"mauve",
	"red",
	"peach",
	"yellow",
	"green",
	"teal",
	"sky",
	"sapphire",
	"blue",
	"lavender",
	"text",
	"subtext1",
	"subtext0",
	"overlay2",
	"overlay1",
	"overlay0",
	"surface2",
	"surface1",
	"surface0",
	"base",
	"mantle",
] as const;
const paletteDigests = {
	frappe: "f4c040a4945c6318df79a4c4e0a627fe3548245da4f7cbedfa2f1f4d7725d1cf",
	latte: "d73d4a0670fb273d737cb0703ca80160674072206eef97c0bda7086d31e15daf",
	macchiato: "5cd1fd99248d713c352c3e9a5f9bd3692d5a9c9e1140ebb3f665c1b1fed2513d",
	mocha: "80621b904473d938e1d7c7039ed1d7b8be3eb43bf138d024c96a4fda575a789e",
} satisfies Readonly<Record<(typeof flavors)[number], string>>;
const requiredColors = [
	"accent",
	"bashMode",
	"border",
	"borderAccent",
	"borderMuted",
	"customMessageBg",
	"customMessageLabel",
	"customMessageText",
	"dim",
	"error",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdHeading",
	"mdHr",
	"mdLink",
	"mdLinkUrl",
	"mdListBullet",
	"mdQuote",
	"mdQuoteBorder",
	"muted",
	"scrollbarThumb",
	"selectedBg",
	"success",
	"syntaxComment",
	"syntaxFunction",
	"syntaxKeyword",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxPunctuation",
	"syntaxString",
	"syntaxType",
	"syntaxVariable",
	"text",
	"thinkingHigh",
	"thinkingLow",
	"thinkingMax",
	"thinkingMedium",
	"thinkingMinimal",
	"thinkingOff",
	"thinkingText",
	"thinkingXhigh",
	"toolDiffAdded",
	"toolDiffContext",
	"toolDiffRemoved",
	"toolErrorBg",
	"toolOutput",
	"toolPendingBg",
	"toolSuccessBg",
	"toolTitle",
	"userMessageBg",
	"userMessageText",
	"warning",
].sort();

interface ThemeJson {
	name: string;
	vars: Record<string, string>;
	colors: Record<string, string>;
	export: Record<string, string>;
}

function blend(base: string, color: string): string {
	return `#${[1, 3, 5]
		.map((offset) =>
			Math.round(
				Number.parseInt(base.slice(offset, offset + 2), 16) * 0.88 +
					Number.parseInt(color.slice(offset, offset + 2), 16) * 0.12,
			)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

test("the Package ships all four complete official Catppuccin themes", async () => {
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const manifest = (await Bun.file(join(packageDirectory, "package.json")).json()) as {
		files?: unknown;
		pi?: unknown;
	};
	expect(manifest.files).toContain("themes");
	expect(manifest.pi).toEqual({
		extensions: ["./index.ts"],
		skills: ["./src/ponytail/skills"],
		themes: ["./themes/*.json"],
	});

	for (const flavor of flavors) {
		// SAFETY: this test controls the value and supplies every ThemeJson member exercised by this case.
		const theme = (await Bun.file(join(packageDirectory, "themes", `catppuccin-${flavor}.json`)).json()) as ThemeJson;
		expect(theme.name).toBe(`catppuccin-${flavor}`);
		expect(Object.keys(theme.colors).sort()).toEqual(requiredColors);
		expect(Object.keys(theme.export).sort()).toEqual(["cardBg", "infoBg", "pageBg"]);
		for (const value of [...Object.values(theme.colors), ...Object.values(theme.export)]) {
			expect(theme.vars[value] ?? value).toMatch(/^#[0-9a-f]{6}$/u);
		}

		const palette = paletteKeys.map((key) => `${key}:${theme.vars[key]}`).join("\n");
		expect(new Bun.CryptoHasher("sha256").update(palette).digest("hex")).toBe(paletteDigests[flavor]);
		const { base, green, mauve, red } = theme.vars;
		if (!base || !green || !mauve || !red) throw new Error(`${flavor} is missing a required palette variable`);
		expect(theme.vars["toolPendingSurface"]).toBe(blend(base, mauve));
		expect(theme.vars["toolSuccessSurface"]).toBe(blend(base, green));
		expect(theme.vars["toolErrorSurface"]).toBe(blend(base, red));
	}

	expect(await readFile(join(packageDirectory, "themes", "LICENSE"), "utf8")).toContain(
		"Copyright (c) 2021 Catppuccin",
	);
});
