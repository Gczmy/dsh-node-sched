import test from "node:test";
import assert from "node:assert/strict";
import { parseUploadedPath } from "../lib/upload-path.js";

test("parseUploadedPath returns the absolute path emitted after upload", () => {
	assert.equal(
		parseUploadedPath("remote diagnostic\n/home/tester/.sched/inbox/node-upload.json\n", "node-upload.json"),
		"/home/tester/.sched/inbox/node-upload.json",
	);
});

test("parseUploadedPath rejects an absent or unrelated path", () => {
	assert.throws(() => parseUploadedPath("", "node-upload.json"), /absolute path/);
	assert.throws(() => parseUploadedPath("/tmp/other.json", "node-upload.json"), /absolute path/);
});
