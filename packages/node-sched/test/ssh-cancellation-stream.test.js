import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import ssh2 from "ssh2";
import { SshEngine, openExecStream } from "../lib/ssh-engine.js";

const { Client } = ssh2;
const entry = {
	alias: "compute", host: "compute.invalid", port: 22, user: "runner",
	hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	auth: { kind: "password", password: "test-only" }, proxyJump: [],
};

function engineFor(t) {
	const engine = new SshEngine({ find: (alias) => alias === entry.alias ? entry : undefined }, {
		connectTimeoutMs: 1_000, interactiveAuthTimeoutMs: 1_000, defaultExecTimeoutMs: 1_000,
	});
	t.after(() => engine.dispose());
	return engine;
}

function channel() {
	const stream = new EventEmitter();
	stream.stderr = new EventEmitter();
	stream.closeCalls = 0;
	stream.close = () => { stream.closeCalls += 1; stream.emit("close"); };
	stream.end = () => {};
	return stream;
}

function existingPool(engine, onExec = (_command, callback) => callback(null, channel())) {
	const client = new EventEmitter();
	client.endCalls = 0;
	client.end = () => { client.endCalls += 1; client.emit("close"); };
	client.exec = onExec;
	const record = {
		client, hops: [], inFlight: 0, idleAt: Date.now(), pinned: false,
		broken: false, disposed: false, closed: false,
	};
	client.on("error", () => { record.broken = true; });
	client.on("close", () => { record.broken = true; });
	engine.pool.set(entry.alias, record);
	return record;
}

for (const state of ["cancelled", "expired"]) {
	test(`interactive ${state} is never retried or reopened by subsequent polling`, async (t) => {
		const engine = engineFor(t);
		let connects = 0;
		let prompts = 0;
		t.mock.method(Client.prototype, "connect", function () {
			connects += 1;
			queueMicrotask(() => this.emit("keyboard-interactive", "", "", "", [{ prompt: "OTP", echo: false }], () => {
				assert.fail("cancelled/expired credentials must never be submitted");
			}));
			return this;
		});
		t.mock.method(Client.prototype, "destroy", function () { return this; });
		t.mock.method(Client.prototype, "end", function () { return this; });
		engine.setInteractivePrompter(async () => { prompts += 1; return { state }; });
		const code = state === "cancelled" ? "SSH_INTERACTIVE_AUTH_CANCELLED" : "SSH_INTERACTIVE_AUTH_DEADLINE";
		await assert.rejects(engine.execRetryable(entry.alias, "true", 1_000), { code });
		assert.equal(prompts, 1);
		assert.equal(connects, 1);
		await assert.rejects(engine.execRetryable(entry.alias, "true", 1_000), { code: "SSH_AUTH_BLOCKED" });
		assert.equal(prompts, 1);
		assert.equal(connects, 1);
		const explicitTest = await engine.test(entry.alias);
		assert.equal(explicitTest.ok, false);
		assert.equal(prompts, 2, "only an explicit test resumes authentication");
		assert.equal(connects, 2);
		assert.equal(engine.operationControllers.size, 0);
	});
}

for (const action of ["dropAlias", "dispose"]) {
	test(`${action} prevents a pending retryable query from reconnecting an invalidated alias`, async (t) => {
		const engine = engineFor(t);
		let connects = 0;
		t.mock.method(Client.prototype, "connect", function () { connects += 1; return this; });
		t.mock.method(Client.prototype, "destroy", function () { return this; });
		t.mock.method(Client.prototype, "end", function () { return this; });
		const pending = engine.execRetryable(entry.alias, "true", 1_000);
		const rejected = assert.rejects(pending, {
			code: action === "dropAlias" ? "SSH_ALIAS_INVALIDATED" : "SSH_ENGINE_DISPOSED",
		});
		engine[action](entry.alias);
		await rejected;
		assert.equal(connects, 1);
		assert.equal(engine.acquireQueue.size, 0);
		assert.equal(engine.operationControllers.size, 0);
	});
}

test("dropAlias cancels an already-open command and does not replay it", async (t) => {
	const engine = engineFor(t);
	const stream = channel();
	let opened;
	const ready = new Promise((resolve) => { opened = resolve; });
	const record = existingPool(engine, (_command, callback) => { callback(null, stream); opened(); });
	const pending = engine.execRetryable(entry.alias, "true", 1_000);
	const rejected = assert.rejects(pending, { code: "SSH_ALIAS_INVALIDATED" });
	await ready;
	engine.dropAlias(entry.alias);
	await rejected;
	assert.equal(stream.closeCalls, 1);
	assert.equal(record.inFlight, 0);
	assert.equal(record.client.endCalls, 1);
	assert.equal(engine.pool.size, 0);
});

