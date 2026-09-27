import test from "node:test";
import assert from "node:assert/strict";
import { buildConnectConfig, formatSshError, normalizeKeyboardInteractivePrompts } from "../lib/ssh-engine.js";

test("formatSshError preserves nested AggregateError causes", () => {
	const error = new AggregateError([
		new Error("connect ETIMEDOUT"),
		new Error("connect ECONNREFUSED"),
	]);
	assert.equal(formatSshError(error), "connect ETIMEDOUT; connect ECONNREFUSED");
});

test("normalizes every keyboard-interactive prompt without assuming an OTP", () => {
	assert.deepEqual(
		normalizeKeyboardInteractivePrompts([
			{ prompt: "Password:", echo: false },
			{ prompt: "Verification code:", echo: false },
			{ prompt: "Login:", echo: true },
		]),
		[
			{ id: "0", prompt: "Password:", echo: false },
			{ id: "1", prompt: "Verification code:", echo: false },
			{ id: "2", prompt: "Login:", echo: true },
		],
	);
});

test("password auth keeps keyboard-interactive available for additional prompts", () => {
	const config = buildConnectConfig(
		{
			alias: "test-cluster",
			host: "example.invalid",
			hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			port: 22,
			user: "tester",
			auth: { kind: "password", password: "secret" },
		},
		undefined,
		{ connectTimeoutMs: 5_000, keepaliveIntervalMs: 10_000 },
	);
	assert.equal(config.password, "secret");
	assert.equal(config._kbdintAnswer, undefined);
	assert.equal(config.tryKeyboard, undefined);
});

test("prompt normalization accepts text fallback and escapes controls", () => {
	assert.deepEqual(
		normalizeKeyboardInteractivePrompts([{ text: "line\nbreak\t\u0000", echo: false }]),
		[{ id: "0", prompt: "line\\nbreak\\t\\x00", echo: false }],
	);
});
