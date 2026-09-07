import { test } from "bun:test";
import { verifySourceInstallation } from "../../../scripts/verify-package.ts";

test("Pi installs and loads the source Package from an isolated project", verifySourceInstallation, 90_000);
