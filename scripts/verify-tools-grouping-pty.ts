import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.ts";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/tools-grouping-pty-provider.ts");
const runner = join(root, "tests/fixtures/tools-grouping-pty-runner.sh");
const GENERIC_FIT_TARGET = "https://example.test/a-very-long-resource-identifier-without-boundaries-that-keeps-going";
const SESSION_RECORD_SCHEMA = Type.Object(
	{
		message: Type.Optional(Type.Object({ role: Type.Optional(Type.String()) }, { additionalProperties: true })),
	},
	{ additionalProperties: true },
);

function fail(message: string): never {
	throw new Error(`Tool grouping PTY verification failed: ${message}`);
}

function command(
	args: readonly string[],
	options: {
		readonly env?: Record<string, string>;
		readonly cwd?: string;
	} = {},
) {
	const spawnOptions = { stderr: "pipe" as const, stdout: "pipe" as const };
	if (options.cwd) Object.assign(spawnOptions, { cwd: options.cwd });
	if (options.env) Object.assign(spawnOptions, { env: { ...process.env, ...options.env } });
	const result = Bun.spawnSync([...args], spawnOptions);
	if (result.exitCode !== 0) {
		fail(`${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString();
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

type TmuxCommand = (args: readonly string[]) => string;
type GroupingScenario = "basic" | "compaction" | "lifecycle" | "resume" | "tree";
type GroupingLaunch = (extraEnvironment?: Readonly<Record<string, string>>) => string;

interface ToolsGroupingPtyOptions {
	readonly columns: number;
	readonly packagePath: string;
	readonly piBinary: string;
	readonly rows: number;
	readonly scenario?: GroupingScenario;
}

function capture(tmux: TmuxCommand, session: string): string {
	return tmux(["capture-pane", "-p", "-t", session]);
}

function captureHistory(tmux: TmuxCommand, session: string): string {
	return tmux(["capture-pane", "-p", "-S", "-", "-t", session]);
}

function captureAnsiHistory(tmux: TmuxCommand, session: string): string {
	return tmux(["capture-pane", "-p", "-e", "-S", "-", "-t", session]);
}

function markerColor(frame: string, summary: string): string {
	const line = frame
		.split("\n")
		.reverse()
		.find((candidate) => Bun.stripANSI(candidate).includes(summary) && candidate.includes("•"));
	if (!line) fail(`could not find colored Activity marker for ${summary}\n${frame}`);
	const marker = line.indexOf("•");
	const colors = line.slice(0, marker).match(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;:]*m`, "gu")) ?? [];
	const color = colors.reverse().find((code) => {
		const parameter = Number.parseInt(code.slice(2), 10);
		return parameter === 38 || (parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97);
	});
	if (!color) fail(`Activity marker for ${summary} had no terminal color\n${line}`);
	return color;
}

async function waitForText(tmux: TmuxCommand, session: string, expected: string, timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let frame = "";
	while (Date.now() < deadline) {
		frame = capture(tmux, session);
		if (frame.includes(expected)) return frame;
		await Bun.sleep(50);
	}
	fail(`timed out waiting for ${expected}\nCurrent frame:\n${frame}`);
}

function send(tmux: TmuxCommand, session: string, text: string): void {
	tmux(["send-keys", "-t", session, "-l", "--", text]);
	tmux(["send-keys", "-t", session, "Enter"]);
}

async function detachForegroundBash(tmux: TmuxCommand, session: string): Promise<void> {
	// The lifecycle row can paint just before Pi installs the running-tool key
	// handler. Retry the raw Ctrl+B only until the row reports detached; unlike
	// tmux's symbolic C-b form, -H bypasses the client's prefix binding.
	await Bun.sleep(250);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		tmux(["send-keys", "-t", session, "-H", "02"]);
		await Bun.sleep(250);
		const frame = capture(tmux, session);
		if (frame.includes("Command manually moved to background task") || frame.includes("GROUP_BACKGROUND_DONE"))
			return;
	}
	fail(`Ctrl+B did not detach foreground Bash\nCurrent frame:\n${capture(tmux, session)}`);
}

async function sendTurn(tmux: TmuxCommand, session: string, text: string): Promise<void> {
	send(tmux, session, text);
	// The completion marker is painted just before Pi returns focus to the
	// editor. A second harmless Enter makes the fixture deterministic when the
	// first lands in that narrow handoff window.
	await Bun.sleep(150);
	tmux(["send-keys", "-t", session, "Enter"]);
}

