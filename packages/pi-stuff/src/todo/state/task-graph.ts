import type { Task } from "../tool/types.ts";

/** Return true when any task dependency path loops back to an active node. */
export function hasCycle(taskList: readonly Task[]): boolean {
	const edges = new Map<string, readonly string[]>();
	for (const task of taskList) {
		edges.set(task.id, task.blockedBy ?? []);
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();

	function visit(taskId: string): boolean {
		if (visiting.has(taskId)) return true;
		if (visited.has(taskId)) return false;

		visiting.add(taskId);
		for (const blockerId of edges.get(taskId) ?? []) {
			if (visit(blockerId)) return true;
		}
		visiting.delete(taskId);
		visited.add(taskId);
		return false;
	}

	for (const taskId of edges.keys()) {
		if (visit(taskId)) return true;
	}
	return false;
}

/**
 * Compatibility helper for callers that want to validate one prospective
 * blockedBy change without constructing the tentative task list themselves.
 */
export function detectCycle(taskList: readonly Task[], taskId: string, newBlockedBy: readonly string[]): boolean {
	const tasks = taskList.map((task) =>
		task.id === taskId ? { ...task, blockedBy: [...new Set([...(task.blockedBy ?? []), ...newBlockedBy])] } : task,
	);
	return hasCycle(tasks);
}

/** Build the inverse dependency map: blocker id -> task ids it blocks. */
export function deriveBlocks(taskList: readonly Task[]): Map<string, string[]> {
	const blocks = new Map<string, string[]>();
	for (const task of taskList) {
		for (const blockerId of task.blockedBy ?? []) {
			const blockedTaskIds = blocks.get(blockerId) ?? [];
			blockedTaskIds.push(task.id);
			blocks.set(blockerId, blockedTaskIds);
		}
	}
	return blocks;
}
