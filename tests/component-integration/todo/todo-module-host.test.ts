import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../../../packages/pi-stuff/src/shared/runtime-type.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");
const TODO_EXTENSION = join(REPOSITORY_ROOT, "packages", "pi-stuff", "src", "todo", "index.ts");
const EXPECTED_TOOLS = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];

const sessions: AgentSession[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		session.dispose();
	}
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type ExtensionPath = string | ((temporaryRoot: string) => Promise<string>);

async function loadExtension(extensionPath: ExtensionPath): Promise<AgentSession> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-todo-host-"));
	temporaryRoots.push(root);
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const resolvedExtensionPath = isRuntimeString(extensionPath) ? extensionPath : await extensionPath(root);

	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		additionalExtensionPaths: [resolvedExtensionPath],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const { session, extensionsResult } = await createAgentSession({
		cwd: root,
		agentDir,
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		noTools: "builtin",
	});
	sessions.push(session);

	expect(extensionsResult.errors).toEqual([]);
	expect(extensionsResult.extensions).toHaveLength(1);
	await session.bindExtensions({});
	return session;
}

test("the certified Pi Host loads exactly the Todo tools from the internal Module", async () => {
	const session = await loadExtension(TODO_EXTENSION);

	expect([...session.getActiveToolNames()].sort()).toEqual(EXPECTED_TOOLS);
});
