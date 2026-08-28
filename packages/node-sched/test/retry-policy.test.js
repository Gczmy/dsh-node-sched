import test from "node:test";
import assert from "node:assert/strict";
import { isTransientSshError } from "../lib/retry-policy.js";

test("isTransientSshError recognizes CLI and engine transport failures", () => {
	for (const message of [
		"ssh: connect to host: Connection timed out",
		"ssh: connect to host: Operation timed out",
		"Error: connect ECONNRESET",
		"[ssh-engine:node] channel open failure",
		"Timed out while waiting for handshake",
		"Connection lost before handshake",
		"handshake failed while opening session",
	]) {
		assert.equal(isTransientSshError(message), true, message);
	}
});

test("isTransientSshError recognizes common OpenSSH disconnects", () => {
	for (const message of [
		"ssh: Connection reset by peer",
		"ssh: Connection closed by remote host",
		"ssh: No route to host",
		"ssh: Network is unreachable",
	]) {
		assert.equal(isTransientSshError(message), true, message);
	}
});

test("isTransientSshError ignores scheduler command failures", () => {
	assert.equal(isTransientSshError("sched: unknown command"), false);
	assert.equal(isTransientSshError("permission denied"), false);
});
