import { getHostSharedResource } from "../shared/host-resource.ts";
import { CommandDialogCoordinatorImplementation } from "./command-dialog.ts";
import type { CommandDialogCoordinator, CommandDialogCoordinatorHost } from "./command-dialog-types.ts";
import { globalWeakMap } from "./global-registry.ts";

const COORDINATOR_REGISTRY = Symbol.for("@jczhang02/pi-stuff-ui/coordinators/v1");
const COORDINATOR_DISCOVERY_EVENT = "@jczhang02/pi-stuff-ui/coordinator-discovery/v1";

export function getCommandDialogCoordinator(pi: CommandDialogCoordinatorHost): CommandDialogCoordinator {
	const registry = globalWeakMap<CommandDialogCoordinatorImplementation>(COORDINATOR_REGISTRY);
	const existing = registry.get(pi.events);
	if (existing) {
		existing.ensureGeneration(pi);
		return existing;
	}

	const coordinator = getHostSharedResource(
		pi.events,
		registry,
		COORDINATOR_DISCOVERY_EVENT,
		() => new CommandDialogCoordinatorImplementation(),
		{ registerOwnerCleanup: (cleanup) => pi.on("session_shutdown", cleanup) },
	);
	coordinator.ensureGeneration(pi);
	return coordinator;
}
