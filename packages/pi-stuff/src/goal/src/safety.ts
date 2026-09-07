import { createHash } from "node:crypto";
import { isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import type { ActiveGoal, GoalBlockerAudit } from "./persistence.ts";

interface GoalTranscriptRecord {
	readonly content?: unknown;
	readonly role?: unknown;
	readonly text?: unknown;
	readonly type?: unknown;
}

export interface GoalCompletionEvidence {
	requirement: string;
	proof: string;
}

const MIN_COMPLETION_SUMMARY_LENGTH = 20;
const MIN_COMPLETION_EVIDENCE_LENGTH = 24;
const MIN_BLOCKER_REASON_LENGTH = 12;
const MIN_BLOCKER_ATTEMPT_LENGTH = 16;
const MIN_BLOCKER_EVIDENCE_LENGTH = 24;
const CONCRETE_EVIDENCE_RE =
	/(?:\b(?:test|check|build|lint|typecheck|command|file|line|output|response|status|exit|hash|url|request|query|inspection|observed|confirmed|verified|passed|failed|denied|unavailable|returned|wrote|read)\b|(?:^|\s)(?:\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)(?:\s|$)|[`“”「」『』][^`“”「」『』]{1,200}[`“”「」『』]|\b[A-Za-z][A-Za-z0-9]*[_./:=+-][A-Za-z0-9_./:=+-]+\b|(?:测试|检查|构建|命令|文件|行号|输出|响应|状态|退出码|哈希|网址|请求|查询|读取|写入|观察|确认|验证|通过|失败|拒绝|不可用|返回|结果|内容))/iu;
const BLOCKER_ATTEMPT_RE = /\b(?:attempted|tried|checked|queried|requested|contacted|inspected|ran|tested|used)\b/iu;
const BLOCKER_RESULT_RE =
	/\b(?:returned|responded|failed|denied|unavailable|missing|not configured|not found|exit|status|error|rejected|refused|timed out)\b/iu;

export interface ToolFreeRepeatState {
	toolFreeRepeatCount: number;
	lastToolFreeOutputFingerprint?: string | undefined;
}

export function queueGoalSafetyReset(goal: ActiveGoal): ActiveGoal {
	return { ...goal, safetyResetPending: true };
}

export function resetGoalSafetyEpoch(goal: ActiveGoal): ActiveGoal {
	return {
		...goal,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
		lastToolFreeOutputFingerprint: undefined,
		blockerAudit: undefined,
		safetyPauseCause: undefined,
		safetyResetPending: undefined,
	};
}

export function recordGoalBlockerAttempt(
	goal: ActiveGoal,
	reason: string,
	attemptedAction: string,
	evidence: string,
): GoalBlockerAudit {
	const reasonFingerprint = createHash("sha256").update(normalizeBlockerReason(reason), "utf8").digest("hex");
	const attemptFingerprint = createHash("sha256")
		.update(normalizeBlockerAttempt(attemptedAction), "utf8")
		.digest("hex");
	const attempt = {
		iteration: goal.iteration,
		attempt: attemptedAction.trim(),
		attemptFingerprint,
		evidence: evidence.trim(),
	};
	const previous = goal.blockerAudit;
	if (previous?.reasonFingerprint === reasonFingerprint) {
		if (previous.lastIteration === goal.iteration) return previous;
		if (
			previous.lastIteration + 1 === goal.iteration &&
			!previous.attempts.some((candidate) => candidate.attemptFingerprint === attemptFingerprint)
		) {
			const attempts = [...previous.attempts, attempt].slice(-3);
			return {
				reasonFingerprint,
				lastIteration: goal.iteration,
				consecutiveTurns: attempts.length,
				attempts,
			};
		}
	}
	return { reasonFingerprint, lastIteration: goal.iteration, consecutiveTurns: 1, attempts: [attempt] };
}

export function completionEvidenceRejectionReason(
	summary: string,
	evidence: readonly GoalCompletionEvidence[],
): string | undefined {
	if (!isSubstantiveText(summary, MIN_COMPLETION_SUMMARY_LENGTH, 4)) {
		return "summary must substantively describe the completed result";
	}
	if (evidence.length === 0) return "requirement-by-requirement evidence is required";
	const requirements = new Set<string>();
	for (const [index, item] of evidence.entries()) {
		const requirement = normalizeAuditText(item.requirement);
		const proof = normalizeAuditText(item.proof);
		if (!isSubstantiveText(requirement, 8, 2)) {
			return `evidence ${index + 1} has no substantive requirement`;
		}
		if (!isSubstantiveText(proof, MIN_COMPLETION_EVIDENCE_LENGTH, 4) || !CONCRETE_EVIDENCE_RE.test(proof)) {
			return `evidence ${index + 1} has no concrete verification result; quote an observed result such as a command exit status, exact output, file path or value, test count, URL response, or hash`;
		}
		if (requirements.has(requirement)) return `evidence ${index + 1} repeats a requirement`;
		requirements.add(requirement);
	}
	return undefined;
}

export function blockerReportRejectionReason(
	goal: ActiveGoal,
	reason: string,
	attemptedAction: string,
	evidence: string,
): string | undefined {
	const normalizedReason = normalizeBlockerReason(reason);
	const normalizedAttempt = normalizeBlockerAttempt(attemptedAction);
	const normalizedEvidence = normalizeAuditText(evidence);
	if (!isSubstantiveText(normalizedReason, MIN_BLOCKER_REASON_LENGTH, 3)) {
		return "reason must identify a substantive external action needed to unblock the goal";
	}
	if (
		!isSubstantiveText(normalizedAttempt, MIN_BLOCKER_ATTEMPT_LENGTH, 3) ||
		!BLOCKER_ATTEMPT_RE.test(normalizedAttempt)
	) {
		return "attempt must describe the concrete action tried during this Goal turn";
	}
	if (
		!isSubstantiveText(normalizedEvidence, MIN_BLOCKER_EVIDENCE_LENGTH, 5) ||
		!BLOCKER_RESULT_RE.test(normalizedEvidence)
	) {
		return "evidence must describe the concrete observed failure from that attempt";
	}
	const attemptFingerprint = createHash("sha256").update(normalizedAttempt, "utf8").digest("hex");
	if (goal.blockerAudit?.attempts.some((attempt) => attempt.attemptFingerprint === attemptFingerprint)) {
		return "attempt repeats an earlier blocker action";
	}
	return undefined;
}

function normalizeBlockerReason(reason: string) {
	return normalizeAuditText(reason)
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function normalizeBlockerAttempt(value: string) {
	return normalizeAuditText(value)
		.replace(/^\s*(?:attempt|try|turn)\s*(?:number|no\.?|#)?\s*\d+\s*[:.)-]?\s*/iu, "")
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function normalizeAuditText(value: string) {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function isSubstantiveText(value: string, minimumLength: number, minimumWords: number) {
	if (value.length < minimumLength) return false;
	const words = value.match(/[\p{L}\p{N}][\p{L}\p{N}_./:-]*/gu) ?? [];
	if (new Set(words).size >= minimumWords) return true;
	const cjkCharacters = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];
	return cjkCharacters.length >= minimumWords * 2;
}

export function nextToolFreeRepeatState(
	current: ToolFreeRepeatState,
	messages: readonly unknown[],
	toolAttempted: boolean,
): ToolFreeRepeatState {
	if (toolAttempted) return { toolFreeRepeatCount: 0 };
	const fingerprint = fingerprintVisibleAssistantOutput(messages);
	return {
		toolFreeRepeatCount:
			fingerprint === current.lastToolFreeOutputFingerprint
				? Math.min(Number.MAX_SAFE_INTEGER, current.toolFreeRepeatCount + 1)
				: 1,
		lastToolFreeOutputFingerprint: fingerprint,
	};
}

export function hasAssistantToolCall(messages: readonly unknown[]) {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		if (message.content.some((block) => isRecord(block) && block.type === "toolCall")) return true;
	}
	return false;
}

export function fingerprintVisibleAssistantOutput(messages: readonly unknown[]) {
	const normalized = normalizeVisibleAssistantOutput(messages);
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function normalizeVisibleAssistantOutput(messages: readonly unknown[]) {
	const text: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "text" || !isRuntimeString(block.text)) continue;
			text.push(block.text);
		}
	}
	const normalized = text
		.join("\n")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	return normalized === "" || /^[\p{P}\s]+$/u.test(normalized) ? "" : normalized;
}

function isRecord<Value>(value: Value): value is Value & GoalTranscriptRecord {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}
