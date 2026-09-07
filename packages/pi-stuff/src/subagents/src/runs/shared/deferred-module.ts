import { setTimeout } from "node:timers/promises";

/** Share first-use timer turns around necessary loading; warm calls add no timer. */
export function deferredModule<Module>(load: () => Promise<Module>): () => Promise<Module> {
	let pending: Promise<Module> | undefined;
	return () => {
		pending ??= (async () => {
			await setTimeout(0);
			const module = await load();
			await setTimeout(0);
			return module;
		})().catch((error) => {
			pending = undefined;
			throw error;
		});
		return pending;
	};
}
