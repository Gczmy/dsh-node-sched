import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
	AUTH_API,
	BrowserAuthGate,
	authSessionStorageKey,
} from "../src/auth-gate.js";

const NOW = 1_800_000_000_000;
const MASTER_TOKEN = "m".repeat(43);
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);

class MemorySessionStorage {
	constructor(entries = []) { this.values = new Map(entries); }
	getItem(key) { return this.values.get(key) ?? null; }
	setItem(key, value) { this.values.set(key, String(value)); }
	removeItem(key) { this.values.delete(key); }
}

class MemoryDeviceStore {
	constructor(record = null) {
		this.available = true;
		this.record = record;
		this.clearCalls = [];
		this.saveCalls = [];
	}
	async load() { return this.record; }
	async save(record, options = {}) {
		this.saveCalls.push({ record, options });
		if (Object.hasOwn(options, "expected") && !sameRecord(this.record, options.expected)) return false;
		this.record = { ...record, id: "current" };
		return true;
	}
	async clear(expected) {
		this.clearCalls.push(expected);
		const matches = !expected
			|| (typeof expected === "string"
				? this.record?.clientId === expected
				: sameRecord(this.record, expected));
		if (!matches) return false;
		this.record = null;
		return true;
	}
}

function sameRecord(current, expected) {
	if (expected == null) return current == null;
	return Boolean(
		current
		&& current.clientId === expected.clientId
		&& current.writeId === expected.writeId
		&& current.createdAt === expected.createdAt
		&& Boolean(current.pending) === Boolean(expected.pending),
	);
}

function clearedClientIds(devices) {
	return devices.clearCalls.map((expected) => (
		typeof expected === "string" ? expected : expected?.clientId
	));
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { "content-type": "application/json" },
});

function shortSession(accessToken, extra = {}) {
	return { ok: true, accessToken, expiresAt: NOW + 60_000, ...extra };
}

function decodeBody(init) {
	return JSON.parse(String(init?.body ?? "null"));
}

function base64Url(bytes) {
	return Buffer.from(bytes).toString("base64url");
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function trustedRecord(clientId = "trusted_client_12345", overrides = {}) {
	const keyPair = await webcrypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign", "verify"],
	);
	return {
		id: "current",
		clientId,
		privateKey: keyPair.privateKey,
		publicKeyJwk: await webcrypto.subtle.exportKey("jwk", keyPair.publicKey),
		createdAt: new Date(NOW - 1_000).toISOString(),
		writeId: "existing-write-id",
		pending: false,
		...overrides,
	};
}

test("session pairing exchanges the master once and stores only the short bearer", async () => {
	const storage = new MemorySessionStorage([["node-sched:access-token", MASTER_TOKEN]]);
	const requests = [];
	const gate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			requests.push({ path, init });
			if (path === AUTH_API.session) return jsonResponse(shortSession(TOKEN_A));
			if (path === "/sched/api/status") return jsonResponse({ ok: true });
			throw new Error(`unexpected path ${path}`);
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: new MemoryDeviceStore(),
		now: () => NOW,
	});

	assert.equal(storage.getItem("node-sched:access-token"), null);
	assert.equal(await gate.restore(), false);
	assert.equal(gate.snapshot().status, "required");
	assert.equal(await gate.pair(MASTER_TOKEN, { remember: false }), true);
	assert.equal(gate.snapshot().status, "ready");
	assert.equal(gate.snapshot().trusted, false);
	assert.equal(requests[0].path, AUTH_API.session);
	assert.equal(requests[0].init.headers.get("authorization"), `Bearer ${MASTER_TOKEN}`);
	assert.deepEqual(decodeBody(requests[0].init), {});

	const saved = storage.getItem(authSessionStorageKey);
	assert.match(saved, new RegExp(TOKEN_A));
	assert.doesNotMatch(saved, new RegExp(MASTER_TOKEN));
	await gate.authorizedFetch("/sched/api/status");
	assert.equal(requests[1].init.headers.get("authorization"), `Bearer ${TOKEN_A}`);
});