function normalized(frame: string): string {
	return frame.replace(/\s+/gu, " ");
}

function requireGroup(frame: string): void {
	const summaries = ["Read 1 file", "Searched 1 pattern", "Listed 1 directory"];
	const compact = normalized(frame);
	for (const summary of summaries) {
		if (!compact.includes(summary)) fail(`settled Retrieval Group omitted ${summary}\n${frame}`);
		if (compact.split(summary).length - 1 !== 1) {
			fail(`settled Retrieval Group rendered ${summary} more than once\n${frame}`);
		}
	}
	if (!frame.includes("• Bash(pwd)") || !frame.includes("⎿ ")) fail(`standalone Bash operation was lost\n${frame}`);
	if (compact.includes("ran 1 command") || compact.includes("Ran 1 command")) {
		fail(`Bash leaked back into an aggregate command count\n${frame}`);
	}
	if (!compact.includes("ctrl+o to expand")) fail(`Retrieval Group omitted its disclosure hint\n${frame}`);
}

function requireCombinedGroup(frame: string): void {
	const compact = normalized(frame);
	const summary = "Searched 1 pattern, read 1 file, listed 1 directory";
	if (!compact.includes(summary)) fail(`continuous native retrieval did not form one Retrieval Group\n${frame}`);
	if (!frame.includes("• Bash(pwd)")) fail(`standalone Bash operation was lost\n${frame}`);
	if (!compact.includes("ctrl+o to expand")) fail(`Retrieval Group omitted its disclosure hint\n${frame}`);
}

function successGroup(frame: string): void {
	const groupEnd = frame.indexOf("GROUP_SUCCESS_DONE");
	const initialFrame = groupEnd < 0 ? frame : frame.slice(0, groupEnd + "GROUP_SUCCESS_DONE".length);
	requireGroup(initialFrame);
	for (const required of [
		"THINKING_STEP_1",
		"THINKING_STEP_2",
		"THINKING_STEP_3",
		"THINKING_STEP_4",
		"THINKING_STEP_5",
	]) {
		if (!initialFrame.includes(required))
			fail(`visible Thinking was lost while grouping: ${required}\n${initialFrame}`);
	}
	for (const forbidden of ["• Read input-工具.txt", "• Find *.txt", "• List .", "• Bash pwd"]) {
		if (initialFrame.includes(forbidden)) fail(`compact frame retained individual row ${forbidden}\n${initialFrame}`);
	}
}

function backgroundBarrier(frame: string): void {
	if (!normalized(frame).includes("Read 1 file")) {
		fail(`neighboring reads were not retained around standalone Bash operations\n${frame}`);
	}
	for (const required of ["Bash(sleep 30)", "Bash(sleep 31)"]) {
		if (!frame.includes(required)) fail(`background Bash operation omitted ${required}\n${frame}`);
	}
	for (const forbidden of ["Launched 2 background tasks", "• Read input-工具.txt"]) {
		if (frame.includes(forbidden)) fail(`background activity leaked raw member ${forbidden}\n${frame}`);
	}
}

function requireRetrievalIssue(frame: string): void {
	const lines = frame.split("\n");
	const summaryIndex = lines.findIndex((line) => line.includes("1 failed") && line.includes("Read"));
	if (summaryIndex < 0) fail(`native retrieval issue omitted its state count\n${frame}`);
	if (!lines[summaryIndex + 1]?.includes("⎿")) {
		fail(`native retrieval issue omitted its one child reason row\n${frame}`);
	}
}

