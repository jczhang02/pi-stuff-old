import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionContext,
	getMarkdownTheme,
	InteractiveMode,
	type MarkdownTransformer,
	type parseSkillBlock,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import {
	isRuntimeBoolean,
	isRuntimeFunction,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../shared/runtime-type.ts";
import { DiagnosticChannel } from "./diagnostics.ts";
import { UserMessageCard } from "./user-message-card.ts";

const LAST_HOST = Symbol.for("@jczhang02/pi-stuff:user-message-host/v1");

const USER_MESSAGE_PATCH = Symbol.for("@jczhang02/pi-stuff:user-message-patch/v1");

interface HostPresentation {
	chatContainer: Container;
	outputPad: number;
	toolOutputExpanded: boolean;
	markdownTheme: MarkdownTheme;
	transformers: readonly MarkdownTransformer[];
}

interface InsertOptions {
	populateHistory?: boolean;
}

type InsertMessage = (this: InteractiveMode, message: AgentMessage, options?: InsertOptions) => void;

interface PatchState {
	original: InsertMessage;
	patched: InsertMessage;
	owners: number;
	enabled: boolean;
	diagnostics: DiagnosticChannel | undefined;
	descriptor: PropertyDescriptor;
}

function hostPresentation(host: InteractiveMode): HostPresentation {
	const chat: unknown = Object.getOwnPropertyDescriptor(host, "chatContainer")?.value;
	const padding: unknown = Object.getOwnPropertyDescriptor(host, "outputPad")?.value;
	const expanded: unknown = Object.getOwnPropertyDescriptor(host, "toolOutputExpanded")?.value;
	if (
		!(chat instanceof Container) ||
		!isRuntimeNumber(padding) ||
		!Number.isSafeInteger(padding) ||
		padding < 0 ||
		!isRuntimeBoolean(expanded)
	) {
		throw new Error("User Message presentation requires the certified Pi InteractiveMode layout");
	}
	const getTheme: unknown = Object.getOwnPropertyDescriptor(
		InteractiveMode.prototype,
		"getMarkdownThemeWithSettings",
	)?.value;
	const getTransformers: unknown = Object.getOwnPropertyDescriptor(
		InteractiveMode.prototype,
		"getMarkdownTransformers",
	)?.value;
	if (!isRuntimeFunction(getTheme) || !isRuntimeFunction(getTransformers)) {
		throw new Error("User Message presentation requires the certified Pi Markdown accessors");
	}
	// SAFETY: these callable accessors have the certified Host signatures; they are invoked on its real instance.
	const readTheme = getTheme as (this: InteractiveMode) => MarkdownTheme;
	// SAFETY: the callable accessor returns the native user Markdown transformers in the certified Host.
	const readTransformers = getTransformers as (this: InteractiveMode) => readonly MarkdownTransformer[];
	return {
		chatContainer: chat,
		outputPad: padding,
		toolOutputExpanded: expanded,
		markdownTheme: readTheme.call(host),
		transformers: readTransformers.call(host),
	};
}

function readSkill(component: SkillInvocationMessageComponent): NonNullable<ReturnType<typeof parseSkillBlock>> {
	const skill: unknown = Object.getOwnPropertyDescriptor(component, "skillBlock")?.value;
	if (
		!isRuntimeObject(skill) ||
		skill === null ||
		!("name" in skill) ||
		!isRuntimeString(skill.name) ||
		!("location" in skill) ||
		!isRuntimeString(skill.location) ||
		!("content" in skill) ||
		!isRuntimeString(skill.content) ||
		!("userMessage" in skill) ||
		(skill.userMessage !== undefined && !isRuntimeString(skill.userMessage))
	) {
		throw new Error("User Message presentation requires the certified Pi Skill metadata");
	}
	return { name: skill.name, location: skill.location, content: skill.content, userMessage: skill.userMessage };
}

function readPrompt(component: UserMessageComponent): string {
	const text: unknown = Object.getOwnPropertyDescriptor(component, "text")?.value;
	if (!isRuntimeString(text)) throw new Error("User Message presentation requires the certified Pi prompt");
	return text;
}

function projectMessage(host: HostPresentation, first: number, fail: (error: Error) => void): void {
	const children = host.chatContainer.children;
	const component = children[first];
	if (component instanceof UserMessageCard) return;
	if (!(component instanceof SkillInvocationMessageComponent) && !(component instanceof UserMessageComponent)) {
		throw new Error("User Message presentation found unexpected Host components");
	}
	const skill = component instanceof SkillInvocationMessageComponent ? readSkill(component) : null;
	const prompt = component instanceof UserMessageComponent ? readPrompt(component) : (skill?.userMessage ?? "");
	const count = skill?.userMessage ? 3 : 1;
	const trailing = children[first + 2];
	if (
		count === 3 &&
		(!(children[first + 1] instanceof Spacer) ||
			!(trailing instanceof UserMessageComponent) ||
			readPrompt(trailing) !== prompt)
	) {
		throw new Error("User Message presentation found an unexpected Skill prompt");
	}
	const fallback = new Container();
	for (const child of children.slice(first, first + count)) fallback.addChild(child);
	const card = new UserMessageCard(prompt, {
		markdownTheme: host.markdownTheme,
		outputPad: host.outputPad,
		transformers: host.transformers,
		skill,
		fallback,
		fail,
	});
	card.setExpanded(host.toolOutputExpanded);
	children.splice(first, count, card);
}

function adoptReplayedMessages(state: PatchState, sessionManager: ExtensionContext["sessionManager"]): void {
	const reference: unknown = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, LAST_HOST)?.value;
	if (!(reference instanceof WeakRef)) return;
	const host: unknown = reference.deref();
	if (!(host instanceof InteractiveMode)) return;
	try {
		const readManager = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "sessionManager")?.get;
		if (!readManager) throw new Error("User Message presentation lost the Pi SessionManager accessor");
		const manager: unknown = readManager.call(host);
		if (manager !== sessionManager) return;
		const presentation = hostPresentation(host);
		// Pi reload replays before session_start. Reconcile once at binding, never on redraw or each insertion.
		for (let index = 0; state.enabled && index < presentation.chatContainer.children.length; index += 1) {
			const component = presentation.chatContainer.children[index];
			if (component instanceof UserMessageComponent || component instanceof SkillInvocationMessageComponent) {
				projectMessage(presentation, index, (error) => disable(state, error));
			}
		}
	} catch (error) {
		disable(state, error instanceof Error ? error : new Error("User Message replay projection failed"));
	}
}