test("trusted pairing stores a non-exportable P-256 key and silently verifies a raw challenge", async () => {
	const storage = new MemorySessionStorage();
	const devices = new MemoryDeviceStore();
	let publicKeyJwk;
	const firstGate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			assert.equal(path, AUTH_API.pair);
			assert.equal(init.headers.get("authorization"), `Bearer ${MASTER_TOKEN}`);
			const body = decodeBody(init);
			publicKeyJwk = body.publicKeyJwk;
			assert.match(body.clientId, /^[A-Za-z0-9_-]{16,128}$/u);
			assert.equal(body.trustDays, 30);
			return jsonResponse(shortSession(TOKEN_A, { clientId: body.clientId }));
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: devices,
		now: () => NOW,
	});

	await firstGate.pair(MASTER_TOKEN, { remember: true, label: "test browser" });
	assert.equal(firstGate.snapshot().trusted, true);
	assert.equal(devices.record.privateKey.extractable, false);
	assert.equal(devices.record.privateKey.algorithm.name, "ECDSA");
	assert.equal(devices.record.privateKey.algorithm.namedCurve, "P-256");
	assert.equal(publicKeyJwk.d, undefined);

	storage.removeItem(authSessionStorageKey);
	const challengeBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
	const challenge = base64Url(challengeBytes);
	const challengeId = "challenge-1";
	let verified = false;
	let verifyCalls = 0;
	const secondGate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			const body = decodeBody(init);
			if (path === AUTH_API.challenge) {
				assert.equal(body.clientId, devices.record.clientId);
				return jsonResponse({ ok: true, challengeId, challenge });
			}
			if (path === AUTH_API.verify) {
				verifyCalls += 1;
				if (verifyCalls === 1) {
					return jsonResponse({ ok: false, code: "invalid_challenge", error: "challenge expired" }, 401);
				}
				assert.equal(body.challengeId, challengeId);
				const publicKey = await webcrypto.subtle.importKey(
					"jwk",
					publicKeyJwk,
					{ name: "ECDSA", namedCurve: "P-256" },
					false,
					["verify"],
				);
				verified = await webcrypto.subtle.verify(
					{ name: "ECDSA", hash: "SHA-256" },
					publicKey,
					Buffer.from(body.signature, "base64url"),
					challengeBytes,
				);
				return jsonResponse(shortSession(TOKEN_B, { clientId: body.clientId }));
			}
			throw new Error(`unexpected path ${path}`);
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: devices,
		now: () => NOW,
	});

	assert.equal(await secondGate.restore(), true);
	assert.equal(verifyCalls, 2);
	assert.deepEqual(devices.clearCalls, []);
	assert.equal(verified, true);
	assert.equal(secondGate.snapshot().status, "ready");
	assert.equal(secondGate.snapshot().trusted, true);
	assert.equal(secondGate.requireCredential().accessToken, TOKEN_B);
	const expiredCredential = secondGate.requireCredential();
	assert.equal(secondGate.rejectCredential(expiredCredential), true);
	assert.equal(secondGate.snapshot().status, "locked");
	assert.equal(secondGate.snapshot().hasTrustedDevice, true);
	assert.equal(await secondGate.restore({ force: true }), true);
	assert.equal(verifyCalls, 3);
	assert.equal(secondGate.snapshot().status, "ready");
});