async function verifyRetrievalLifecycle(tmux: TmuxCommand, session: string, columns: number): Promise<void> {
	await sendTurn(tmux, session, "slow-retrieval");
	await waitForText(tmux, session, "Reading 1 file", 4_000);
	const targeted = await waitForText(tmux, session, "slow-target.txt", 2_500);
	const targetLine = targeted.split("\n").find((line) => line.includes("Reading 1 file"));
	if (!targetLine?.includes("slow-target.txt") || targetLine.includes("ctrl+o to expand")) {
		fail(`active Retrieval Group lost its stabilized inline target or retained an expansion hint\n${targeted}`);
	}
	const timed = await waitForText(tmux, session, " · 2s", 2_500);
	const timedLine = timed.split("\n").find((line) => line.includes("Reading 1 file"));
	if (!timedLine?.includes(" · 2s")) fail(`active Retrieval Group omitted enabled inline elapsed time\n${timed}`);
	await waitForText(tmux, session, "GROUP_SLOW_RETRIEVAL_DONE", 5_000);

	await sendTurn(tmux, session, "retrieval-issue");
	requireRetrievalIssue(await waitForText(tmux, session, "GROUP_RETRIEVAL_ISSUE_DONE"));

	await sendTurn(tmux, session, "fit-target");
	const fitted = await waitForText(tmux, session, "GROUP_FIT_TARGET_DONE");
	const identity = " • Retry ";
	const outcome = " · retry failed";
	const line = fitted
		.split("\n")
		.map((candidate) => candidate.trimEnd())
		.find((candidate) => candidate.startsWith(identity) && candidate.endsWith(outcome));
	if (!line) fail(`generic Tool target lost its identity or outcome\n${fitted}`);
	const target = line.slice(identity.length, -outcome.length);
	if (!target.endsWith("…") || !GENERIC_FIT_TARGET.startsWith(target.slice(0, -1))) {
		fail(`generic Tool target was not truncated from its source\n${fitted}`);
	}
	if (visibleWidth(line) !== columns) {
		fail(`generic Tool target left usable cells in ${String(columns)} columns\n${fitted}`);
	}
}

