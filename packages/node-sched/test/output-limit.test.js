import test from "node:test";
import assert from "node:assert/strict";
import { appendLimitedOutput, finalizeLimitedOutput, limitedOutputText } from "../lib/output-limit.js";

function accumulator() {
	return { text: "", bytes: 0, droppedBytes: 0, truncated: false };
}

test("appendLimitedOutput caps bytes and reports dropped output", () => {
	const target = accumulator();
	appendLimitedOutput(target, Buffer.from("abcdef"), 4);
	appendLimitedOutput(target, Buffer.from("gh"), 4);
	assert.equal(target.text, "abcd");
	assert.equal(target.bytes, 4);
	assert.equal(target.droppedBytes, 4);
	assert.equal(limitedOutputText(target), "abcd\n…[truncated 4 bytes]");
});

test("appendLimitedOutput preserves valid UTF-8 at the boundary", () => {
	const target = accumulator();
	appendLimitedOutput(target, Buffer.from("你好", "utf8"), 4);
	assert.equal(target.text, "你");
	assert.equal(Buffer.byteLength(target.text, "utf8"), 3);
	assert.equal(target.droppedBytes, 3);
});

test("appendLimitedOutput carries split UTF-8 sequences across chunks", () => {
	const target = accumulator();
	const bytes = Buffer.from("😀", "utf8");
	appendLimitedOutput(target, bytes.subarray(0, 2), 4);
	appendLimitedOutput(target, bytes.subarray(2), 4);
	assert.equal(target.text, "😀");
	assert.equal(target.bytes, 4);
});

test("appendLimitedOutput never emits a partial UTF-8 character", () => {
	const target = accumulator();
	appendLimitedOutput(target, Buffer.from("😀", "utf8"), 3);
	assert.equal(target.text, "");
	assert.equal(target.bytes, 0);
	assert.equal(target.droppedBytes, 4);
	assert.match(limitedOutputText(target), /truncated 4 bytes/);
});

test("appendLimitedOutput counts malformed bytes against the raw cap", () => {
	const target = accumulator();
	appendLimitedOutput(target, Buffer.from([0x61, 0x62, 0x63, 0x80]), 4);
	assert.equal(target.bytes, 4);
	assert.equal(target.truncated, false);
	assert.equal(Buffer.byteLength(target.text, "utf8"), 6);
});

test("finalizeLimitedOutput accounts for an incomplete trailing sequence", () => {
	const target = accumulator();
	appendLimitedOutput(target, Buffer.from([0xc3]), 4);
	finalizeLimitedOutput(target);
	assert.equal(target.bytes, 1);
	assert.equal(target.text, "�");
	assert.equal(target.pending.length, 0);
});
