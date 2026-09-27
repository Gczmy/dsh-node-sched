import test from "node:test";
import assert from "node:assert/strict";
import { mergeEntryOverride } from "../lib/entry-override.js";

test("mergeEntryOverride preserves omitted binding fields", () => {
	assert.deepEqual(
		mergeEntryOverride({ sshEntry: "TEST_CLUSTER", schedAlias: "compute-01", mode: "local" }, { sshEntry: "test_cluster_alt" }),
		{ sshEntry: "test_cluster_alt", schedAlias: "compute-01", mode: "local" },
	);
});

test("mergeEntryOverride ignores malformed stored data", () => {
	assert.deepEqual(mergeEntryOverride(null, { sshEntry: "TEST_CLUSTER" }), { sshEntry: "TEST_CLUSTER" });
	assert.deepEqual(mergeEntryOverride([], { mode: "local" }), { mode: "local" });
});