async function verifyLifecyclePresentation(tmux: TmuxCommand, session: string): Promise<void> {
	send(tmux, session, "partial-bash");
	await waitForText(tmux, session, "PARTIAL_BASH_VISIBLE", 6_000);
	tmux(["send-keys", "-t", session, "Escape"]);
	await waitForText(tmux, session, "Interrupted", 10_000);
	const compactCancellation = capture(tmux, session);
	if (
		!compactCancellation.includes("PARTIAL_BASH_VISIBLE") ||
		(compactCancellation.match(/Interrupted/gu) ?? []).length !== 1
	) {
		fail(`compact direct Bash cancellation lost its single partial-output authority\n${compactCancellation}`);
	}
	tmux(["send-keys", "-t", session, "C-o"]);
	await waitForText(tmux, session, "Tool output: expanded");
	const expandedCancellation = capture(tmux, session);
	if (
		!expandedCancellation.includes("PARTIAL_BASH_VISIBLE") ||
		(expandedCancellation.match(/Interrupted/gu) ?? []).length !== 1
	) {
		fail(`expanded direct Bash cancellation lost its single partial-output authority\n${expandedCancellation}`);
	}
	tmux(["send-keys", "-t", session, "C-o"]);
	await waitForText(tmux, session, "Tool output: collapsed");

	await sendTurn(tmux, session, "exit-128");
	const exit128 = await waitForText(tmux, session, "GROUP_EXIT_128_DONE");
	const exit128Lines = exit128.split("\n");
	const exit128Index = exit128Lines.findIndex((line) => line.includes("Bash(exit 128)"));
	const exit128Block = exit128Index < 0 ? "" : exit128Lines.slice(exit128Index, exit128Index + 3).join("\n");
	if (!exit128Block.includes("Error: Exit code 128") || exit128Block.includes("Interrupted")) {
		fail(`direct Bash exit 128 was not retained as an error\n${exit128}`);
	}

	await sendTurn(tmux, session, "plain");
	await waitForText(tmux, session, "PLAIN_DONE", 2_000);

	await sendTurn(tmux, session, "structured");
	const structured = await waitForText(tmux, session, "STRUCTURED_CODE_LINE");
	const structuredLines = structured.split("\n");
	const headingLine = structuredLines.find((line) => line.includes("Structured result"));
	if (!headingLine || !/^\s*•\s/u.test(headingLine)) {
		fail(`structured Assistant message omitted its outer transcript bullet\n${structured}`);
	}
	for (const required of [
		"STRUCTURED_PARAGRAPH 中文",
		"STRUCTURED_ITEM_ONE",
		"STRUCTURED_ITEM_TWO",
		"STRUCTURED_CODE_LINE",
	]) {
		if (!structured.includes(required)) fail(`structured Assistant Markdown lost ${required}\n${structured}`);
	}
	if (structuredLines.filter((line) => /^ •\s/u.test(line) && line.includes("Structured result")).length !== 1) {
		fail(`structured Assistant message rendered more than one outer transcript bullet\n${structured}`);
	}

	await sendTurn(tmux, session, "bashui");
	const bashUi = await waitForText(tmux, session, "GROUP_BASH_UI_DONE");
	const bashUiText = normalized(bashUi);
	for (const required of [
		"Bash(printf 'BASH_UI_ONE\\nBASH_UI_TWO",
		"⎿ BASH_UI_ONE",
		"BASH_UI_THREE",
		"… +3 lines (ctrl+o to expand)",
		"Bash(printf BASH_UI_SECOND && printf '_DONE\\n')",
		"⎿ BASH_UI_SECOND_DONE",
	]) {
		if (!bashUiText.includes(required)) fail(`Claude-style Bash UI omitted ${required}\n${bashUi}`);
	}
	if (bashUiText.includes("Ran 2 commands")) fail(`multiple Bash calls collapsed into one aggregate\n${bashUi}`);

	tmux(["send-keys", "-t", session, "C-o"]);
	await waitForText(tmux, session, "Tool output: expanded");
	const expanded = captureHistory(tmux, session);
	for (const required of ["input-工具.txt", "*.txt", "Bash(pwd)", "Task create"]) {
		if (!expanded.includes(required)) fail(`Ctrl+O did not restore ${required}\n${expanded}`);
	}
	if (/^\s*(?:Call|Result|Details|Arguments)\s*$/mu.test(expanded)) {
		fail(`Ctrl+O exposed raw protocol headings\n${expanded}`);
	}
	tmux(["send-keys", "-t", session, "C-o"]);
	await waitForText(tmux, session, "Tool output: collapsed");
	const collapsedHistory = captureHistory(tmux, session);
	successGroup(collapsedHistory);
	for (const required of ["Bash(printf 'BASH_UI_ONE", "Bash(printf BASH_UI_SECOND"]) {
		if (!collapsedHistory.includes(required)) fail(`Ctrl+O collapse lost ${required}\n${collapsedHistory}`);
	}

	send(tmux, session, "/tools");
	const tools = await waitForText(tmux, session, "activities");
	for (const required of ["Tools", "Tools / Bash · done", "BASH_UI_SECOND_DONE", "Esc close", "┃"]) {
		if (!tools.includes(required)) fail(`/tools lost grouped member ${required}\n${tools}`);
	}
	tmux(["send-keys", "-t", session, "Enter"]);
	await Bun.sleep(100);
	const details = capture(tmux, session);
	for (const required of ["Tools / Bash · done", "Output", "BASH_UI_SECOND_DONE"]) {
		if (!details.includes(required)) fail(`/tools group details lost member ${required}\n${details}`);
	}
	tmux(["send-keys", "-t", session, "Escape"]);
	await Bun.sleep(100);
	tmux(["send-keys", "-t", session, "Escape"]);
	await Bun.sleep(100);

	send(tmux, session, "/reload");
	await waitForText(tmux, session, "Reloaded keybindings, extensions");
	const reloadedHistory = captureHistory(tmux, session);
	successGroup(reloadedHistory);
	for (const required of ["Bash(printf 'BASH_UI_ONE", "Bash(printf BASH_UI_SECOND"]) {
		if (!reloadedHistory.includes(required)) fail(`/reload lost ${required}\n${reloadedHistory}`);
	}
}

