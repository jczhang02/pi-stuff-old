import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { BoundedOutputFile } from "./output.ts";
import {
	abandonSupervisorAndWait,
	captureProcessIdentity,
	type captureProcessIdentityWithRetry,
	type ProcessIdentity,
	type SignalVerifiedSupervisor,
	type SupervisorProcess,
	type spawnSupervisor,
} from "./process.ts";
import type { BackgroundWorkKind, BackgroundWorkOutcome } from "./runtime.ts";
import type { WorkRunStorage } from "./storage.ts";

export interface ShellActivityDependencies {
	readonly captureSupervisorIdentity: typeof captureProcessIdentityWithRetry;
	readonly cwd: string;
	readonly maxTimeoutSliceMs: number;
	readonly outputFactory: (path: string) => BoundedOutputFile;
	readonly shellPath: string | undefined;
	readonly signalSupervisor: SignalVerifiedSupervisor;
	readonly stopCompletionGraceMs: number;
	readonly storage: WorkRunStorage;
	readonly supervisorExecutable: string;
	readonly supervisorFactory: typeof spawnSupervisor;
}

export interface ShellLaunchInput {
	readonly backgrounded: boolean;
	readonly command: string;
	readonly context: ExtensionContext;
	readonly description?: string;
	readonly kind?: BackgroundWorkKind;
	readonly monitorFailureText?: string;
	readonly monitorSource?: "command";
	readonly monitorSuccessText?: string;
	readonly monitorTarget?: string;
	readonly monitorTimeoutSeconds?: number;
	readonly parentRunOrigin?: NonNullable<BackgroundWorkOutcome["parentRunOrigin"]>;
}

export interface ShellLaunchState {
	readonly acknowledgementPath: string;
	readonly authorizationPath: string;
	readonly authorizationToken: string;
	readonly id: string;
	readonly input: ShellLaunchInput;
	readonly output: BoundedOutputFile;
	readonly supervisor: SupervisorProcess;
	readonly supervisorIdentity: ProcessIdentity;
}

export async function prepareShellLaunch(
	input: ShellLaunchInput,
	id: string,
	dependencies: ShellActivityDependencies,
	disposed: () => boolean,
): Promise<ShellLaunchState> {
	if (disposed()) throw new Error("Background Work session is shutting down");
	const outputPath = dependencies.storage.outputPath(id);
	const authorizationPath = dependencies.storage.commandAuthorizationPath(id);
	const acknowledgementPath = `${authorizationPath}.ack`;
	const authorizationToken = randomBytes(24).toString("base64url");
	const output = dependencies.outputFactory(outputPath);
	let shell: ReturnType<typeof getShellConfig>;
	try {
		shell = getShellConfig(dependencies.shellPath);
	} catch (error) {
		discardOutput(output);
		throw error;
	}
	const processOwner = captureProcessIdentity(process.pid);
	if (!processOwner) {
		discardOutput(output);
		throw new Error("Cannot establish Pi process identity for Background Work");
	}
	const envelope = Buffer.from(
		JSON.stringify({
			commandTransport: shell.commandTransport ?? "argv",
			commandAcknowledgementPath: acknowledgementPath,
			commandAuthorizationPath: authorizationPath,
			commandAuthorizationToken: authorizationToken,
			cwd: dependencies.cwd,
			parentPid: processOwner.pid,
			parentStarted: processOwner.started,
			shell: shell.shell,
			shellArgs: shell.args,
		}),
		"utf-8",
	).toString("base64url");
	let supervisor: SupervisorProcess;
	try {
		supervisor = dependencies.supervisorFactory(dependencies.supervisorExecutable, envelope, {
			cwd: dependencies.cwd,
			env: sessionEnvironment(input.context),
		});
	} catch (error) {
		discardOutput(output);
		throw error;
	}
	let supervisorIdentity: ProcessIdentity | undefined;
	try {
		supervisorIdentity = await dependencies.captureSupervisorIdentity(supervisor.pid);
	} catch (error) {
		await abandonSupervisorAndWait(supervisor);
		discardOutput(output);
		throw error;
	}
	if (!supervisorIdentity || disposed()) {
		await abandonSupervisorAndWait(supervisor);
		discardOutput(output);
		if (disposed()) throw new Error("Background Work session is shutting down");
		throw new Error("Cannot establish Background Work supervisor identity");
	}
	return {
		acknowledgementPath,
		authorizationPath,
		authorizationToken,
		id,
		input,
		output,
		supervisor,
		supervisorIdentity,
	};
}

function sessionEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env["PI_SESSION_ID"];
	delete env["PI_SESSION_FILE"];
	delete env["PI_PROVIDER"];
	delete env["PI_MODEL"];
	delete env["PI_REASONING_LEVEL"];
	env["PI_SESSION_ID"] = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env["PI_SESSION_FILE"] = sessionFile;
	if (ctx.model) {
		env["PI_PROVIDER"] = ctx.model.provider;
		env["PI_MODEL"] = ctx.model.id;
	}
	if (ctx.thinkingLevel) env["PI_REASONING_LEVEL"] = ctx.thinkingLevel;
	return env;
}

function discardOutput(output: BoundedOutputFile): void {
	output.remove();
}
