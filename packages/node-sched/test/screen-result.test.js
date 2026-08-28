import test from "node:test";
import assert from "node:assert/strict";
import { parseScreenResult } from "../lib/screen-result.js";

test("parseScreenResult requires the unique begin/end markers", () => {
	assert.deepEqual(
		parseScreenResult("--- begin se1\n--- end rc=0 id=se1\n", "se1"),
		{ ok: true, code: 0, stdout: "", stderr: "" },
	);
	assert.equal(parseScreenResult("--- end rc=0\n", "se1"), undefined);
	assert.equal(parseScreenResult("--- begin se1\n--- end rc=0 id=se2\n", "se1"), undefined);
});

test("parseScreenResult does not treat command output as the end marker", () => {
	const output = "--- begin se2\n--- end rc=0\nactual output\n--- end rc=7 id=se2\n";
	assert.deepEqual(parseScreenResult(output, "se2"), {
		ok: false, code: 7, stdout: "--- end rc=0\nactual output", stderr: "",
	});
});