async function verifyLifecycleOutcomes(
	tmux: TmuxCommand,
	session: string,
	temporaryDirectory: string,
	successfulMarkerColor: string,
): Promise<void> {
	await sendTurn(tmux, session, "failure");
	const failure = await waitForText(tmux, session, "GROUP_FAILURE_DONE");
	if (!normalized(failure).includes("Read 1 file") || !failure.includes("Bash(printf FIXTURE_GROUP_ERROR")) {
		fail(`standalone failure or neighboring read group was hidden\n${failure}`);
	}
	if (!failure.includes("⎿  Error: Exit code 17")) {
		fail(`Bash failure did not retain its explicit child outcome\n${failure}`);
	}
	if (failure.includes("• Read input-工具.txt")) fail(`failure group leaked successful member rows\n${failure}`);
	const unresolvedMarkerColor = markerColor(captureAnsiHistory(tmux, session), "Bash(printf FIXTURE_GROUP_ERROR");
	if (unresolvedMarkerColor === successfulMarkerColor) fail("failed Bash operation retained the success color");
	await sendTurn(tmux, session, "retry-history");
	const retryHistory = await waitForText(tmux, session, "GROUP_RETRY_HISTORY_DONE");
	const retryHistoryText = normalized(retryHistory);
	for (const required of ["Retry same exact retry · retry failed", "Retry same exact retry · retry succeeded"]) {
		if (!retryHistoryText.includes(required)) fail(`standalone retry omitted ${required}\n${retryHistory}`);
	}
	const retryHistoryAnsi = captureAnsiHistory(tmux, session);
	const failedRetryColor = markerColor(retryHistoryAnsi, "Retry same exact retry · retry failed");
	if (failedRetryColor === successfulMarkerColor) fail("failed retry retained the success color");
	const successfulRetryColor = markerColor(retryHistoryAnsi, "Retry same exact retry · retry succeeded");
	if (successfulRetryColor !== successfulMarkerColor) {
		fail(
			`successful retry did not use the success color: expected ${JSON.stringify(successfulMarkerColor)}, received ${JSON.stringify(successfulRetryColor)}`,
		);
	}
	await sendTurn(tmux, session, "mutation");
	const mutation = await waitForText(tmux, session, "GROUP_MUTATION_DONE");
	if (!normalized(mutation).includes("Read 1 file") || !mutation.includes("Bash(printf mutation >")) {
		fail(`consequential standalone Bash and neighboring reads were not rendered\n${mutation}`);
	}
	if ((await readFile(join(temporaryDirectory, "bash-mutation-工具.txt"), "utf8")) !== "mutation") {
		fail("consequential Bash did not preserve its filesystem effect");
	}

	send(tmux, session, "permission");
	await waitForText(tmux, session, "Fixture permission");
	const permission = captureHistory(tmux, session);
	if (!normalized(permission).includes("Permission Waiting for permission… · working")) {
		fail(`permission UI hid the active standalone Tool\n${permission}`);
	}
	if (!permission.includes("Waiting for permission"))
		fail(`permission Tool omitted its bounded wait hint\n${permission}`);
	tmux(["send-keys", "-t", session, "Enter"]);
	const permissionDone = await waitForText(tmux, session, "GROUP_PERMISSION_DONE");
	if (!normalized(permissionDone).includes("Permission Waiting for permission… · permission allowed")) {
		fail(`permission Tool did not settle semantically\n${permissionDone}`);
	}
	if (permissionDone.includes("fixture_confirm"))
		fail(`permission Tool leaked raw protocol chrome\n${permissionDone}`);

	send(tmux, session, "rejection");
	await waitForText(tmux, session, "Fixture rejection");
	tmux(["send-keys", "-t", session, "Escape"]);
	const rejection = await waitForText(tmux, session, "GROUP_REJECTION_DONE");
	const rejectionSummary = "Permission Waiting for permission… · permission rejected";
	if (!normalized(rejection).includes(rejectionSummary)) {
		fail(`permission rejection was not disclosed by the standalone Tool\n${rejection}`);
	}
	if (!rejection.includes("rejected")) fail(`permission rejection omitted its issue line\n${rejection}`);
	const warningMarkerColor = markerColor(captureAnsiHistory(tmux, session), rejectionSummary);
	if (warningMarkerColor === successfulMarkerColor || warningMarkerColor === unresolvedMarkerColor) {
		fail("rejected standalone Tool did not use its warning color");
	}

	await sendTurn(tmux, session, "cancellation");
	const cancellation = await waitForText(tmux, session, "GROUP_CANCELLATION_DONE");
	const cancellationSummary = "Cancel Cancelling operation · Operation aborted";
	if (!normalized(cancellation).includes(cancellationSummary)) {
		fail(`cancelled activity was not disclosed by the standalone Tool\n${cancellation}`);
	}
	if (!cancellation.includes("Operation aborted")) {
		fail(`cancelled activity omitted its issue line\n${cancellation}`);
	}
	if (markerColor(captureAnsiHistory(tmux, session), cancellationSummary) !== warningMarkerColor) {
		fail("cancelled standalone Tool did not retain warning color");
	}
}

