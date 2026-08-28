import test from "node:test";
import assert from "node:assert/strict";
import { formatSshError } from "../lib/ssh-engine.js";

test("formatSshError preserves nested AggregateError causes", () => {
	const error = new AggregateError([
		new Error("connect ETIMEDOUT"),
		new Error("connect ECONNREFUSED"),
	]);
	assert.equal(formatSshError(error), "connect ETIMEDOUT; connect ECONNREFUSED");
});
