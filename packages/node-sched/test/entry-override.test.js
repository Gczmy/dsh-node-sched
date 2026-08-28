import test from "node:test";
import assert from "node:assert/strict";
import { mergeEntryOverride } from "../lib/entry-override.js";

test("mergeEntryOverride preserves omitted binding fields", () => {
	assert.deepEqual(
		mergeEntryOverride({ sshEntry: "HPDC", schedAlias: "ambiorix", mode: "local" }, { sshEntry: "HPDC_outside" }),
		{ sshEntry: "HPDC_outside", schedAlias: "ambiorix", mode: "local" },
	);
});

test("mergeEntryOverride ignores malformed stored data", () => {
	assert.deepEqual(mergeEntryOverride(null, { sshEntry: "HPDC" }), { sshEntry: "HPDC" });
	assert.deepEqual(mergeEntryOverride([], { mode: "local" }), { mode: "local" });
});
