import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifySuiteSurface } from "../../../scripts/verify-package.ts";

test(
	"Suite Tool inspectors and configuration purity through RPC",
	() => verifySuiteSurface(resolvePiBinary(), resolve(import.meta.dirname, "../../../packages/pi-stuff")),
	90_000,
);
