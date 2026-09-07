import { compactTerminalPath } from "../../../tool-display/index.ts";

export function compactPath(path: string, maxLength: number): string {
	return compactTerminalPath(path, maxLength);
}