test("a delayed 401 cannot clear a newer credential, while its own 401 locks once", async () => {
	const storage = new MemorySessionStorage();
	let sessionCount = 0;
	let resolveOld;
	const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
	const gate = new BrowserAuthGate({
		fetchImpl: async (path) => {
			if (path === AUTH_API.session) {
				sessionCount += 1;
				return jsonResponse(shortSession(sessionCount === 1 ? TOKEN_A : TOKEN_B));
			}
			if (path === "/old") return oldResponse;
			if (path === "/new") return jsonResponse({ ok: false }, 401);
			throw new Error(`unexpected path ${path}`);
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: new MemoryDeviceStore(),
		now: () => NOW,
	});

	await gate.pair(MASTER_TOKEN, { remember: false });
	const pendingOld = gate.authorizedFetch("/old");
	await gate.pair(MASTER_TOKEN, { remember: false });
	resolveOld(jsonResponse({ ok: false }, 401));
	await pendingOld;
	assert.equal(gate.snapshot().status, "ready");
	assert.equal(gate.requireCredential().accessToken, TOKEN_B);
	assert.match(storage.getItem(authSessionStorageKey), new RegExp(TOKEN_B));

	await gate.authorizedFetch("/new");
	assert.equal(gate.snapshot().status, "locked");
	assert.equal(storage.getItem(authSessionStorageKey), null);
	assert.throws(() => gate.requireCredential(), /authentication is required/u);
});

test("an invalid signature clears the mismatched local trusted key", async () => {
	const keyPair = await webcrypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign", "verify"],
	);
	const clientId = "trusted_client_12345";
	const devices = new MemoryDeviceStore({
		id: "current",
		clientId,
		privateKey: keyPair.privateKey,
	});
	const challenge = base64Url(webcrypto.getRandomValues(new Uint8Array(32)));
	const gate = new BrowserAuthGate({
		fetchImpl: async (path) => {
			if (path === AUTH_API.challenge) return jsonResponse({ ok: true, challengeId: "challenge-invalid-signature", challenge });
			if (path === AUTH_API.verify) {
				return jsonResponse({ ok: false, code: "invalid_signature", error: "signature rejected" }, 401);
			}
			throw new Error(`unexpected path ${path}`);
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	assert.equal(await gate.restore(), false);
	assert.deepEqual(clearedClientIds(devices), [clientId]);
	assert.equal(devices.record, null);
	assert.equal(gate.snapshot().hasTrustedDevice, false);
});

test("cancelling silent restoration aborts the one in-flight challenge and stays locked", async () => {
	const keyPair = await webcrypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign", "verify"],
	);
	const devices = new MemoryDeviceStore({
		id: "current",
		clientId: "trusted_client_12345",
		privateKey: keyPair.privateKey,
	});
	let calls = 0;
	const gate = new BrowserAuthGate({
		fetchImpl: (_path, init) => {
			calls += 1;
			return new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	const restoring = gate.restore();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(gate.snapshot().status, "restoring");
	assert.equal(gate.cancelPending(), true);
	assert.equal(await restoring, false);
	assert.equal(gate.snapshot().status, "required");
	assert.equal(calls, 1);
	assert.throws(() => gate.webSocketProtocols(), /authentication is required/u);
});

test("a pairing committed while its response is aborted is recovered from the pending device key", async () => {
	const storage = new MemorySessionStorage();
	const devices = new MemoryDeviceStore();
	let pairStartedResolve;
	const pairStarted = new Promise((resolve) => { pairStartedResolve = resolve; });
	let committedClientId;
	const firstGate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			assert.equal(path, AUTH_API.pair);
			committedClientId = decodeBody(init).clientId;
			pairStartedResolve();
			return new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException("response lost", "AbortError")), { once: true });
			});
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: devices,
		now: () => NOW,
	});

	const pairing = firstGate.pair(MASTER_TOKEN, { remember: true, label: "pending browser" });
	await pairStarted;
	assert.equal(devices.record.clientId, committedClientId);
	assert.equal(devices.record.pending, true);
	firstGate.cancelPending();
	assert.equal(await pairing, false);
	assert.equal(devices.record.pending, true);

	const challenge = base64Url(webcrypto.getRandomValues(new Uint8Array(32)));
	const secondGate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			const body = decodeBody(init);
			assert.equal(body.clientId, committedClientId);
			if (path === AUTH_API.challenge) return jsonResponse({ ok: true, challengeId: "pending-challenge-1", challenge });
			if (path === AUTH_API.verify) return jsonResponse(shortSession(TOKEN_B, { clientId: committedClientId }));
			throw new Error(`unexpected path ${path}`);
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: devices,
		now: () => NOW,
	});

	assert.equal(await secondGate.restore(), true);
	assert.equal(secondGate.snapshot().status, "ready");
	assert.equal(devices.record.clientId, committedClientId);
	assert.equal(devices.record.pending, false);
});