async function verifyLifecycleRichResults(
	tmux: TmuxCommand,
	session: string,
	temporaryDirectory: string,
): Promise<void> {
	await sendTurn(tmux, session, "media");
	const media = await waitForText(tmux, session, "GROUP_MEDIA_DONE");
	if (!normalized(media).includes("Media Visible image · media loaded")) {
		fail(`standalone media Tool lost its formatted row\n${media}`);
	}
	const mediaLines = media.split("\n");
	const activityLine = mediaLines.find((line) => line.includes("Media Visible image"));
	const previewLine = mediaLines.find((line) => line.includes("Image preview unavailable · PNG · 1×1"));
	if (!previewLine) fail(`media body disappeared with standalone Tool chrome\n${media}`);
	if (!activityLine || activityLine.indexOf("Media") !== previewLine.indexOf("Image")) {
		fail(`media fallback did not align with the Tool body column\n${media}`);
	}
	if (media.includes("fixture_media")) fail(`media Tool leaked raw protocol chrome\n${media}`);

	await sendTurn(tmux, session, "agent");
	const agent = await waitForText(tmux, session, "GROUP_AGENT_DONE");
	if (!normalized(agent).includes("Agent status · checked")) {
		fail(`standalone Agent Tool lost its formatted row\n${agent}`);
	}
	if (agent.includes("Subagent") || agent.includes("action: status")) {
		fail(`Agent Tool leaked raw protocol chrome\n${agent}`);
	}

	await sendTurn(tmux, session, "completion");
	const completionLaunch = await waitForText(tmux, session, "GROUP_COMPLETION_DONE");
	if (!completionLaunch.includes("Bash(sleep 0.4; printf FIXTURE_BACKGROUND_COMPLETED")) {
		fail(`background Bash launch did not retain its operation block\n${completionLaunch}`);
	}
	const completion = await waitForText(tmux, session, 'Background command "completion fixture" completed');
	const taskRoot = join(temporaryDirectory, ".pi", "tasks");
	const outputFiles = (await readdir(taskRoot, { recursive: true })).filter((entry) => entry.endsWith(".output"));
	const outputs = await Promise.all(outputFiles.map((entry) => readFile(join(taskRoot, entry), "utf8")));
	if (!outputs.some((output) => output.includes("FIXTURE_BACKGROUND_COMPLETED"))) {
		fail(`background completion lost its output\n${completion}`);
	}
	if (!captureHistory(tmux, session).includes("Bash(sleep 0.4; printf FIXTURE_BACKGROUND_COMPLETED")) {
		fail(`background completion removed its historical Bash operation block\n${completion}`);
	}
}

async function verifyCompactionScenario(tmux: TmuxCommand, session: string): Promise<void> {
	await Bun.sleep(250);
	await sendTurn(tmux, session, "postcompact");
	await waitForText(tmux, session, "GROUP_POST_COMPACT_DONE");
	requireCombinedGroup(capture(tmux, session));
	await Bun.sleep(250);
	send(tmux, session, "/compact");
	await waitForText(tmux, session, "Compacted from");
	requireCombinedGroup(capture(tmux, session));
}

async function verifyTreeScenario(tmux: TmuxCommand, session: string, columns: number): Promise<void> {
	await Bun.sleep(250);
	await sendTurn(tmux, session, "plain");
	await waitForText(tmux, session, "PLAIN_DONE");
	await Bun.sleep(250);
	tmux(["send-keys", "-t", session, "C-y"]);
	await waitForText(tmux, session, "Session Tree");
	tmux(["send-keys", "-t", session, "C-t", "Up", "Up", "Enter"]);
	await waitForText(tmux, session, "Navigated to selected point");
	tmux(["resize-window", "-t", session, "-x", String(columns), "-y", "60"]);
	await Bun.sleep(100);
	const history = capture(tmux, session);
	const text = normalized(history);
	for (const required of [
		"Read 1 file",
		"Searched 1 pattern",
		"Listed 1 directory",
		"Bash(pwd)",
		"Certify Retrieval Groups",
	]) {
		if (!text.includes(required)) fail(`session_tree replay lost ${required}\n${history}`);
	}
}

async function verifyResumeScenario(
	tmux: TmuxCommand,
	session: string,
	launch: GroupingLaunch,
	options: ToolsGroupingPtyOptions,
	temporaryDirectory: string,
): Promise<void> {
	send(tmux, session, "background");
	await waitForText(tmux, session, "Bash(sleep 30)");
	await detachForegroundBash(tmux, session);
	backgroundBarrier(await waitForText(tmux, session, "GROUP_BACKGROUND_DONE"));
	tmux(["kill-session", "-t", session]);
	await Bun.sleep(250);
	tmux([
		"new-session",
		"-d",
		"-s",
		session,
		"-x",
		String(options.columns),
		"-y",
		String(options.rows),
		"-c",
		temporaryDirectory,
		launch({ PI_STUFF_TOOLS_GROUPING_RESUME: "1" }),
	]);
	await waitForText(tmux, session, "GROUP_BACKGROUND_DONE");
	const resumed = captureHistory(tmux, session);
	successGroup(resumed);
	backgroundBarrier(resumed);
}

