import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackAddress, originHostAllowed } from "../lib/request-guard.js";

test("originHostAllowed accepts local browser requests", () => {
	assert.equal(originHostAllowed({ headers: { host: "127.0.0.1:3000", origin: "http://localhost:3000" } }), true);
	assert.equal(originHostAllowed({ headers: { host: "[::1]:3000", origin: "https://[::1]:3000" } }), true);
	assert.equal(originHostAllowed({ headers: { host: "[::ffff:127.0.0.1]:3000", origin: "http://[::ffff:127.0.0.1]:3000" } }), true);
});

test("originHostAllowed rejects cross-origin and malformed hosts", () => {
	assert.equal(originHostAllowed({ headers: { host: "127.0.0.1:3000", origin: "https://evil.example" } }), false);
	assert.equal(originHostAllowed({ headers: { host: "evil.example", origin: "http://localhost" } }), false);
	assert.equal(originHostAllowed({ headers: { host: "not a host" } }), false);
});

test("isLoopbackAddress handles IPv4 and mapped IPv6", () => {
	assert.equal(isLoopbackAddress("127.0.0.1"), true);
	assert.equal(isLoopbackAddress("::1"), true);
	assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
	assert.equal(isLoopbackAddress("192.0.2.1"), false);
});