test("existing-only streams and queries fail fast without a connection or auth prompt", async (t) => {
	const engine = engineFor(t);
	let prompts = 0;
	engine.setInteractivePrompter(async () => { prompts += 1; return { state: "cancelled" }; });
	t.mock.method(Client.prototype, "connect", () => assert.fail("background operation must not connect"));
	await assert.rejects(openExecStream(engine, entry.alias, "tail -f events", {
		requireExistingConnection: true, interactiveAuth: false,
	}), { code: "SSH_NO_EXISTING_CONNECTION" });
	await assert.rejects(engine.execRetryable(entry.alias, "hostname", 1_000, {
		requireExistingConnection: true, interactiveAuth: false,
	}), { code: "SSH_NO_EXISTING_CONNECTION" });
	assert.equal(prompts, 0);
	assert.equal(engine.operationControllers.size, 0);
});

test("pooled stream holds a channel lease and closes only its channel", async (t) => {
	const engine = engineFor(t);
	const stream = channel();
	const record = existingPool(engine, (_command, callback) => callback(null, stream));
	t.mock.method(Client.prototype, "connect", () => assert.fail("stream must reuse authenticated client"));
	const session = await openExecStream(engine, entry.alias, "tail -f events", { requireExistingConnection: true });
	assert.equal(record.inFlight, 1);
	const data = [];
	const closed = [];
	session.onData = (chunk) => data.push(String(chunk));
	session.onClose = (error) => closed.push(error);
	stream.emit("data", Buffer.from("event\n"));
	session.close();
	session.close();
	assert.deepEqual(data, ["event\n"]);
	assert.deepEqual(closed, [undefined]);
	assert.equal(stream.closeCalls, 1);
	assert.equal(record.inFlight, 0);
	assert.equal(record.client.endCalls, 0);
	assert.equal(engine.pool.get(entry.alias), record);
	assert.equal(engine.operationControllers.size, 0);
});

for (const terminal of ["close", "error", "abort", "dispose"]) {
	test(`pooled stream releases exactly once on ${terminal}`, async (t) => {
		const engine = engineFor(t);
		const controller = new AbortController();
		const stream = channel();
		const record = existingPool(engine, (_command, callback) => callback(null, stream));
		const session = await openExecStream(engine, entry.alias, "tail -f events", {
			requireExistingConnection: true, signal: controller.signal,
		});
		let count = 0;
		session.onClose = () => { count += 1; };
		if (terminal === "abort") controller.abort();
		else if (terminal === "dispose") engine.dispose();
		else stream.emit(terminal, terminal === "error" ? new Error("stream failed") : undefined);
		session.close();
		assert.equal(count, 1);
		assert.equal(record.inFlight, 0);
		assert.equal(record.client.endCalls, terminal === "dispose" ? 1 : 0);
		assert.equal(engine.operationControllers.size, 0);
	});
}

test("pooled stream open failures release the lease without closing the shared connection", async (t) => {
	const engine = engineFor(t);
	const record = existingPool(engine, (_command, callback) => callback(new Error("channel refused")));
	await assert.rejects(openExecStream(engine, entry.alias, "tail", { requireExistingConnection: true }), /channel refused/);
	assert.equal(record.inFlight, 0);
	assert.equal(record.client.endCalls, 0);
	assert.equal(engine.operationControllers.size, 0);
});

test("aborting pending pooled channel open releases the lease and closes a late channel", async (t) => {
	const engine = engineFor(t);
	const controller = new AbortController();
	let openCallback;
	let opened;
	const ready = new Promise((resolve) => { opened = resolve; });
	const record = existingPool(engine, (_command, callback) => { openCallback = callback; opened(); });
	const pending = openExecStream(engine, entry.alias, "tail", { requireExistingConnection: true, signal: controller.signal });
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await ready;
	controller.abort();
	await rejected;
	const late = channel();
	openCallback(null, late);
	assert.equal(late.closeCalls, 1);
	assert.equal(record.inFlight, 0);
	assert.equal(record.client.endCalls, 0);
	assert.equal(engine.operationControllers.size, 0);
});