async function verifyPersistedGrouping(sessionDirectory: string, scenario: GroupingScenario): Promise<void> {
	const sessions = (await readdir(sessionDirectory)).filter((entry) => entry.endsWith(".jsonl"));
	if (sessions.length !== 1 || !sessions[0]) fail("expected exactly one isolated session");
	const transcript = await readFile(join(sessionDirectory, sessions[0]), "utf8");
	const toolResults = transcript
		.trim()
		.split("\n")
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(SESSION_RECORD_SCHEMA, record)) fail("session contains a malformed record");
			return record;
		})
		.filter((entry) => entry.message?.role === "toolResult");
	const expectedResults =
		scenario === "lifecycle"
			? 28
			: scenario === "compaction"
				? 6
				: scenario === "resume"
					? 10
					: scenario === "basic"
						? 10
						: 5;
	if (toolResults.length !== expectedResults) {
		fail(
			`grouping changed model-visible results: expected ${String(expectedResults)}, found ${String(toolResults.length)}`,
		);
	}
	const requiredTranscriptText =
		scenario === "compaction"
			? ["input-工具.txt", "PADDING_DONE", "GROUP_POST_COMPACT_DONE"]
			: scenario === "resume"
				? ["input-工具.txt", "GROUP_SUCCESS_DONE", "GROUP_BACKGROUND_DONE"]
				: ["input-工具.txt", "GROUP_SUCCESS_DONE"];
	if (scenario === "lifecycle" && !transcript.includes("STRUCTURED_CODE_LINE")) {
		fail("persisted transcript lost the structured Assistant fixture");
	}
	for (const required of requiredTranscriptText) {
		if (!transcript.includes(required)) fail(`persisted transcript lost ${required}`);
	}
	for (const displayOnly of ["ctrl+o to expand", "Searched 1 pattern", "• Bash(pwd)"]) {
		if (transcript.includes(displayOnly))
			fail(`display-only grouping leaked into persisted session data: ${displayOnly}`);
	}
	if (scenario === "compaction" && !transcript.includes('"type":"compaction"')) {
		fail("real session did not persist the exercised compaction boundary");
	}
}

