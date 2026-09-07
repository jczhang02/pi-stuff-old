/** Released type surface used for development dependencies and version checks. */
export const CERTIFIED_PI_VERSION = "0.85.1";

/** Upstream release source reference; not a Host admission requirement. */
export const CERTIFIED_PI_SOURCE_COMMIT = "d981de1229ef899957bbe968bc8dcda02a21f477";

export const CERTIFIED_PI_SOURCE_REPOSITORY = "https://github.com/earendil-works/pi";

/** Supported Host version used by real-Host acceptance checks. */
export const CERTIFIED_PI_HOST_PROFILE = CERTIFIED_PI_VERSION;

if (import.meta.main) process.stdout.write(CERTIFIED_PI_VERSION);