function preflight(): void {
	if (!isRuntimeFunction(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "sessionManager")?.get)) {
		throw new Error("User Message presentation requires the certified Pi SessionManager accessor");
	}
	for (const method of ["getMarkdownThemeWithSettings", "getMarkdownTransformers"]) {
		if (!isRuntimeFunction(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, method)?.value)) {
			throw new Error(`User Message presentation requires InteractiveMode.${method}()`);
		}
	}
	const nativeSkill = new SkillInvocationMessageComponent({
		name: "preflight",
		location: "preflight/SKILL.md",
		content: "Instructions",
		userMessage: undefined,
	});
	const skill = readSkill(nativeSkill);
	nativeSkill.render(40);
	const sample = new UserMessageComponent("User Message preflight", getMarkdownTheme(), 1);
	readPrompt(sample);
	sample.render(40);
	const fallback = new Container();
	fallback.addChild(sample);
	const card = new UserMessageCard("User Message preflight", {
		markdownTheme: getMarkdownTheme(),
		outputPad: 1,
		transformers: [],
		skill,
		fallback,
		fail: (error) => {
			throw error;
		},
	});
	card.render(40);
}

function isPatchState<Value>(value: Value): value is Value & PatchState {
	return (
		value !== null &&
		isRuntimeObject(value) &&
		"original" in value &&
		isRuntimeFunction(value.original) &&
		"patched" in value &&
		isRuntimeFunction(value.patched) &&
		"owners" in value &&
		isRuntimeNumber(value.owners) &&
		Number.isSafeInteger(value.owners) &&
		value.owners > 0 &&
		"enabled" in value &&
		isRuntimeBoolean(value.enabled) &&
		"diagnostics" in value &&
		(value.diagnostics === undefined || value.diagnostics instanceof DiagnosticChannel) &&
		"descriptor" in value &&
		value.descriptor !== null &&
		isRuntimeObject(value.descriptor)
	);
}

