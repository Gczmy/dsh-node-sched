import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "ssh2";
import {
	HostTrustBroker,
	hostTrustRouteSnapshot,
	knownHostTrustRecords,
} from "../lib/host-trust.js";
import { probeHostKey, resolveHostRoute } from "../lib/ssh-engine.js";

const PIN_A = `SHA256:${"A".repeat(43)}`;
const PIN_B = `SHA256:${"B".repeat(43)}`;

function entry(overrides = {}) {
	return {
		alias: "compute",
		host: "compute.invalid",
		port: 22,
		user: "runner",
		auth: { kind: "password", password: "secret" },
		proxyJump: [],
		revision: 1,
		...overrides,
	};
}

function storeOf(entries) {
	const values = new Map(entries.map((value) => [value.alias, value]));
	return { find: (alias) => values.get(alias), list: () => [...values.values()] };
}

test("known_hosts keys become bounded trust records without leaking source paths", () => {
	assert.deepEqual(knownHostTrustRecords([
		{ keyType: "ssh-ed25519", fingerprint: PIN_A, sourcePath: "/private/path", sourceLine: 3 },
		{ keyType: "ssh-ed25519", fingerprint: PIN_A },
		{ keyType: "ssh-rsa", fingerprint: "invalid" },
	], 123), [{
		algorithm: "ssh-ed25519",
		fingerprint: PIN_A,
		source: "known_hosts",
		trustedAt: 123,
	}]);
});

test("HostTrustBroker binds confirmations to one browser, route, host, fingerprint, and use", () => {
	let now = 1_000;
	const broker = new HostTrustBroker({ clock: { now: () => now }, ttlMs: 50 });
	const challenge = broker.create({
		principalKey: "session:browser-a",
		targetAlias: "compute",
		targetRevision: 1,
		alias: "compute",
		host: "compute.invalid",
		port: 22,
		algorithm: "ssh-ed25519",
		fingerprint: PIN_A,
		routeDigest: "route-a",
	});
	assert.equal(challenge.credentialsSentToObservedHost, false);
	assert.equal(challenge.targetRevision, 1);
	assert.throws(
		() => broker.consume(challenge.id, {
			principalKey: "session:browser-b",
			targetAlias: "compute",
			alias: "compute",
			fingerprint: PIN_A,
			routeDigest: "route-a",
		}),
		(error) => error.code === "SSH_TRUST_CHALLENGE_MISMATCH",
	);
	assert.throws(
		() => broker.consume(challenge.id, {
			principalKey: "session:browser-a",
			targetAlias: "compute",
			alias: "compute",
			fingerprint: PIN_A,
			routeDigest: "route-a",
		}),
		(error) => error.code === "SSH_TRUST_CHALLENGE_EXPIRED",
	);

	const expiring = broker.create({
		principalKey: "session:browser-a",
		targetAlias: "compute",
		targetRevision: 1,
		alias: "compute",
		host: "compute.invalid",
		port: 22,
		fingerprint: PIN_B,
		routeDigest: "route-a",
	});
	now += 50;
	assert.throws(
		() => broker.consume(expiring.id, {
			principalKey: "session:browser-a",
			targetAlias: "compute",
			alias: "compute",
			fingerprint: PIN_B,
			routeDigest: "route-a",
		}),
		(error) => error.code === "SSH_TRUST_CHALLENGE_EXPIRED",
	);
});

test("HostTrustBroker supersedes old probes, aborts them, and rate-limits new KEX work", () => {
	let now = 1_000;
	const broker = new HostTrustBroker({
		clock: { now: () => now },
		probeRateWindowMs: 100,
		probeRateMax: 2,
		maxActivePerPrincipal: 1,
	});
	let firstAborted = 0;
	const first = broker.beginProbe({
		principalKey: "session:browser-a",
		targetAlias: "first",
		abort: () => { firstAborted += 1; },
	});
	const second = broker.beginProbe({
		principalKey: "session:browser-a",
		targetAlias: "second",
		abort: () => {},
	});
	assert.equal(firstAborted, 1);
	assert.equal(first.isCurrent(), false);
	assert.equal(second.isCurrent(), true);
	assert.throws(
		() => broker.beginProbe({
			principalKey: "session:browser-a",
			targetAlias: "third",
			abort: () => {},
		}),
		(error) => error.code === "SSH_TRUST_RATE_LIMITED" && error.status === 429,
	);
	assert.equal(second.isCurrent(), false);
	now += 100;
	const third = broker.beginProbe({
		principalKey: "session:browser-a",
		targetAlias: "third",
		abort: () => {},
	});
	assert.equal(third.isCurrent(), true);
	assert.equal(broker.cancelProbe("session:browser-a", "different"), false);
	assert.equal(broker.cancelProbe("session:browser-a", "third"), true);
	assert.equal(third.isCurrent(), false);
});

test("route snapshot changes when any ProxyJump identity changes", () => {
	const jump = entry({ alias: "jump", host: "jump.invalid", hostKey: PIN_A });
	const target = entry({ proxyJump: ["jump"] });
	const store = storeOf([jump, target]);
	const before = hostTrustRouteSnapshot(store, "compute");
	jump.revision += 1;
	jump.hostKey = PIN_B;
	const after = hostTrustRouteSnapshot(store, "compute");
	assert.notEqual(before.digest, after.digest);
	assert.deepEqual(after.route.map((value) => value.alias), ["jump", "compute"]);
});

test("flat ProxyJump routing fails closed instead of silently ignoring nested hops", () => {
	const hidden = entry({ alias: "hidden", host: "hidden.invalid", hostKey: PIN_A });
	const jump = entry({ alias: "jump", host: "jump.invalid", hostKey: PIN_A, proxyJump: ["hidden"] });
	const target = entry({ proxyJump: ["jump"] });
	const store = storeOf([hidden, jump, target]);
	assert.throws(
		() => resolveHostRoute(store, target),
		(error) => error.code === "SSH_PROXY_JUMP_NESTED" && /flatten/.test(error.message),
	);
});

test("live host-key probe observes KEX and supplies zero user credentials", async (t) => {
	const originalConnect = Client.prototype.connect;
	const originalDestroy = Client.prototype.destroy;
	let captured;
	Client.prototype.connect = function connect(config) {
		captured = config;
		queueMicrotask(() => config.hostVerifier(Buffer.from("server-host-key")));
		return this;
	};
	Client.prototype.destroy = function destroy() {
		queueMicrotask(() => this.emit("close"));
		return this;
	};
	t.after(() => {
		Client.prototype.connect = originalConnect;
		Client.prototype.destroy = originalDestroy;
	});
	const target = entry({ hostKey: undefined, hostKeys: [] });
	const engine = {
		store: storeOf([target]),
		opts: { connectTimeoutMs: 1_000, keepaliveIntervalMs: 15_000 },
	};
	const observed = await probeHostKey(engine, "compute");
	assert.equal(observed.state, "observed");
	assert.equal(observed.alias, "compute");
	assert.match(observed.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
	for (const field of [
		"password", "privateKey", "passphrase", "agent", "_kbdintAnswer", "_interactiveAuth",
	]) {
		assert.equal(Object.hasOwn(captured, field), false, field);
	}
	assert.equal(captured.authHandler(), false);
	assert.equal(captured.tryKeyboard, false);
	assert.ok(captured instanceof Object);
});