test("a 500 pair response preserves pending identity and a later challenge recovers it", async () => {
	const devices = new MemoryDeviceStore();
	const storage = new MemorySessionStorage();
	const firstGate = new BrowserAuthGate({
		fetchImpl: async (path) => {
			assert.equal(path, AUTH_API.pair);
			return jsonResponse({ ok: false, code: "internal_error", error: "temporary failure" }, 500);
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: devices,
		now: () => NOW,
	});

	await assert.rejects(firstGate.pair(MASTER_TOKEN, { remember: true }), /temporary failure/u);
	assert.equal(devices.record.pending, true);
	const pendingClientId = devices.record.clientId;
	const challenge = base64Url(webcrypto.getRandomValues(new Uint8Array(32)));
	const secondGate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			assert.equal(decodeBody(init).clientId, pendingClientId);
			if (path === AUTH_API.challenge) {
				return jsonResponse({ ok: true, challengeId: "recover-after-500", challenge });
			}
			if (path === AUTH_API.verify) {
				return jsonResponse(shortSession(TOKEN_B, { clientId: pendingClientId }));
			}
			throw new Error(`unexpected path ${path}`);
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: devices,
		now: () => NOW,
	});

	assert.equal(await secondGate.restore(), true);
	assert.equal(secondGate.requireCredential().accessToken, TOKEN_B);
	assert.equal(devices.record.pending, false);
	assert.equal(devices.record.previousRecord, undefined);
});

