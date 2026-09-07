import type { JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { readWebConfig } from "./config.ts";

interface GeminiWebConfig {
	chromeProfile: string | undefined;
	allowBrowserCookies: boolean;
}

export function normalizeChromeProfile(value: JsonInputValue): string | undefined {
	if (!isRuntimeString(value)) return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function loadConfig(): GeminiWebConfig {
	const config = readWebConfig();
	return {
		chromeProfile: normalizeChromeProfile(config?.["chromeProfile"]),
		allowBrowserCookies: config?.["allowBrowserCookies"] === true,
	};
}

export function getChromeProfileFromConfig(): string | undefined {
	return loadConfig().chromeProfile;
}

export function isBrowserCookieAccessAllowed(): boolean {
	if (process.env["PI_ALLOW_BROWSER_COOKIES"] === "1" || process.env["FEYNMAN_ALLOW_BROWSER_COOKIES"] === "1") {
		return true;
	}
	return loadConfig().allowBrowserCookies === true;
}
