import { describe, expect, test } from "bun:test";
import { acceptanceMatrixMode, selectAcceptanceMatrix } from "../../../scripts/acceptance-matrix.ts";

describe("acceptance matrix selection", () => {
	test("defaults to the full matrix and accepts representative selection", () => {
		expect(acceptanceMatrixMode({})).toBe("full");
		expect(acceptanceMatrixMode({ PI_STUFF_ACCEPTANCE_MATRIX: "representative" })).toBe("representative");
		expect(selectAcceptanceMatrix(["full"], ["representative"], {})).toEqual(["full"]);
		expect(
			selectAcceptanceMatrix(["full"], ["representative"], { PI_STUFF_ACCEPTANCE_MATRIX: "representative" }),
		).toEqual(["representative"]);
	});

	test("rejects invalid matrix modes", () => {
		expect(() => acceptanceMatrixMode({ PI_STUFF_ACCEPTANCE_MATRIX: "quick" })).toThrow(
			"PI_STUFF_ACCEPTANCE_MATRIX must be full or representative",
		);
	});
});