export async function verifyToolsGroupingPty(options: ToolsGroupingPtyOptions): Promise<void> {
	const scenario = options.scenario ?? "basic";
	const version = command([options.piBinary, "--version"]).trim();
	if (version !== CERTIFIED_PI_VERSION) fail(`expected Pi ${CERTIFIED_PI_VERSION}, received ${version}`);
	command(["tmux", "-V"]);
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-tools-grouping-"));
	const configDirectory = join(temporaryDirectory, "config");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const tmuxSession = `pi-stuff-tools-grouping-${String(process.pid)}-${String(Date.now())}`;
	const tmuxSocket = join(temporaryDirectory, "tmux.sock");
	const tmux: TmuxCommand = (args) => command(["tmux", "-S", tmuxSocket, ...args]);
	await Promise.all([mkdir(configDirectory), mkdir(sessionDirectory)]);
	await Promise.all([
		writeFile(
			join(configDirectory, "settings.json"),
			`${JSON.stringify({ branchSummary: { skipPrompt: true }, defaultProjectTrust: "always", outputPad: 1, quietStartup: true }, null, "\t")}\n`,
			{ mode: 0o600 },
		),
		writeFile(join(configDirectory, "keybindings.json"), '{"app.session.tree":["ctrl+y"]}\n', { mode: 0o600 }),
		writeFile(join(temporaryDirectory, "input-工具.txt"), "alpha\nbeta\n", {
			mode: 0o600,
		}),
		writeFile(join(temporaryDirectory, "slow-target.txt"), "SLOW_RETRIEVAL_DATA\n", { mode: 0o600 }),
	]);
	const environment = {
		// This display fixture exercises native Pi compaction; real Magic recovery has its own Host gate.
		MAGIC_CONTEXT_PI_SUBAGENT: "1",
		PI_CODING_AGENT_DIR: configDirectory,
		PI_STUFF_TOOLS_GROUPING_BIN: options.piBinary,
		PI_STUFF_TOOLS_GROUPING_COLUMNS: String(options.columns),
		PI_STUFF_TOOLS_GROUPING_PACKAGE: resolve(options.packagePath),
		PI_STUFF_TOOLS_GROUPING_PROVIDER_EXTENSION: providerExtension,
		PI_STUFF_TOOLS_GROUPING_PROMPT: scenario === "compaction" ? "padding" : "success",
		PI_STUFF_TOOLS_GROUPING_ROWS: String(options.rows),
		PI_STUFF_TOOLS_GROUPING_SESSIONS: sessionDirectory,
		PI_STUFF_TOOLS_GROUPING_SESSION_ID: `tools-grouping-${String(options.columns)}x${String(options.rows)}`,
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
	};
	const launch = (extraEnvironment: Readonly<Record<string, string>> = {}) =>
		[
			"env",
			...Object.entries({ ...environment, ...extraEnvironment }).map(
				([name, value]) => `${name}=${shellQuote(value)}`,
			),
			shellQuote(runner),
		].join(" ");
	let successfulMarkerColor = "";

	try {
		tmux(["-f", "/dev/null", "new-session", "-d", "-s", `${tmuxSession}-owner`]);
		tmux(["set-option", "-s", "extended-keys", "on"]);
		const serverOptions = tmux(["show-options", "-s"]);
		if (/^extended-keys-format\b/m.test(serverOptions)) {
			tmux(["set-option", "-s", "extended-keys-format", "csi-u"]);
		}
		tmux(["set-option", "-g", "remain-on-exit", "on"]);
		tmux([
			"new-session",
			"-d",
			"-s",
			tmuxSession,
			"-x",
			String(options.columns),
			"-y",
			String(options.rows),
			"-c",
			temporaryDirectory,
			launch(),
		]);
		const geometry = tmux(["display-message", "-p", "-t", tmuxSession, "#{pane_width}x#{pane_height}"]).trim();
		if (geometry !== `${String(options.columns)}x${String(options.rows)}`) fail(`unexpected geometry ${geometry}`);
		if (scenario === "compaction") await waitForText(tmux, tmuxSession, "PADDING_DONE");
		else {
			await waitForText(tmux, tmuxSession, "GROUP_SUCCESS_DONE", 30_000);
			successGroup(captureHistory(tmux, tmuxSession));
			if (scenario === "lifecycle") {
				successfulMarkerColor = markerColor(captureAnsiHistory(tmux, tmuxSession), "Listed 1 directory");
			}
		}

		if (scenario === "basic" || scenario === "lifecycle") {
			await verifyRetrievalLifecycle(tmux, tmuxSession, options.columns);
		}
		if (scenario === "lifecycle") {
			await verifyLifecyclePresentation(tmux, tmuxSession);
			await verifyLifecycleOutcomes(tmux, tmuxSession, temporaryDirectory, successfulMarkerColor);
			await verifyLifecycleRichResults(tmux, tmuxSession, temporaryDirectory);
		} else if (scenario === "compaction") {
			await verifyCompactionScenario(tmux, tmuxSession);
		} else if (scenario === "tree") {
			await verifyTreeScenario(tmux, tmuxSession, options.columns);
		} else if (scenario === "resume") {
			await verifyResumeScenario(tmux, tmuxSession, launch, options, temporaryDirectory);
		}

		await verifyPersistedGrouping(sessionDirectory, scenario);
	} finally {
		Bun.spawnSync(["tmux", "-S", tmuxSocket, "kill-server"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	const packagePath = join(root, "packages/pi-stuff");
	await verifyToolsGroupingPty({
		columns: 100,
		rows: 32,
		packagePath,
		piBinary: PI_BIN,
		scenario: "lifecycle",
	});
	await verifyToolsGroupingPty({
		columns: 100,
		rows: 32,
		packagePath,
		piBinary: PI_BIN,
		scenario: "compaction",
	});
	await verifyToolsGroupingPty({
		columns: 100,
		rows: 32,
		packagePath,
		piBinary: PI_BIN,
		scenario: "resume",
	});
	await verifyToolsGroupingPty({
		columns: 100,
		rows: 32,
		packagePath,
		piBinary: PI_BIN,
		scenario: "tree",
	});
	await verifyToolsGroupingPty({
		columns: 64,
		rows: 28,
		packagePath,
		piBinary: PI_BIN,
	});
	console.log("Certified native Retrieval Groups in 100x32 and 64x28 PTYs");
}
