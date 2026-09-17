import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import cp from "node:child_process";
import fs, { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { WebSocketServer } from "ws";

import { DeviceAuthError, TrustedBrowserAuth } from "../lib/device-auth.js";
import { apply, websocketRequestPrincipal } from "../lib/index.js";
import { SshEngine } from "../lib/ssh-engine.js";

const ORIGIN = "http://127.0.0.1:3000";
const MASTER = "M".repeat(43);
const CLIENT_ID = "browser_client_0001";
const SECOND_CLIENT_ID = "browser_client_0002";

async function signingIdentity() {
	const keys = await webcrypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const exported = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
	return {
		privateKey: keys.privateKey,
		publicKeyJwk: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y },
	};
}

async function signChallenge(privateKey, challenge) {
	const raw = Buffer.from(challenge, "base64url");
	assert.equal(raw.length, 32);
	const signature = await webcrypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		privateKey,
		raw,
	);
	assert.equal(signature.byteLength, 64);
	return Buffer.from(signature).toString("base64url");
}

function temporaryStore() {
	const root = mkdtempSync(path.join(tmpdir(), "nodesched-device-auth-"));
	return {
		root,
		file: path.join(root, "private", "trusted.json"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function withRenameFailure(operation) {
	const original = fs.renameSync;
	const injected = Object.assign(new Error("injected trusted-browser rename failure"), { code: "EIO" });
	fs.renameSync = () => { throw injected; };
	try {
		return operation(injected);
	} finally {
		fs.renameSync = original;
	}
}

function withDirectoryFsyncFailure(operation) {
	const original = fs.fsyncSync;
	const injected = Object.assign(new Error("injected trusted-browser directory fsync failure"), { code: "EIO" });
	let failed = false;
	fs.fsyncSync = (fd) => {
		if (!failed && fs.fstatSync(fd).isDirectory()) {
			failed = true;
			throw injected;
		}
		return original.call(fs, fd);
	};
	try {
		const result = operation(injected);
		assert.equal(failed, true, "the post-rename directory fsync must be reached");
		return result;
	} finally {
		fs.fsyncSync = original;
	}
}

test("trusted browser proof issues an origin-bound, expiring one-time session", async () => {
	const temporary = temporaryStore();
	let now = 1_000_000;
	try {
		const identity = await signingIdentity();
		const auth = new TrustedBrowserAuth({
			masterToken: MASTER,
			file: temporary.file,
			now: () => now,
			sessionTtlMs: 15 * 60 * 1000,
		});
		const paired = auth.pair({
			clientId: CLIENT_ID,
			publicKeyJwk: identity.publicKeyJwk,
			label: "Firefox on this Mac",
			trustDays: 7,
		}, ORIGIN);
		assert.match(paired.accessToken, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(auth.authenticateBearer(paired.accessToken, ORIGIN)?.clientId, CLIENT_ID);
		assert.equal(auth.authenticateBearer(paired.accessToken, "http://localhost:3000"), null);

		const pending = auth.createChallenge(CLIENT_ID, ORIGIN);
		assert.match(pending.challengeId, /^[A-Za-z0-9_-]{16,128}$/);
		assert.match(pending.challenge, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(pending.expiresAt, now + 60_000);
		const signature = await signChallenge(identity.privateKey, pending.challenge);
		const verified = auth.verifyChallenge({
			clientId: CLIENT_ID,
			challengeId: pending.challengeId,
			signature,
		}, ORIGIN);
		assert.equal(verified.clientId, CLIENT_ID);
		assert.equal(verified.expiresAt, now + 15 * 60 * 1000);
		assert.equal(auth.authenticateBearer(verified.accessToken, ORIGIN)?.kind, "session");
		assert.throws(
			() => auth.verifyChallenge({
				clientId: CLIENT_ID,
				challengeId: pending.challengeId,
				signature,
			}, ORIGIN),
			(error) => error instanceof DeviceAuthError && error.code === "invalid_challenge",
		);

		now = verified.expiresAt + 1;
		assert.equal(auth.authenticateBearer(verified.accessToken, ORIGIN), null);
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

test("invalid signatures consume challenges and challenge admission is bounded", async () => {
	const temporary = temporaryStore();
	try {
		const identity = await signingIdentity();
		const otherIdentity = await signingIdentity();
		const auth = new TrustedBrowserAuth({
			masterToken: MASTER,
			file: temporary.file,
			challengeRateMax: 2,
			maxChallenges: 2,
		});
		auth.pair({ clientId: CLIENT_ID, publicKeyJwk: identity.publicKeyJwk, label: "browser" }, ORIGIN);
		const first = auth.createChallenge(CLIENT_ID, ORIGIN);
		const invalid = await signChallenge(otherIdentity.privateKey, first.challenge);
		assert.throws(
			() => auth.verifyChallenge({ clientId: CLIENT_ID, challengeId: first.challengeId, signature: invalid }, ORIGIN),
			(error) => error instanceof DeviceAuthError && error.code === "invalid_signature",
		);
		assert.throws(
			() => auth.verifyChallenge({ clientId: CLIENT_ID, challengeId: first.challengeId, signature: invalid }, ORIGIN),
			(error) => error instanceof DeviceAuthError && error.code === "invalid_challenge",
		);
		const malformed = auth.createChallenge(CLIENT_ID, ORIGIN);
		assert.throws(
			() => auth.verifyChallenge({ clientId: CLIENT_ID, challengeId: malformed.challengeId, signature: "bad" }, ORIGIN),
			(error) => error instanceof DeviceAuthError && error.status === 400,
		);
		assert.throws(
			() => auth.verifyChallenge({ clientId: CLIENT_ID, challengeId: malformed.challengeId, signature: invalid }, ORIGIN),
			(error) => error instanceof DeviceAuthError && error.code === "invalid_challenge",
		);
		assert.throws(
			() => auth.createChallenge(CLIENT_ID, ORIGIN),
			(error) => error instanceof DeviceAuthError && error.status === 429,
		);
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

test("device records are private, persistent, and invalidated by master rotation", async () => {
	const temporary = temporaryStore();
	try {
		const identity = await signingIdentity();
		const first = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		first.pair({ clientId: CLIENT_ID, publicKeyJwk: identity.publicKeyJwk, label: "trusted browser" }, ORIGIN);
		assert.equal(statSync(path.dirname(temporary.file)).mode & 0o777, 0o700);
		assert.equal(statSync(temporary.file).mode & 0o777, 0o600);
		const persisted = JSON.parse(readFileSync(temporary.file, "utf8"));
		assert.equal(persisted.devices.length, 1);
		assert.equal(persisted.devices[0].origin, ORIGIN);
		assert.equal(persisted.devices[0].label, "trusted browser");
		assert.equal(persisted.devices[0].publicKeyJwk.crv, "P-256");
		assert.equal(persisted.devices[0].tokenGeneration, persisted.tokenGeneration);
		assert.equal(JSON.stringify(persisted).includes(MASTER), false);
		first.close();

		const restored = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		assert.deepEqual(restored.list().map((device) => device.clientId), [CLIENT_ID]);
		restored.close();

		const rotated = new TrustedBrowserAuth({ masterToken: "N".repeat(43), file: temporary.file });
		assert.deepEqual(rotated.list(), []);
		assert.equal(JSON.parse(readFileSync(temporary.file, "utf8")).devices.length, 0);
		rotated.close();
	} finally {
		temporary.cleanup();
	}
});

test("forget revokes sessions and closes their authenticated websocket", async () => {
	const temporary = temporaryStore();
	try {
		const identity = await signingIdentity();
		const auth = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		const paired = auth.pair({
			clientId: CLIENT_ID,
			publicKeyJwk: identity.publicKeyJwk,
			label: "browser",
		}, ORIGIN);
		const principal = auth.authenticateBearer(paired.accessToken, ORIGIN);
		const socket = new EventEmitter();
		socket.closeCalls = [];
		socket.close = (...args) => socket.closeCalls.push(args);
		auth.trackConnection(socket, principal);
		assert.equal(auth.revoke(CLIENT_ID), true);
		assert.equal(auth.authenticateBearer(paired.accessToken, ORIGIN), null);
		assert.deepEqual(socket.closeCalls, [[1008, "trusted browser revoked"]]);
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

test("pair publishes only after durable replacement and preserves the old live identity on EIO", async () => {
	const temporary = temporaryStore();
	try {
		const originalIdentity = await signingIdentity();
		const replacementIdentity = await signingIdentity();
		const auth = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		const original = auth.pair({
			clientId: CLIENT_ID,
			publicKeyJwk: originalIdentity.publicKeyJwk,
			label: "original browser",
		}, ORIGIN);
		const pending = auth.createChallenge(CLIENT_ID, ORIGIN);
		const principal = auth.authenticateBearer(original.accessToken, ORIGIN);
		const socket = new EventEmitter();
		socket.closeCalls = [];
		socket.close = (...args) => socket.closeCalls.push(args);
		auth.trackConnection(socket, principal);
		const diskBefore = readFileSync(temporary.file, "utf8");

		withRenameFailure((injected) => {
			assert.throws(
				() => auth.pair({
					clientId: CLIENT_ID,
					publicKeyJwk: replacementIdentity.publicKeyJwk,
					label: "replacement browser",
				}, ORIGIN),
				(error) => error === injected,
			);
		});

		assert.equal(readFileSync(temporary.file, "utf8"), diskBefore);
		assert.deepEqual(auth.list().map((device) => device.label), ["original browser"]);
		assert.equal(auth.authenticateBearer(original.accessToken, ORIGIN)?.clientId, CLIENT_ID);
		assert.deepEqual(socket.closeCalls, []);
		const signature = await signChallenge(originalIdentity.privateKey, pending.challenge);
		assert.equal(auth.verifyChallenge({
			clientId: CLIENT_ID,
			challengeId: pending.challengeId,
			signature,
		}, ORIGIN).clientId, CLIENT_ID);
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

test("revoke publishes only after durable replacement and rolls back every live capability on EIO", async () => {
	const temporary = temporaryStore();
	try {
		const identity = await signingIdentity();
		const auth = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		const paired = auth.pair({
			clientId: CLIENT_ID,
			publicKeyJwk: identity.publicKeyJwk,
			label: "durable browser",
		}, ORIGIN);
		const pending = auth.createChallenge(CLIENT_ID, ORIGIN);
		const principal = auth.authenticateBearer(paired.accessToken, ORIGIN);
		const socket = new EventEmitter();
		socket.closeCalls = [];
		socket.close = (...args) => socket.closeCalls.push(args);
		auth.trackConnection(socket, principal);
		const diskBefore = readFileSync(temporary.file, "utf8");

		withRenameFailure((injected) => {
			assert.throws(() => auth.revoke(CLIENT_ID), (error) => error === injected);
		});

		assert.equal(readFileSync(temporary.file, "utf8"), diskBefore);
		assert.deepEqual(auth.list().map((device) => device.clientId), [CLIENT_ID]);
		assert.equal(auth.authenticateBearer(paired.accessToken, ORIGIN)?.clientId, CLIENT_ID);
		assert.deepEqual(socket.closeCalls, []);
		const signature = await signChallenge(identity.privateKey, pending.challenge);
		assert.equal(auth.verifyChallenge({
			clientId: CLIENT_ID,
			challengeId: pending.challengeId,
			signature,
		}, ORIGIN).clientId, CLIENT_ID);
		const restarted = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		assert.deepEqual(restarted.list().map((device) => device.clientId), [CLIENT_ID]);
		restarted.close();
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

test("pair rolls the file back when directory fsync fails after rename", async () => {
	const temporary = temporaryStore();
	try {
		const originalIdentity = await signingIdentity();
		const replacementIdentity = await signingIdentity();
		const auth = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		const original = auth.pair({
			clientId: CLIENT_ID,
			publicKeyJwk: originalIdentity.publicKeyJwk,
			label: "original browser",
		}, ORIGIN);
		const pending = auth.createChallenge(CLIENT_ID, ORIGIN);
		const principal = auth.authenticateBearer(original.accessToken, ORIGIN);
		const socket = new EventEmitter();
		socket.closeCalls = [];
		socket.close = (...args) => socket.closeCalls.push(args);
		auth.trackConnection(socket, principal);
		const diskBefore = readFileSync(temporary.file, "utf8");

		withDirectoryFsyncFailure((injected) => {
			assert.throws(
				() => auth.pair({
					clientId: CLIENT_ID,
					publicKeyJwk: replacementIdentity.publicKeyJwk,
					label: "replacement browser",
				}, ORIGIN),
				(error) => error === injected,
			);
		});

		assert.equal(readFileSync(temporary.file, "utf8"), diskBefore);
		assert.deepEqual(auth.list().map((device) => device.label), ["original browser"]);
		assert.equal(auth.authenticateBearer(original.accessToken, ORIGIN)?.clientId, CLIENT_ID);
		assert.deepEqual(socket.closeCalls, []);
		const signature = await signChallenge(originalIdentity.privateKey, pending.challenge);
		assert.equal(auth.verifyChallenge({
			clientId: CLIENT_ID,
			challengeId: pending.challengeId,
			signature,
		}, ORIGIN).clientId, CLIENT_ID);
		const restarted = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		assert.deepEqual(restarted.list().map((device) => device.label), ["original browser"]);
		restarted.close();
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

test("revoke rolls the file back when directory fsync fails after rename", async () => {
	const temporary = temporaryStore();
	try {
		const identity = await signingIdentity();
		const auth = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		const paired = auth.pair({
			clientId: CLIENT_ID,
			publicKeyJwk: identity.publicKeyJwk,
			label: "durable browser",
		}, ORIGIN);
		const pending = auth.createChallenge(CLIENT_ID, ORIGIN);
		const principal = auth.authenticateBearer(paired.accessToken, ORIGIN);
		const socket = new EventEmitter();
		socket.closeCalls = [];
		socket.close = (...args) => socket.closeCalls.push(args);
		auth.trackConnection(socket, principal);
		const diskBefore = readFileSync(temporary.file, "utf8");

		withDirectoryFsyncFailure((injected) => {
			assert.throws(() => auth.revoke(CLIENT_ID), (error) => error === injected);
		});

		assert.equal(readFileSync(temporary.file, "utf8"), diskBefore);
		assert.deepEqual(auth.list().map((device) => device.clientId), [CLIENT_ID]);
		assert.equal(auth.authenticateBearer(paired.accessToken, ORIGIN)?.clientId, CLIENT_ID);
		assert.deepEqual(socket.closeCalls, []);
		const signature = await signChallenge(identity.privateKey, pending.challenge);
		assert.equal(auth.verifyChallenge({
			clientId: CLIENT_ID,
			challengeId: pending.challengeId,
			signature,
		}, ORIGIN).clientId, CLIENT_ID);
		const restarted = new TrustedBrowserAuth({ masterToken: MASTER, file: temporary.file });
		assert.deepEqual(restarted.list().map((device) => device.clientId), [CLIENT_ID]);
		restarted.close();
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

test("pair durably prunes expired devices before enforcing the device limit", async () => {
	const temporary = temporaryStore();
	let now = 1_000_000;
	try {
		const expiredIdentity = await signingIdentity();
		const replacementIdentity = await signingIdentity();
		const auth = new TrustedBrowserAuth({
			masterToken: MASTER,
			file: temporary.file,
			now: () => now,
			deviceTtlMs: 60_000,
			sessionTtlMs: 120_000,
			challengeTtlMs: 120_000,
			maxDevices: 1,
		});
		const expiredPair = auth.pair({
			clientId: CLIENT_ID,
			publicKeyJwk: expiredIdentity.publicKeyJwk,
			label: "expired browser",
		}, ORIGIN);
		const pending = auth.createChallenge(CLIENT_ID, ORIGIN);
		const pendingSignature = await signChallenge(expiredIdentity.privateKey, pending.challenge);
		const principal = auth.authenticateBearer(expiredPair.accessToken, ORIGIN);
		const socket = new EventEmitter();
		socket.closeCalls = [];
		socket.close = (...args) => socket.closeCalls.push(args);
		auth.trackConnection(socket, principal);

		now += 60_001;
		const replacementPair = auth.pair({
			clientId: SECOND_CLIENT_ID,
			publicKeyJwk: replacementIdentity.publicKeyJwk,
			label: "replacement browser",
		}, ORIGIN);

		assert.equal(replacementPair.clientId, SECOND_CLIENT_ID);
		assert.deepEqual(auth.list().map((device) => device.clientId), [SECOND_CLIENT_ID]);
		assert.deepEqual(
			JSON.parse(readFileSync(temporary.file, "utf8")).devices.map((device) => device.clientId),
			[SECOND_CLIENT_ID],
		);
		assert.deepEqual(socket.closeCalls, [[1008, "authentication expired"]]);
		assert.equal(auth.authenticateBearer(expiredPair.accessToken, ORIGIN), null);
		assert.throws(
			() => auth.verifyChallenge({
				clientId: CLIENT_ID,
				challengeId: pending.challengeId,
				signature: pendingSignature,
			}, ORIGIN),
			(error) => error instanceof DeviceAuthError && error.code === "invalid_challenge",
		);
		const restarted = new TrustedBrowserAuth({
			masterToken: MASTER,
			file: temporary.file,
			now: () => now,
			maxDevices: 1,
		});
		assert.deepEqual(restarted.list().map((device) => device.clientId), [SECOND_CLIENT_ID]);
		restarted.close();
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

test("device expiry caps the short bearer and authenticated websocket lifetime", async (t) => {
	const temporary = temporaryStore();
	try {
		const identity = await signingIdentity();
		// Pairing performs durable writes; wall-clock 25 ms can elapse during
		// fsync under parallel test load before a session even gets issued.
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
		const auth = new TrustedBrowserAuth({
			masterToken: MASTER,
			file: temporary.file,
			deviceTtlMs: 25,
			sessionTtlMs: 1_000,
		});
		const paired = auth.pair({
			clientId: CLIENT_ID,
			publicKeyJwk: identity.publicKeyJwk,
			label: "browser",
		}, ORIGIN);
		assert.equal(paired.expiresAt, paired.deviceExpiresAt);
		const principal = websocketRequestPrincipal({
			socket: { remoteAddress: "127.0.0.1" },
			headers: {
				host: "127.0.0.1:3000",
				origin: ORIGIN,
				"sec-websocket-protocol": `sched-auth, ${paired.accessToken}`,
			},
		}, auth);
		assert.equal(principal?.clientId, CLIENT_ID);
		const socket = new EventEmitter();
		let didClose = false;
		const closed = new Promise((resolve) => {
			socket.close = (...args) => { didClose = true; resolve(args); };
		});
		auth.trackConnection(socket, principal);
		t.mock.timers.tick(24);
		assert.equal(didClose, false);
		t.mock.timers.tick(1);
		assert.deepEqual(await closed, [1008, "authentication expired"]);
		assert.equal(auth.authenticateBearer(paired.accessToken, ORIGIN), null);
		auth.close();
	} finally {
		temporary.cleanup();
	}
});

function responseRecorder() {
	return {
		status: undefined,
		headers: undefined,
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(body = "") { this.body += String(body); },
	};
}

function requestFor(url, options = {}) {
	const { method = "POST", authorization, body } = options;
	const origin = Object.hasOwn(options, "origin") ? options.origin : ORIGIN;
	const headers = { host: "127.0.0.1:3000" };
	if (origin !== undefined) headers.origin = origin;
	if (authorization !== undefined) headers.authorization = authorization;
	return {
		method,
		url,
		headers,
		socket: { remoteAddress: "127.0.0.1", encrypted: false },
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(JSON.stringify(body));
		},
	};
}

class FakeChild extends EventEmitter {
	constructor(stdout) {
		super();
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.stdin = { end() {} };
		this.stdoutText = stdout;
	}
	kill() { return true; }
}

class FakeWebSocket extends EventEmitter {
	constructor() {
		super();
		this.OPEN = 1;
		this.CLOSED = 3;
		this.readyState = this.OPEN;
		this.bufferedAmount = 0;
		this.sent = [];
		this.closeCalls = [];
	}
	send(value) {
		if (this.readyState !== this.OPEN) throw new Error("websocket is closed");
		this.sent.push(String(value));
	}
	close(code, reason) {
		if (this.readyState === this.CLOSED) return;
		this.closeCalls.push([code, reason]);
		this.readyState = this.CLOSED;
		this.emit("close", code, reason);
	}
}

async function withStubbedWebSocketUpgrade(operation) {
	const originalHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
	const originalOpenShell = SshEngine.prototype.openShell;
	WebSocketServer.prototype.handleUpgrade = function handleUpgrade(_req, socket, _head, done) {
		assert.ok(socket.webSocket, "upgrade harness requires a websocket double");
		done(socket.webSocket);
	};
	SshEngine.prototype.openShell = async function openShell(_alias, _size, { signal } = {}) {
		return new Promise((_resolve, reject) => {
			const abort = () => reject(signal?.reason ?? new Error("terminal open aborted"));
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
	};
	try {
		return await operation();
	} finally {
		WebSocketServer.prototype.handleUpgrade = originalHandleUpgrade;
		SshEngine.prototype.openShell = originalOpenShell;
	}
}

async function withAuthRoutes(callback) {
	const home = mkdtempSync(path.join(tmpdir(), "nodesched-auth-routes-"));
	const previousHome = process.env.HOME;
	const previousSpawn = cp.spawn;
	const routes = [];
	const upgrades = [];
	let dispose;
	let disposed = false;
	process.env.HOME = home;
	cp.spawn = (_command, args) => {
		const remote = String(args.at(-1));
		const status = {
			schema_version: 1,
			limit: 200,
			truncated: { batches: false, jobs: false },
			next_cursor: null,
			next_job_cursor: null,
			daemon_health: {},
			cpu: { used: 0, total: 0 },
			batches: [], jobs: [], gpus: [],
		};
		const stdout = remote.includes(" status --json") ? `${JSON.stringify(status)}\n` : "ok\n";
		const child = new FakeChild(stdout);
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from(stdout));
			child.emit("close", 0);
		});
		return child;
	};
	try {
		dispose = apply({
			logger: { info() {}, warn() {}, error() {} },
			systemPrompt: { section() {} },
			tools: { register() { return () => {}; } },
			webServer: {
				register(route) { routes.push(route); return () => {}; },
				registerUpgrade(route) { upgrades.push(route); return () => {}; },
			},
		}, {
			sshEntry: "gateway",
			schedBin: "/opt/sched",
			probeCommand: "daemon status",
			connectTimeoutSec: 1,
			pollFallbackSec: 3_600,
			transport: "auto",
			mutationMode: "disabled",
			mutationTarget: "",
			mutationSession: "",
			mutationExpectedNode: "",
		});
		const master = readFileSync(path.join(home, ".dsh", "node-sched-access-token"), "utf8").trim();
		const request = async (url, options = {}) => {
			const pathname = new URL(url, "http://x").pathname;
			const route = routes
				.filter((candidate) => pathname.startsWith(candidate.path))
				.sort((left, right) => right.path.length - left.path.length)[0];
			assert.ok(route, `missing route for ${url}`);
			const response = responseRecorder();
			await route.handler(requestFor(url, options), response);
			return {
				status: response.status,
				body: response.body ? JSON.parse(response.body) : undefined,
			};
			};
		const upgrade = (url, { token, origin = ORIGIN, webSocket } = {}) => {
			const pathname = new URL(url, "http://x").pathname;
			const route = upgrades.find((candidate) => candidate.path === pathname);
			assert.ok(route, `missing upgrade route for ${url}`);
			const req = requestFor(url, { method: "GET", origin });
			req.headers["sec-websocket-protocol"] = `sched-auth, ${token}`;
			const socket = new EventEmitter();
			socket.destroyed = false;
			socket.webSocket = webSocket;
			socket.destroy = () => { socket.destroyed = true; };
			route.handler(req, socket, Buffer.alloc(0));
			return socket;
		};
		const disposeNow = () => {
			if (disposed) return;
			disposed = true;
			dispose?.();
		};
		await callback({ request, master, upgrade, dispose: disposeNow });
	} finally {
		if (!disposed) dispose?.();
		cp.spawn = previousSpawn;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
}

test("auth HTTP contract pairs, verifies, authorizes GET without Origin, and forgets", async () => {
	await withAuthRoutes(async ({ request, master }) => {
		const identity = await signingIdentity();
		const pairPath = "/sched/api/auth/pair";
		const missingMaster = await request(pairPath, {
			body: { clientId: CLIENT_ID, publicKeyJwk: identity.publicKeyJwk, label: "browser" },
		});
		assert.equal(missingMaster.status, 401);
		const paired = await request(pairPath, {
			authorization: `Bearer ${master}`,
			body: { clientId: CLIENT_ID, publicKeyJwk: identity.publicKeyJwk, label: "browser" },
		});
		assert.equal(paired.status, 200);
		assert.equal(paired.body.ok, true);
		assert.match(paired.body.accessToken, /^[A-Za-z0-9_-]{43}$/);

		const status = await request("/sched/api/status", {
			method: "GET",
			origin: undefined,
			authorization: `Bearer ${paired.body.accessToken}`,
		});
		assert.notEqual(status.status, 401);

		const challenge = await request("/sched/api/auth/challenge", {
			body: { clientId: CLIENT_ID },
		});
		assert.equal(challenge.status, 200);
		const signature = await signChallenge(identity.privateKey, challenge.body.challenge);
		const verified = await request("/sched/api/auth/verify", {
			body: { clientId: CLIENT_ID, challengeId: challenge.body.challengeId, signature },
		});
		assert.equal(verified.status, 200);
		assert.equal(verified.body.clientId, CLIENT_ID);

		const unknownPath = await request("/sched/api/auth/challenge/extra", {
			body: { clientId: CLIENT_ID },
		});
		assert.equal(unknownPath.status, 404);

		const forbiddenForget = await request("/sched/api/auth/forget", {
			authorization: `Bearer ${verified.body.accessToken}`,
			body: { clientId: "another_browser_0001" },
		});
		assert.equal(forbiddenForget.status, 403);
		const forgotten = await request("/sched/api/auth/forget", {
			authorization: `Bearer ${verified.body.accessToken}`,
			body: { clientId: CLIENT_ID },
		});
		assert.equal(forgotten.status, 200);
		assert.equal(forgotten.body.removed, true);
		const rejected = await request("/sched/api/status", {
			method: "GET",
			origin: undefined,
			authorization: `Bearer ${verified.body.accessToken}`,
		});
		assert.equal(rejected.status, 401);
	});
});

test("auth session, me, and list enforce POST, exact Origin, and principal scope", async () => {
	await withAuthRoutes(async ({ request, master }) => {
		const identity = await signingIdentity();
		const paired = await request("/sched/api/auth/pair", {
			authorization: `Bearer ${master}`,
			body: {
				clientId: CLIENT_ID,
				publicKeyJwk: identity.publicKeyJwk,
				label: "matrix browser",
			},
		});
		assert.equal(paired.status, 200);
		const trustedSession = paired.body.accessToken;

		for (const pathname of [
			"/sched/api/auth/session",
			"/sched/api/auth/me",
			"/sched/api/auth/list",
		]) {
			const wrongMethod = await request(pathname, {
				method: "GET",
				authorization: `Bearer ${master}`,
			});
			assert.equal(wrongMethod.status, 405, `${pathname} must reject GET`);

			const missingOrigin = await request(pathname, {
				origin: undefined,
				authorization: `Bearer ${master}`,
				body: {},
			});
			assert.equal(missingOrigin.status, 403, `${pathname} must require Origin`);

			const foreignOrigin = await request(pathname, {
				origin: "http://localhost:3000",
				authorization: `Bearer ${master}`,
				body: {},
			});
			assert.equal(foreignOrigin.status, 403, `${pathname} must require exact Origin/Host`);
		}

		const sessionWithoutBearer = await request("/sched/api/auth/session", { body: {} });
		assert.equal(sessionWithoutBearer.status, 401);
		const sessionFromShortBearer = await request("/sched/api/auth/session", {
			authorization: `Bearer ${trustedSession}`,
			body: {},
		});
		assert.equal(sessionFromShortBearer.status, 401);
		const ephemeral = await request("/sched/api/auth/session", {
			authorization: `Bearer ${master}`,
			body: {},
		});
		assert.equal(ephemeral.status, 200);
		assert.equal(ephemeral.body.ok, true);
		assert.equal(ephemeral.body.clientId, null);
		assert.match(ephemeral.body.accessToken, /^[A-Za-z0-9_-]{43}$/);

		const pairFromShortBearer = await request("/sched/api/auth/pair", {
			authorization: `Bearer ${ephemeral.body.accessToken}`,
			body: {
				clientId: "another_browser_0001",
				publicKeyJwk: identity.publicKeyJwk,
				label: "must not pair",
			},
		});
		assert.equal(pairFromShortBearer.status, 401);

		const meWithoutBearer = await request("/sched/api/auth/me", { body: {} });
		assert.equal(meWithoutBearer.status, 401);
		const masterMe = await request("/sched/api/auth/me", {
			authorization: `Bearer ${master}`,
			body: {},
		});
		assert.deepEqual(masterMe.body, {
			ok: true,
			kind: "master",
			clientId: null,
			expiresAt: null,
		});
		const ephemeralMe = await request("/sched/api/auth/me", {
			authorization: `Bearer ${ephemeral.body.accessToken}`,
			body: {},
		});
		assert.equal(ephemeralMe.status, 200);
		assert.equal(ephemeralMe.body.kind, "session");
		assert.equal(ephemeralMe.body.clientId, null);
		assert.equal(ephemeralMe.body.expiresAt, ephemeral.body.expiresAt);
		const trustedMe = await request("/sched/api/auth/me", {
			authorization: `Bearer ${trustedSession}`,
			body: {},
		});
		assert.equal(trustedMe.status, 200);
		assert.equal(trustedMe.body.kind, "session");
		assert.equal(trustedMe.body.clientId, CLIENT_ID);

		const listWithoutBearer = await request("/sched/api/auth/list", { body: {} });
		assert.equal(listWithoutBearer.status, 401);
		for (const bearer of [master, ephemeral.body.accessToken, trustedSession]) {
			const listed = await request("/sched/api/auth/list", {
				authorization: `Bearer ${bearer}`,
				body: {},
			});
			assert.equal(listed.status, 200);
			assert.deepEqual(listed.body.devices.map((device) => device.clientId), [CLIENT_ID]);
			assert.equal(Object.hasOwn(listed.body.devices[0], "publicKeyJwk"), false);
		}
	});
});

test("both registered websocket upgrades track a trusted session through revocation", async () => {
	await withStubbedWebSocketUpgrade(async () => {
		await withAuthRoutes(async ({ request, master, upgrade }) => {
			const identity = await signingIdentity();
			const paired = await request("/sched/api/auth/pair", {
				authorization: `Bearer ${master}`,
				body: {
					clientId: CLIENT_ID,
					publicKeyJwk: identity.publicKeyJwk,
					label: "websocket browser",
				},
			});
			assert.equal(paired.status, 200);

			const rejectedSocket = new FakeWebSocket();
			const rejectedUpgrade = upgrade("/sched/ws/events", {
				token: "x".repeat(43),
				webSocket: rejectedSocket,
			});
			assert.equal(rejectedUpgrade.destroyed, true);
			assert.deepEqual(rejectedSocket.closeCalls, []);

			const eventSocket = new FakeWebSocket();
			const eventUpgrade = upgrade("/sched/ws/events", {
				token: paired.body.accessToken,
				webSocket: eventSocket,
			});
			assert.equal(eventUpgrade.destroyed, false);
			const terminalSocket = new FakeWebSocket();
			const terminalUpgrade = upgrade("/sched/ws/ssh-terminal?alias=test", {
				token: paired.body.accessToken,
				webSocket: terminalSocket,
			});
			assert.equal(terminalUpgrade.destroyed, false);

			const forgotten = await request("/sched/api/auth/forget", {
				authorization: `Bearer ${paired.body.accessToken}`,
				body: { clientId: CLIENT_ID },
			});
			assert.equal(forgotten.status, 200);
			assert.equal(forgotten.body.removed, true);
			assert.deepEqual(eventSocket.closeCalls, [[1008, "trusted browser revoked"]]);
			assert.deepEqual(terminalSocket.closeCalls, [[1008, "trusted browser revoked"]]);
			await new Promise((resolve) => setImmediate(resolve));
		});
	});
});

test("plugin disposal closes both registered websocket types", async () => {
	await withStubbedWebSocketUpgrade(async () => {
		await withAuthRoutes(async ({ request, master, upgrade, dispose }) => {
			const identity = await signingIdentity();
			const paired = await request("/sched/api/auth/pair", {
				authorization: `Bearer ${master}`,
				body: {
					clientId: CLIENT_ID,
					publicKeyJwk: identity.publicKeyJwk,
					label: "dispose browser",
				},
			});
			assert.equal(paired.status, 200);

			const eventSocket = new FakeWebSocket();
			upgrade("/sched/ws/events", {
				token: paired.body.accessToken,
				webSocket: eventSocket,
			});
			const terminalSocket = new FakeWebSocket();
			upgrade("/sched/ws/ssh-terminal?alias=test", {
				token: paired.body.accessToken,
				webSocket: terminalSocket,
			});

			dispose();
			assert.deepEqual(eventSocket.closeCalls, [[1001, "node-sched disposed"]]);
			assert.deepEqual(terminalSocket.closeCalls, [[1001, "node-sched disposed"]]);
			await new Promise((resolve) => setImmediate(resolve));
		});
	});
});