test("an ambiguous 404 pair response keeps pending until challenge proves unknown", async () => {
	const devices = new MemoryDeviceStore();
	let pairCalled = false;
	const gate = new BrowserAuthGate({
		fetchImpl: async (path) => {
			if (path === AUTH_API.pair) {
				pairCalled = true;
				return jsonResponse({ ok: false, code: "unknown_client", error: "ambiguous proxy response" }, 404);
			}
			assert.equal(path, AUTH_API.challenge);
			return jsonResponse({ ok: false, code: "unknown_client", error: "not committed" }, 404);
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	await assert.rejects(gate.pair(MASTER_TOKEN, { remember: true }), /ambiguous proxy response/u);
	assert.equal(pairCalled, true);
	assert.equal(devices.record.pending, true);
	const pendingClientId = devices.record.clientId;
	assert.equal(await gate.restore(), false);
	assert.deepEqual(clearedClientIds(devices), [pendingClientId]);
	assert.equal(devices.record, null);
});

test("cancelling delayed key generation writes no pending record and sends no pair request", async () => {
	const generatedKeyPair = await webcrypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign", "verify"],
	);
	const generation = deferred();
	const generationStarted = deferred();
	const devices = new MemoryDeviceStore();
	let fetchCalls = 0;
	const cryptoImpl = {
		randomUUID: webcrypto.randomUUID.bind(webcrypto),
		subtle: {
			generateKey: () => {
				generationStarted.resolve();
				return generation.promise;
			},
			exportKey: webcrypto.subtle.exportKey.bind(webcrypto.subtle),
		},
	};
	const gate = new BrowserAuthGate({
		fetchImpl: async () => {
			fetchCalls += 1;
			throw new Error("pair request must not start");
		},
		cryptoImpl,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	const pairing = gate.pair(MASTER_TOKEN, { remember: true });
	await generationStarted.promise;
	assert.equal(gate.cancelPending(), true);
	generation.resolve(generatedKeyPair);
	assert.equal(await pairing, false);
	assert.equal(fetchCalls, 0);
	assert.equal(devices.saveCalls.length, 0);
	assert.equal(devices.record, null);
});

test("cancelling during pending persistence CAS-cleans the unsubmitted device record", async () => {
	const devices = new MemoryDeviceStore();
	const saveStarted = deferred();
	const allowSave = deferred();
	const originalSave = devices.save.bind(devices);
	let firstSave = true;
	devices.save = async (record, options) => {
		if (firstSave) {
			firstSave = false;
			saveStarted.resolve();
			await allowSave.promise;
		}
		return originalSave(record, options);
	};
	let fetchCalls = 0;
	const gate = new BrowserAuthGate({
		fetchImpl: async () => {
			fetchCalls += 1;
			throw new Error("pair request must not start");
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	const pairing = gate.pair(MASTER_TOKEN, { remember: true });
	await saveStarted.promise;
	assert.equal(gate.cancelPending(), true);
	allowSave.resolve();
	assert.equal(await pairing, false);
	assert.equal(fetchCalls, 0);
	assert.equal(devices.saveCalls.length, 1);
	assert.equal(devices.record, null);
	assert.equal(devices.clearCalls.length, 1);
});

test("a cancelled pair response arriving after a newer pair cannot overwrite its device record", async () => {
	const devices = new MemoryDeviceStore();
	const firstResponse = deferred();
	const firstStarted = deferred();
	const requestBodies = [];
	const gate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			assert.equal(path, AUTH_API.pair);
			const body = decodeBody(init);
			requestBodies.push(body);
			if (requestBodies.length === 1) {
				firstStarted.resolve();
				return firstResponse.promise;
			}
			return jsonResponse(shortSession(TOKEN_B, { clientId: body.clientId }));
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	const firstPair = gate.pair(MASTER_TOKEN, { remember: true, label: "pair A" });
	await firstStarted.promise;
	const firstWriteId = devices.record.writeId;
	assert.equal(gate.cancelPending(), true);
	assert.equal(await gate.pair(MASTER_TOKEN, { remember: true, label: "pair B" }), true);
	const secondWriteId = devices.record.writeId;
	assert.notEqual(secondWriteId, firstWriteId);
	firstResponse.resolve(jsonResponse(shortSession(TOKEN_A, { clientId: requestBodies[0].clientId })));
	assert.equal(await firstPair, false);
	assert.equal(gate.requireCredential().accessToken, TOKEN_B);
	assert.equal(devices.record.writeId, secondWriteId);
	assert.equal(devices.record.pending, false);
	assert.equal(requestBodies[0].clientId, requestBodies[1].clientId);
});

test("a cancelled slow restore cannot overwrite a newer successful pair", async () => {
	const existing = await trustedRecord();
	const devices = new MemoryDeviceStore(existing);
	const firstLoad = deferred();
	const firstLoadStarted = deferred();
	let loadCalls = 0;
	devices.load = async () => {
		loadCalls += 1;
		if (loadCalls === 1) {
			firstLoadStarted.resolve();
			return firstLoad.promise;
		}
		return devices.record;
	};
	const gate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			assert.equal(path, AUTH_API.pair);
			const body = decodeBody(init);
			return jsonResponse(shortSession(TOKEN_B, { clientId: body.clientId }));
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	const restoring = gate.restore();
	await firstLoadStarted.promise;
	assert.equal(gate.cancelPending(), true);
	assert.equal(await gate.pair(MASTER_TOKEN, { remember: true, label: "new pair" }), true);
	const pairedWriteId = devices.record.writeId;
	firstLoad.resolve(existing);
	assert.equal(await restoring, false);
	assert.equal(gate.snapshot().status, "ready");
	assert.equal(gate.requireCredential().accessToken, TOKEN_B);
	assert.equal(devices.record.writeId, pairedWriteId);
	assert.equal(devices.record.label, "new pair");
});

test("trusted verification does not install a token when pending finalization loses CAS", async () => {
	const pending = await trustedRecord("pending_client_12345", { pending: true, writeId: "pending-write" });
	const newer = await trustedRecord("newer_client_123456", { writeId: "newer-write" });
	const devices = new MemoryDeviceStore(pending);
	const originalSave = devices.save.bind(devices);
	devices.save = async (record, options) => {
		if (record.pending === false && options?.expected?.pending === true) {
			devices.record = newer;
			return false;
		}
		return originalSave(record, options);
	};
	const challenge = base64Url(webcrypto.getRandomValues(new Uint8Array(32)));
	const gate = new BrowserAuthGate({
		fetchImpl: async (path) => {
			if (path === AUTH_API.challenge) {
				return jsonResponse({ ok: true, challengeId: "finalize-cas-race", challenge });
			}
			if (path === AUTH_API.verify) {
				return jsonResponse(shortSession(TOKEN_A, { clientId: pending.clientId }));
			}
			throw new Error(`unexpected path ${path}`);
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	assert.equal(await gate.restore(), false);
	assert.equal(gate.snapshot().status, "required");
	assert.match(gate.snapshot().message, /其他页面更新/u);
	assert.equal(devices.record.writeId, newer.writeId);
	assert.throws(() => gate.requireCredential(), /authentication is required/u);
});

test("a definitive failed re-pair reuses and restores the existing browser identity", async () => {
	const existing = await trustedRecord();
	const devices = new MemoryDeviceStore(existing);
	let pairBody;
	const gate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			assert.equal(path, AUTH_API.pair);
			pairBody = decodeBody(init);
			return jsonResponse({ ok: false, code: "unauthorized", error: "wrong master" }, 401);
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	await assert.rejects(gate.pair(MASTER_TOKEN, { remember: true }), /wrong master/u);
	assert.equal(pairBody.clientId, existing.clientId);
	assert.deepEqual(pairBody.publicKeyJwk, existing.publicKeyJwk);
	assert.equal(devices.record.clientId, existing.clientId);
	assert.equal(devices.record.writeId, existing.writeId);
	assert.equal(devices.record.privateKey, existing.privateKey);
	assert.equal(devices.record.pending, false);
});

test("repeated ambiguous pairing keeps only the earliest previous identity layer", async () => {
	const clientId = "nested_client_123456";
	const earliest = await trustedRecord(clientId, { writeId: "stable-write", pending: false });
	const currentPending = await trustedRecord(clientId, {
		writeId: "first-pending-write",
		pending: true,
		previousRecord: earliest,
	});
	const devices = new MemoryDeviceStore(currentPending);
	const gate = new BrowserAuthGate({
		fetchImpl: async (path) => {
			assert.equal(path, AUTH_API.pair);
			return jsonResponse({ ok: false, code: "internal_error", error: "still ambiguous" }, 500);
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	await assert.rejects(gate.pair(MASTER_TOKEN, { remember: true }), /still ambiguous/u);
	assert.equal(devices.record.pending, true);
	assert.equal(devices.record.previousRecord.writeId, earliest.writeId);
	assert.equal(devices.record.previousRecord.previousRecord, undefined);
});

test("failed pending-key persistence prevents the server pairing request", async () => {
	const paths = [];
	const devices = new MemoryDeviceStore();
	devices.save = async () => { throw new Error("structured clone denied"); };
	const gate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			paths.push({ path, init });
			if (path === AUTH_API.pair) {
				const { clientId } = decodeBody(init);
				return jsonResponse(shortSession(TOKEN_A, { clientId }));
			}
			if (path === AUTH_API.forget) return jsonResponse({ ok: true });
			throw new Error(`unexpected path ${path}`);
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	await assert.rejects(gate.pair(MASTER_TOKEN, { remember: true }), /无法保存受信设备私钥/u);
	assert.deepEqual(paths, []);
	assert.equal(gate.snapshot().status, "required");
});

test("an uncommitted pending device is cleared when the server reports unknown_client", async () => {
	const keyPair = await webcrypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign", "verify"],
	);
	const clientId = "pending_client_12345";
	const devices = new MemoryDeviceStore({
		id: "current",
		clientId,
		privateKey: keyPair.privateKey,
		pending: true,
	});
	const gate = new BrowserAuthGate({
		fetchImpl: async (path) => {
			assert.equal(path, AUTH_API.challenge);
			return jsonResponse({ ok: false, code: "unknown_client", error: "unknown browser" }, 404);
		},
		cryptoImpl: webcrypto,
		sessionStorage: new MemorySessionStorage(),
		deviceStore: devices,
		now: () => NOW,
	});

	assert.equal(await gate.restore(), false);
	assert.deepEqual(clearedClientIds(devices), [clientId]);
	assert.equal(devices.record, null);
	assert.equal(gate.snapshot().status, "required");
});

test("forget clears persistent identity even when a trusted short session restored without an IDB record", async () => {
	const clientId = "trusted_client_12345";
	const storage = new MemorySessionStorage([[authSessionStorageKey, JSON.stringify({
		accessToken: TOKEN_A,
		expiresAt: NOW + 60_000,
		clientId,
		trusted: true,
	})]]);
	const devices = new MemoryDeviceStore();
	devices.load = async () => { throw new Error("IDB temporarily unavailable"); };
	const gate = new BrowserAuthGate({
		fetchImpl: async (path, init) => {
			assert.equal(path, AUTH_API.forget);
			assert.equal(init.headers.get("authorization"), `Bearer ${TOKEN_A}`);
			return jsonResponse({ ok: true });
		},
		cryptoImpl: webcrypto,
		sessionStorage: storage,
		deviceStore: devices,
		now: () => NOW,
	});

	assert.equal(await gate.restore(), true);
	assert.equal(gate.snapshot().trusted, true);
	assert.equal(gate.snapshot().hasTrustedDevice, true);
	await gate.forget();
	assert.deepEqual(devices.clearCalls, [clientId]);
	assert.equal(storage.getItem(authSessionStorageKey), null);
	assert.equal(gate.snapshot().status, "required");
});
