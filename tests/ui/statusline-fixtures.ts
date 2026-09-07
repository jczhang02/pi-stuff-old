import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type BooleanValueSource,
	type CodexStatusSnapshot,
	type CodexStatusSource,
	type GitChangeCounts,
	GitStatusSource,
	getCodexStatusChannel,
	getContextStatusChannel,
	getGoalStatusChannel,
	parseGitStatusPorcelain,
	type StatuslineContext,
	StatuslineController,
	type StatuslineHost,
	type StatuslinePreferences,
} from "../../packages/pi-stuff/src/conversation-ui/statusline.js";
import { createExtensionApi } from "../fixtures/extension-api.js";

class ValueSource<Value> {
	private readonly listeners = new Set<() => void>();
	private value: Value;

	constructor(value: Value) {
		this.value = value;
	}

	get(): Value {
		return this.value;
	}

	set(value: Value): void {
		this.value = value;
		for (const listener of this.listeners) listener();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

class CodexStatusValueSource implements CodexStatusSource {
	private readonly listeners = new Set<() => void>();
	private snapshot: CodexStatusSnapshot;

	constructor(snapshot: CodexStatusSnapshot) {
		this.snapshot = snapshot;
	}

	getSnapshot(): CodexStatusSnapshot {
		return this.snapshot;
	}

	set(snapshot: CodexStatusSnapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
function usage(cacheRead: number, cost: number, input = 10, cacheWrite = 0) {
	return {
		cacheRead,
		cacheWrite,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: cost },
		input,
		output: 5,
		totalTokens: input + 5 + cacheRead + cacheWrite,
	};
}

function messageEntries(prompt: string, cacheRead = 18_200, cost = 0.42, input = 10, cacheWrite = 0): SessionEntry[] {
	// SAFETY: this test controls the value and supplies every SessionEntry member exercised by this case.
	return [
		{
			id: "user",
			message: { content: prompt, role: "user", timestamp: 1 },
			parentId: null,
			timestamp: "2026-08-03T00:00:00Z",
			type: "message",
		},
		{
			id: "assistant",
			message: {
				api: "anthropic-messages",
				content: [],
				model: "sonnet-4.5",
				provider: "anthropic",
				role: "assistant",
				stopReason: "stop",
				timestamp: 2,
				usage: usage(cacheRead, cost, input, cacheWrite),
			},
			parentId: "user",
			timestamp: "2026-08-03T00:00:01Z",
			type: "message",
		},
	] as SessionEntry[];
}

function model(
	metered: boolean,
	id = "sonnet-4.5",
	provider = "anthropic",
	name = id,
	reasoning = true,
): NonNullable<StatuslineContext["model"]> {
	const rate = metered ? 3 : 0;
	return {
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		contextWindow: 200_000,
		cost: { cacheRead: rate, cacheWrite: rate, input: rate, output: rate },
		id,
		input: ["text"],
		maxTokens: 8_192,
		name,
		provider,
		reasoning,
	};
}

function context(options: {
	branch?: SessionEntry[];
	contextPercent?: number | null;
	contextWindow?: number | null;
	cwd?: string;
	idle?: () => boolean;
	metered?: boolean;
	modelId?: string;
	modelName?: string;
	provider?: string;
	reasoning?: boolean;
	sessionManager?: ExtensionContext["sessionManager"];
	subscription?: boolean;
}): StatuslineContext {
	const cwd = options.cwd ?? join(homedir(), "dev", "pi-stuff");
	const branch = options.branch ?? messageEntries("Implement the accepted Pi Stuff statusline.");
	const entriesById = new Map(branch.map((entry) => [entry.id, entry]));
	const sessionManagerFixture = {
		getBranch: () => branch,
		getCwd: () => cwd,
		getEntry: (id: string) => entriesById.get(id),
		getLeafId: () => branch.at(-1)?.id ?? null,
		getSessionId: () => "statusline-test-session",
	};
	// SAFETY: this controlled fixture implements exactly the SessionManager reads performed by the Statusline.
	const sessionManager = options.sessionManager ?? (sessionManagerFixture as ExtensionContext["sessionManager"]);
	return {
		cwd,
		getContextUsage: () => ({
			contextWindow: "contextWindow" in options ? options.contextWindow : 200_000,
			percent: "contextPercent" in options ? options.contextPercent : 42.4,
			tokens: 84_800,
		}),
		isIdle: options.idle ?? (() => true),
		model: model(options.metered ?? true, options.modelId, options.provider, options.modelName, options.reasoning),
		modelRegistry: { isUsingOAuth: () => options.subscription === true },
		sessionManager,
		thinkingLevel: "medium",
	};
}

function turnEntries(
	prefix: string,
	prompt: string,
	parentId: string | null,
	cacheRead: number,
	cost: number,
): [SessionEntry, SessionEntry] {
	const entries = messageEntries(prompt, cacheRead, cost);
	const user = entries[0];
	const assistant = entries[1];
	if (!user || !assistant) throw new Error("Expected a complete test turn");
	user.id = `${prefix}-user`;
	user.parentId = parentId;
	assistant.id = `${prefix}-assistant`;
	assistant.parentId = user.id;
	return [user, assistant];
}

function trackedSession(entries: SessionEntry[], initialLeafId: string) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let leafId = initialLeafId;
	const reads = { branches: 0, entries: 0 };
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const manager = {
		getBranch: () => {
			reads.branches += 1;
			const branch: SessionEntry[] = [];
			let entry = byId.get(leafId);
			while (entry) {
				branch.push(entry);
				entry = entry.parentId ? byId.get(entry.parentId) : undefined;
			}
			return branch.reverse();
		},
		getCwd: () => join(homedir(), "dev", "pi-stuff"),
		getEntry: (id: string) => {
			reads.entries += 1;
			return byId.get(id);
		},
		getLeafId: () => leafId,
		getSessionId: () => "tracked-statusline-session",
	} as ExtensionContext["sessionManager"];
	return {
		manager,
		reads,
		setLeaf: (id: string) => {
			if (!byId.has(id)) throw new Error(`Unknown test leaf: ${id}`);
			leafId = id;
		},
	};
}

function footerData(branch: string, statuses = new Map<string, string>()): ReadonlyFooterDataProvider {
	return {
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => statuses,
		getGitBranch: () => branch,
		onBranchChange: () => () => {},
	};
}

function api(
	thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> = "medium",
	skillNames: readonly string[] = [],
): StatuslineHost {
	return {
		getCommands: () =>
			skillNames.map((name) => ({
				description: `${name} skill`,
				name: `skill:${name}`,
				source: "skill",
				sourceInfo: { origin: "top-level", path: `${name}/SKILL.md`, scope: "user", source: "fixture" },
			})),
		getThinkingLevel: () => thinking,
	};
}

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

function tuiHarness() {
	const requests: Array<boolean | undefined> = [];
	return {
		requests,
		tui: { requestRender: (force?: boolean) => requests.push(force) },
	};
}

function withFormerFallbackOverride<Value>(run: () => Value): Value {
	const environment = process.env;
	const { POWERLINE_NERD_FONTS: previous } = environment;
	Reflect.set(environment, "POWERLINE_NERD_FONTS", "0");
	try {
		return run();
	} finally {
		if (previous === undefined) Reflect.deleteProperty(environment, "POWERLINE_NERD_FONTS");
		else Reflect.set(environment, "POWERLINE_NERD_FONTS", previous);
	}
}

function preferences(overrides: Partial<StatuslinePreferences> = {}): ValueSource<StatuslinePreferences> {
	return new ValueSource({
		density: "auto",
		enabled: true,
		latestPrompt: true,
		...overrides,
	});
}

export type { BooleanValueSource, ExtensionAPI, GitChangeCounts, ReadonlyFooterDataProvider, SessionEntry };
export {
	api,
	CodexStatusValueSource,
	context,
	createExtensionApi,
	footerData,
	GitStatusSource,
	getCodexStatusChannel,
	getContextStatusChannel,
	getGoalStatusChannel,
	homedir,
	join,
	messageEntries,
	parseGitStatusPorcelain,
	preferences,
	StatuslineController,
	type Theme,
	theme,
	trackedSession,
	tuiHarness,
	turnEntries,
	usage,
	ValueSource,
	visibleWidth,
	withFormerFallbackOverride,
};
