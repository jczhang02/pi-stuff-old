import { isRuntimeNumber, isRuntimeObject } from "../../../../shared/runtime-type.ts";
import type { AsyncParallelGroupStatus } from "../../shared/types.ts";

function isValidParallelGroup<Value>(group: Value, stepCount: number): group is Value & AsyncParallelGroupStatus {
	if (
		!isRuntimeObject(group) ||
		group === null ||
		!("start" in group) ||
		!("count" in group) ||
		!("stepIndex" in group)
	) {
		return false;
	}
	const { start, count, stepIndex } = group;
	return (
		isRuntimeNumber(start) &&
		isRuntimeNumber(count) &&
		isRuntimeNumber(stepIndex) &&
		Number.isInteger(start) &&
		Number.isInteger(count) &&
		Number.isInteger(stepIndex) &&
		start >= 0 &&
		count > 0 &&
		stepIndex >= 0 &&
		stepIndex < stepCount &&
		start + count <= stepCount
	);
}

export function normalizeParallelGroups<Value>(groups: Value, stepCount: number): AsyncParallelGroupStatus[] {
	if (!Array.isArray(groups)) return [];
	return groups
		.filter((group): group is AsyncParallelGroupStatus => isValidParallelGroup(group, stepCount))
		.sort((left, right) => left.stepIndex - right.stepIndex || left.start - right.start);
}
