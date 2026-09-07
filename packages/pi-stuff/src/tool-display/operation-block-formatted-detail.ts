import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PlannedToolActivityMember, ToolArguments } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import type { ToolFormattedSection } from "./contract.ts";
import { operationBlockModel } from "./operation-block-presentation.ts";
import type { OperationEvidenceLine } from "./operation-block-renderer.ts";

function formattedEvidence(line: OperationEvidenceLine): string {
	if (line.kind === "source") return `${String(line.newLine ?? line.oldLine ?? "")} │ ${line.text}`;
	if (line.kind !== "diff") return line.text;
	const oldLine = String(line.oldLine ?? "");
	const newLine = String(line.newLine ?? "");
	const marker = line.diffKind === "add" ? "+" : line.diffKind === "delete" ? "-" : " ";
	return `${oldLine} ${newLine} │ ${marker} ${line.text}`;
}

function issueSectionTitle(state: Exclude<ToolActivityState, "running" | "success">): string {
	return state === "error" ? "Error" : state === "rejected" ? "Rejection" : "Cancellation";
}

function evidenceSection(
	title: string,
	evidence: readonly OperationEvidenceLine[],
	languagePath?: string,
): ToolFormattedSection {
	const section: ToolFormattedSection = {
		lines: evidence.map(formattedEvidence),
		operationEvidence: evidence,
		title,
	};
	return languagePath ? { ...section, languagePath } : section;
}

export function operationDetailSections(
	name: string,
	args: ToolArguments,
	result: AgentToolResult<unknown>,
	state: Exclude<ToolActivityState, "running">,
): readonly ToolFormattedSection[] | undefined {
	const member: PlannedToolActivityMember = { args, id: "formatted-detail", name, result };
	const model = operationBlockModel(member, result, state, true);
	if (!model) return undefined;
	if (state !== "success" && model.evidence.length === 1) {
		return [{ lines: model.evidence.map(formattedEvidence), title: issueSectionTitle(state) }];
	}
	const first = model.evidence[0];
	const remainder = model.evidence.slice(1);
	const issue = state === "success" ? undefined : remainder.at(-1);
	const evidence = issue ? remainder.slice(0, -1) : remainder;
	const issueSection =
		state !== "success" && issue ? [{ lines: [formattedEvidence(issue)], title: issueSectionTitle(state) }] : [];
	if (name === "write") {
		return [
			{ lines: first ? [formattedEvidence(first)] : [], title: "Change" },
			evidenceSection("Content", evidence, model.languagePath),
			...issueSection,
		];
	}
	if (name === "edit") {
		return [
			{ lines: first ? [formattedEvidence(first)] : [], title: "Change" },
			evidenceSection("Diff", evidence, model.languagePath),
			...issueSection,
		];
	}
	if (name === "apply_patch") {
		const files = evidence.filter((line) => line.kind === "meta" && /^[MADR] /u.test(line.text));
		const diff = evidence.filter((line) => !files.includes(line));
		if (first && /diff evidence unavailable/iu.test(first.text)) diff.unshift(first);
		else if (first) files.unshift(first);
		return [
			{ lines: files.map(formattedEvidence), title: "Files" },
			evidenceSection("Diff", diff, model.languagePath),
			...issueSection,
		];
	}
	return [
		{ lines: first ? [formattedEvidence(first)] : [], title: "Background" },
		{ lines: evidence.map(formattedEvidence), title: "Output" },
		...issueSection,
	];
}
