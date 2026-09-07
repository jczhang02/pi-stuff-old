declare module "@cortexkit/pi-magic-context" {
	import type { MagicContextExtensionAPI } from "./magic-context-types.ts";

	const magicContextFactory: (pi: MagicContextExtensionAPI) => Promise<void> | void;
	export default magicContextFactory;
}