function disable(state: PatchState, error: Error): void {
	if (!state.enabled) return;
	state.enabled = false;
	state.diagnostics?.report({
		capability: "Conversation UI",
		key: "user-message-display",
		summary: "User Message styling is unavailable; native messages are preserved.",
		action: "Use /reload to retry; inspect /diagnostics for details.",
		visibility: "notice",
		error,
	});
}

function createPatch(
	original: InsertMessage,
	descriptor: PropertyDescriptor,
	diagnostics: DiagnosticChannel,
): PatchState {
	const state: PatchState = { original, descriptor, patched: original, owners: 0, enabled: true, diagnostics };
	state.patched = function (message, options): void {
		Object.defineProperty(InteractiveMode.prototype, LAST_HOST, { configurable: true, value: new WeakRef(this) });
		if (!state.enabled || message.role !== "user") {
			original.call(this, message, options);
			return;
		}
		let presentation: HostPresentation;
		try {
			presentation = hostPresentation(this);
		} catch (error) {
			disable(state, error instanceof Error ? error : new Error("User Message Host layout is unavailable"));
			original.call(this, message, options);
			return;
		}
		const start = presentation.chatContainer.children.length;
		original.call(this, message, options);
		try {
			const first = start + (start > 0 ? 1 : 0);
			if (first < presentation.chatContainer.children.length) {
				projectMessage(presentation, first, (error) => disable(state, error));
			}
		} catch (error) {
			disable(state, error instanceof Error ? error : new Error("User Message projection failed"));
		}
	};
	return state;
}

/** Install a display-only adapter at the one native user insertion and replay seam. */
export function installUserMessageDisplay(
	diagnostics: DiagnosticChannel,
	sessionManager: ExtensionContext["sessionManager"],
): () => void {
	// ponytail: Pi 0.85.1 has no public User Message renderer; replace this patch when the Host exposes one.
	const prototype = InteractiveMode.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "addMessageToChat");
	const method: unknown = descriptor?.value;
	if (!descriptor?.configurable || !descriptor.writable || !isRuntimeFunction(method)) {
		throw new Error("User Message presentation requires writable InteractiveMode.addMessageToChat()");
	}
	const existing: unknown = Object.getOwnPropertyDescriptor(prototype, USER_MESSAGE_PATCH)?.value;
	let state: PatchState;
	if (existing !== undefined) {
		if (!isPatchState(existing) || method !== existing.patched) {
			throw new Error("User Message presentation found an incompatible Host adapter");
		}
		state = existing;
	} else {
		preflight();
		// SAFETY: the certified Host method is callable and its insertion signature is fixed by Pi 0.85.1.
		state = createPatch(method as InsertMessage, descriptor, diagnostics);
		Object.defineProperty(prototype, USER_MESSAGE_PATCH, { configurable: true, value: state });
		Object.defineProperty(prototype, "addMessageToChat", { ...descriptor, value: state.patched });
	}
	state.owners += 1;
	if (state.owners === 1) adoptReplayedMessages(state, sessionManager);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		state.owners -= 1;
		if (state.owners > 0) return;
		state.enabled = false;
		state.diagnostics = undefined;
		if (Object.getOwnPropertyDescriptor(prototype, "addMessageToChat")?.value === state.patched) {
			Object.defineProperty(prototype, "addMessageToChat", state.descriptor);
		}
		if (Object.getOwnPropertyDescriptor(prototype, USER_MESSAGE_PATCH)?.value === state)
			Reflect.deleteProperty(prototype, USER_MESSAGE_PATCH);
	};
}
