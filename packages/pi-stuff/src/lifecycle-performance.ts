import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "./shared/runtime-type.ts";

const LIFECYCLE_TRACE_KEY = "@jczhang02/pi-stuff/lifecycle-performance";

interface LifecycleTraceState {
	readonly origin: number;
	readonly events: Array<{ readonly atMs: number; readonly label: string }>;
}

function isLifecycleEvent<Value>(value: Value): value is Value & LifecycleTraceState["events"][number] {
	return (
		isRuntimeObject(value) &&
		value !== null &&
		"atMs" in value &&
		isRuntimeNumber(value.atMs) &&
		"label" in value &&
		isRuntimeString(value.label)
	);
}

function traceState(): LifecycleTraceState | undefined {
	const value = Object.getOwnPropertyDescriptor(globalThis, Symbol.for(LIFECYCLE_TRACE_KEY))?.value;
	if (
		!isRuntimeObject(value) ||
		value === null ||
		!("origin" in value) ||
		!isRuntimeNumber(value.origin) ||
		!("events" in value) ||
		!Array.isArray(value.events) ||
		!value.events.every(isLifecycleEvent)
	) {
		return undefined;
	}
	return { events: value.events, origin: value.origin };
}

/** Inert unless the explicit lifecycle benchmark installs an in-process observer. */
export function markLifecyclePhase(label: string): void {
	const state = traceState();
	if (!state) return;
	state.events.push({ atMs: Number((performance.now() - state.origin).toFixed(3)), label });
}
