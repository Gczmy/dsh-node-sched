import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const INDEX = "../lib/index.js";
const SSH_ENGINE = "../lib/ssh-engine.js";
const OUTPUT_LIMIT = "../lib/output-limit.js";

async function exported(modulePath, name) {
	const module = await import(modulePath);
	assert.equal(typeof module[name], "function", `${name} must be an exported function`);
	return module[name];
}

class FakeClock {
	constructor() {
		this.nowMs = 0;
		this.nextId = 1;
		this.timers = new Map();
	}

	now = () => this.nowMs;

	setTimeout = (callback, delay) => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowMs + delay, callback });
		return id;
	};

	clearTimeout = (id) => {
		this.timers.delete(id);
	};

	advance(milliseconds) {
		const target = this.nowMs + milliseconds;
		while (true) {
			let selected;
			for (const [id, timer] of this.timers) {
				if (timer.at > target) continue;
				if (!selected || timer.at < selected.timer.at || (timer.at === selected.timer.at && id < selected.id)) {
					selected = { id, timer };
				}
			}
			if (!selected) break;
			this.timers.delete(selected.id);
			this.nowMs = selected.timer.at;
			selected.timer.callback();
		}
		this.nowMs = target;
	}
}

function authEvent(events, method) {
	const event = events.find((candidate) => candidate.type === "auth" && candidate.method === method && candidate.state === undefined);
	assert.ok(event, `missing ${method} auth event`);
	assert.equal(typeof event.id, "string");
	return event;
}

function makeExecHarness({ broken = false, onExec }) {
	const stream = new EventEmitter();
	stream.stderr = new EventEmitter();
	stream.signal = () => {};
	stream.close = () => {};
	stream.end = () => {};
	const client = {
		execCalls: 0,
		endCalls: 0,
		exec(_command, callback) {
			this.execCalls += 1;
			callback(null, stream);
			onExec?.({ stream, client: this });
		},
		end() { this.endCalls += 1; },
	};
	const record = {
		client,
		hops: [],
		idleAt: 0,
		pinned: false,
		broken,
		inFlight: 0,
		disposed: false,
		closed: false,
	};
	const engine = {
		opts: { defaultExecTimeoutMs: 1_000, maxOutputBytes: 4, idleTimeoutMs: 60_000 },
		pool: new Map([["compute", record]]),
		acquireQueue: new Map(),
		aliasGeneration: new Map(),
		acquireActive: new Map(),
		disposed: false,
		store: { find() { throw new Error("unexpected reconnect"); } },
	};
	return { engine, client, stream, record };
}

async function createBroker({ visible = true, timeoutMs = 180_000 } = {}) {
	const AuthChallengeBroker = await exported(INDEX, "AuthChallengeBroker");
	const clock = new FakeClock();
	const events = [];
	const broker = new AuthChallengeBroker({
		timeoutMs,
		clock,
		hasVisibleAudience: () => visible,
		broadcast: (event) => events.push(event),
	});
	return { broker, clock, events };
}

async function flushMicrotasks() {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function terminalAuthEvents(events, id) {
	return events.filter((event) =>
		event.type === "auth"
		&& event.id === id
		&& ["resolved", "expired", "cancelled"].includes(event.state));
}

async function createInteractiveClientHarness(t, { broker, clock }) {
	const [{ Client }, execCommand] = await Promise.all([
		import("ssh2"),
		exported(SSH_ENGINE, "execCommand"),
	]);
	const originalConnect = Client.prototype.connect;
	const originalDestroy = Client.prototype.destroy;
	const originalEnd = Client.prototype.end;
	const clients = [];
	Client.prototype.connect = function connect(config) {
		this.testConfig = config;
		this.destroyCalls = 0;
		this.endCalls = 0;
		clients.push(this);
		return this;
	};
	Client.prototype.destroy = function destroy() {
		this.destroyCalls += 1;
		return this;
	};
	Client.prototype.end = function end() {
		this.endCalls += 1;
		return this;
	};
	t.after(() => {
		Client.prototype.connect = originalConnect;
		Client.prototype.destroy = originalDestroy;
		Client.prototype.end = originalEnd;
	});

	const entry = {
		alias: "compute",
		host: "compute.invalid",
		hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		port: 22,
		user: "runner",
		auth: { kind: "password", password: "secret" },
		proxyJump: [],
	};
	const engine = {
		store: { find: (alias) => alias === entry.alias ? entry : undefined },
		opts: {
			defaultExecTimeoutMs: 1_000,
			idleTimeoutMs: 60_000,
			interactiveAuthTimeoutMs: 180_000,
			maxOutputBytes: 1_024,
			clock,
		},
		interactivePrompter: (request) => broker.request(request),
		pool: new Map(),
		acquireQueue: new Map(),
		aliasGeneration: new Map(),
		acquireActive: new Map(),
		disposed: false,
	};
	const operation = execCommand(engine, entry.alias, "true", 1_000);
	const outcome = operation.then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, error }),
	);
	assert.equal(clients.length, 1);
	return { client: clients[0], outcome };
}

async function assertAuthConnectionFailed(outcome, pattern) {
	const result = await outcome;
	assert.equal(result.ok, false, "authentication termination must reject the SSH operation");
	assert.match(String(result.error?.message ?? result.error), pattern);
}

test("D-M03 generic SSH exec uses one channel attempt and no fallback", async () => {
	const executeGenericSsh = await exported(INDEX, "executeGenericSsh");
	const calls = [];
	const engine = {
		exec() { calls.push("retrying-exec"); throw new Error("must not retry"); },
		execOnce(alias, command, timeoutMs) {
			calls.push(["exec-once", alias, command, timeoutMs]);
			return Promise.resolve({ success: true, exitCode: 0, stdout: "ok", stderr: "" });
		},
	};
	const result = await executeGenericSsh(engine, "compute", "touch marker", { timeoutMs: 5_000 });
	assert.deepEqual(calls, [["exec-once", "compute", "touch marker", 5_000]]);
	assert.equal(result.success, true);
});

test("D-M03 ambiguous channel close reports the first outcome without reconnecting", async () => {
	const { execCommand } = await import(SSH_ENGINE);
	assert.equal(typeof execCommand, "function");
	const { engine, client, record } = makeExecHarness({
		onExec({ stream }) {
			queueMicrotask(() => {
				record.broken = true;
				stream.emit("close");
			});
		},
	});
	await assert.rejects(
		execCommand(engine, "compute", "touch marker", 1_000),
		/closed without an exit status|unknown outcome/i,
	);
	assert.equal(client.execCalls, 1);
});

test("D-M06 keyboard-interactive remains answerable after the 15 second handshake window", async () => {
	const { broker, clock, events } = await createBroker();
	const pending = broker.request({
		alias: "compute",
		method: "keyboard-interactive",
		prompts: [{ prompt: "OTP", echo: false }],
	});
	const event = authEvent(events, "keyboard-interactive");
	clock.advance(20_000);
	broker.answer(event.id, ["123456"]);
	assert.deepEqual(await pending, { state: "answered", answers: ["123456"] });
	assert.ok(events.some((candidate) => candidate.id === event.id && candidate.state === "resolved"));
});

test("D-M06 private-key passphrase has a deadline independent from keyboard-interactive", async () => {
	const { broker, clock, events } = await createBroker();
	const keyboard = broker.request({
		alias: "compute",
		method: "keyboard-interactive",
		prompts: [{ prompt: "OTP", echo: false }],
	});
	const passphrase = broker.request({
		alias: "compute",
		method: "private-key-passphrase",
		prompts: [{ prompt: "Private key passphrase", echo: false }],
	});
	const keyboardEvent = authEvent(events, "keyboard-interactive");
	const passphraseEvent = authEvent(events, "private-key-passphrase");
	broker.cancel(keyboardEvent.id);
	clock.advance(20_000);
	broker.answer(passphraseEvent.id, ["key-secret"]);
	assert.deepEqual(await keyboard, { state: "cancelled" });
	assert.deepEqual(await passphrase, { state: "answered", answers: ["key-secret"] });
});

test("D-M06 a connected but hidden panel is not an interactive auth audience", async () => {
	const { broker, events } = await createBroker({ visible: false });
	await assert.rejects(
		broker.request({
			alias: "compute",
			method: "keyboard-interactive",
			prompts: [{ prompt: "OTP", echo: false }],
		}),
		/visible|audience|dashboard|panel/i,
	);
	assert.deepEqual(events, []);
});

test("D-M07 disconnect preserves a challenge for replay and later answer", async () => {
	const { broker, events } = await createBroker();
	let settled = false;
	const pending = broker.request({
		alias: "compute",
		method: "keyboard-interactive",
		prompts: [{ prompt: "OTP", echo: false }],
	}).then((answers) => { settled = true; return answers; });
	const event = authEvent(events, "keyboard-interactive");
	broker.audienceDisconnected();
	await Promise.resolve();
	assert.equal(settled, false);
	const replayed = [];
	broker.replay((frame) => replayed.push(frame));
	assert.ok(replayed.some((frame) => frame.id === event.id && frame.type === "auth"));
	broker.answer(event.id, ["654321"]);
	assert.deepEqual(await pending, { state: "answered", answers: ["654321"] });
});

test("D-M07 answer broadcasts a resolved terminal state by challenge id", async () => {
	const { broker, events } = await createBroker();
	const pending = broker.request({ alias: "compute", method: "keyboard-interactive", prompts: [{ prompt: "OTP" }] });
	const event = authEvent(events, "keyboard-interactive");
	broker.answer(event.id, ["answer"]);
	await pending;
	assert.ok(events.some((candidate) => candidate.id === event.id && candidate.state === "resolved"));
});

test("D-M07 timeout broadcasts an expired terminal state by challenge id", async () => {
	const { broker, clock, events } = await createBroker({ timeoutMs: 180_000 });
	const pending = broker.request({ alias: "compute", method: "keyboard-interactive", prompts: [{ prompt: "OTP" }] });
	const event = authEvent(events, "keyboard-interactive");
	clock.advance(180_000);
	assert.deepEqual(await pending, { state: "expired" });
	assert.ok(events.some((candidate) => candidate.id === event.id && candidate.state === "expired"));
});

test("D-M07 cancellation broadcasts a cancelled terminal state by challenge id", async () => {
	const { broker, events } = await createBroker();
	const pending = broker.request({ alias: "compute", method: "private-key-passphrase", prompts: [{ prompt: "Passphrase" }] });
	const event = authEvent(events, "private-key-passphrase");
	broker.cancel(event.id);
	assert.deepEqual(await pending, { state: "cancelled" });
	assert.ok(events.some((candidate) => candidate.id === event.id && candidate.state === "cancelled"));
});

test("D-M08 zero-prompt keyboard-interactive submits and resolves with []", async () => {
	const { broker, events } = await createBroker();
	const pending = broker.request({ alias: "compute", method: "keyboard-interactive", prompts: [] });
	const event = authEvent(events, "keyboard-interactive");
	assert.deepEqual(event.prompts, []);
	broker.answer(event.id, []);
	assert.deepEqual(await pending, { state: "answered", answers: [] });
	assert.ok(events.some((candidate) => candidate.id === event.id && candidate.state === "resolved"));
});

test("D-M08 cancelling a zero-prompt challenge aborts SSH without submitting empty answers", async (t) => {
	const { broker, clock, events } = await createBroker();
	const { client, outcome } = await createInteractiveClientHarness(t, { broker, clock });
	const finishCalls = [];
	client.emit("keyboard-interactive", "", "", "", [], (answers) => finishCalls.push(answers));
	await flushMicrotasks();
	const event = authEvent(events, "keyboard-interactive");

	broker.cancel(event.id);
	await flushMicrotasks();

	assert.deepEqual(finishCalls, []);
	assert.equal(client.destroyCalls, 1);
	assert.deepEqual(terminalAuthEvents(events, event.id).map((frame) => frame.state), ["cancelled"]);
	assert.deepEqual(broker.pendingIds(), []);
	const replayed = [];
	broker.replay((frame) => replayed.push(frame));
	assert.equal(replayed.some((frame) => frame.id === event.id), false);
	await assertAuthConnectionFailed(outcome, /auth|cancel|abort/i);
});

test("D-M08 a delayed zero-prompt challenge expires at the connection's absolute deadline", async (t) => {
	const { broker, clock, events } = await createBroker({ timeoutMs: 180_000 });
	const { client, outcome } = await createInteractiveClientHarness(t, { broker, clock });
	const finishCalls = [];

	clock.advance(179_999);
	assert.equal(client.destroyCalls, 0);
	client.emit("keyboard-interactive", "", "", "", [], (answers) => finishCalls.push(answers));
	await flushMicrotasks();
	const event = authEvent(events, "keyboard-interactive");
	clock.advance(1);
	await flushMicrotasks();

	assert.deepEqual(finishCalls, []);
	assert.equal(client.destroyCalls, 1);
	assert.deepEqual(terminalAuthEvents(events, event.id).map((frame) => frame.state), ["expired"]);
	assert.deepEqual(broker.pendingIds(), []);
	const replayed = [];
	broker.replay((frame) => replayed.push(frame));
	assert.equal(replayed.some((frame) => frame.id === event.id), false);
	await assertAuthConnectionFailed(outcome, /auth|expir|timeout|deadline/i);
});

test("D-M08 a dead SSH connection is aborted at the same absolute deadline without a pending prompt", async (t) => {
	const { broker, clock, events } = await createBroker({ timeoutMs: 180_000 });
	const { client, outcome } = await createInteractiveClientHarness(t, { broker, clock });

	clock.advance(179_999);
	assert.equal(client.destroyCalls, 0);
	clock.advance(1);
	await flushMicrotasks();

	assert.equal(client.destroyCalls, 1);
	assert.deepEqual(broker.pendingIds(), []);
	const replayed = [];
	broker.replay((frame) => replayed.push(frame));
	assert.deepEqual(replayed, []);
	assert.deepEqual(events, []);
	await assertAuthConnectionFailed(outcome, /auth|connect|timeout|deadline/i);
});

test("D-M08 only an explicitly answered zero-prompt challenge invokes ssh2 finish([])", async (t) => {
	const { broker, clock, events } = await createBroker();
	const { client, outcome } = await createInteractiveClientHarness(t, { broker, clock });
	const finishCalls = [];
	client.emit("keyboard-interactive", "", "", "", [], (answers) => finishCalls.push(answers));
	await flushMicrotasks();
	const event = authEvent(events, "keyboard-interactive");

	broker.answer(event.id, []);
	await flushMicrotasks();

	assert.deepEqual(finishCalls, [[]]);
	assert.equal(client.destroyCalls, 0);
	assert.deepEqual(terminalAuthEvents(events, event.id).map((frame) => frame.state), ["resolved"]);
	assert.deepEqual(broker.pendingIds(), []);

	client.emit("error", new Error("test cleanup"));
	await assertAuthConnectionFailed(outcome, /test cleanup/);
});

test("D-L01 shared limiter initializes numeric dropped-byte accounting for Local transport", async () => {
	const { appendLimitedOutput, limitedOutputText } = await import(OUTPUT_LIMIT);
	const target = { text: "", bytes: 0, truncated: false };
	appendLimitedOutput(target, Buffer.from("abcdef"), 4);
	assert.equal(target.text, "abcd");
	assert.equal(target.droppedBytes, 2);
	assert.equal(Number.isFinite(target.droppedBytes), true);
	assert.equal(limitedOutputText(target), "abcd\n…[truncated 2 bytes]");
});

test("D-L01 Engine output cap counts raw UTF-8 bytes and reports numeric drops", async () => {
	const { execCommand } = await import(SSH_ENGINE);
	assert.equal(typeof execCommand, "function");
	const { engine } = makeExecHarness({
		onExec({ stream }) {
			queueMicrotask(() => {
				stream.emit("data", Buffer.from("你好", "utf8"));
				stream.emit("close", 0);
			});
		},
	});
	const result = await execCommand(engine, "compute", "printf 你好", 1_000, undefined, 1);
	const payload = result.stdout.split("\n…[")[0];
	assert.equal(Buffer.byteLength(payload, "utf8") <= 4, true);
	assert.match(result.stdout, /truncated 3 bytes/);
	assert.doesNotMatch(result.stdout, /NaN/);
});

test("ProxyJump uses one absolute deadline that includes a hanging forwardOut", async (t) => {
	const [{ Client }, connectChain] = await Promise.all([
		import("ssh2"),
		exported(SSH_ENGINE, "connectChain"),
	]);
	const originalConnect = Client.prototype.connect;
	const originalForwardOut = Client.prototype.forwardOut;
	const originalEnd = Client.prototype.end;
	const clock = new FakeClock();
	const clients = [];
	Client.prototype.connect = function connect(config) {
		this.testConfig = config;
		this.endCalls = 0;
		clients.push(this);
		queueMicrotask(() => this.emit("ready"));
		return this;
	};
	Client.prototype.forwardOut = function forwardOut() {
		// Deliberately never invokes the callback.
	};
	Client.prototype.end = function end() {
		this.endCalls += 1;
		return this;
	};
	t.after(() => {
		Client.prototype.connect = originalConnect;
		Client.prototype.forwardOut = originalForwardOut;
		Client.prototype.end = originalEnd;
	});
	const entries = new Map([
		["jump", {
			alias: "jump",
			host: "jump.invalid",
			hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			port: 22,
			user: "runner",
			auth: { kind: "password", password: "secret" },
			proxyJump: [],
		}],
		["compute", {
			alias: "compute",
			host: "compute.invalid",
			hostKey: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
			port: 22,
			user: "runner",
			auth: { kind: "password", password: "secret" },
			proxyJump: ["jump"],
		}],
	]);
	const engine = {
		store: { find: (alias) => entries.get(alias) },
		opts: {
			connectTimeoutMs: 100,
			interactiveAuthTimeoutMs: 180_000,
			keepaliveIntervalMs: 15_000,
			clock,
		},
	};
	const pending = connectChain(engine, entries.get("compute"));
	await flushMicrotasks();
	assert.equal(clients.length, 1);
	clock.advance(99);
	await flushMicrotasks();
	let settled = false;
	pending.finally(() => { settled = true; }).catch(() => {});
	await flushMicrotasks();
	assert.equal(settled, false);
	clock.advance(1);
	await assert.rejects(pending, /ProxyJump|deadline|timed out/i);
	assert.equal(clients[0].endCalls > 0, true);
});

test("SSH channel callback waits abort immediately and close a late stream", async () => {
	const waitForSshOpen = await exported(SSH_ENGINE, "waitForSshOpen");
	const controller = new AbortController();
	let callback;
	let lateCloseCalls = 0;
	const pending = waitForSshOpen(
		(done) => { callback = done; },
		{
			signal: controller.signal,
			deadlineAt: Date.now() + 60_000,
			label: "terminal shell",
			disposeLate: (stream) => stream.close(),
		},
	);
	controller.abort(new Error("websocket closed"));
	await assert.rejects(pending, /websocket closed|aborted/i);
	callback(null, { close: () => { lateCloseCalls += 1; } });
	await Promise.resolve();
	assert.equal(lateCloseCalls, 1);
});

test("SSH channel callback waits enforce one absolute deadline and close late success", async () => {
	const waitForSshOpen = await exported(SSH_ENGINE, "waitForSshOpen");
	const clock = new FakeClock();
	let callback;
	let lateCloseCalls = 0;
	const pending = waitForSshOpen(
		(done) => { callback = done; },
		{
			clock,
			deadlineAt: 25,
			label: "event tail exec",
			disposeLate: (stream) => stream.close(),
		},
	);
	clock.advance(25);
	await assert.rejects(pending, /deadline|expired|timeout/i);
	callback(null, { close: () => { lateCloseCalls += 1; } });
	await Promise.resolve();
	assert.equal(lateCloseCalls, 1);
});

test("generic exec counts channel-open wait in its absolute deadline and closes a late channel", async () => {
	const { execCommand } = await import(SSH_ENGINE);
	const clock = new FakeClock();
	let callback;
	let lateCloseCalls = 0;
	const client = {
		exec(_command, done) { callback = done; },
		end() {},
	};
	const record = {
		client,
		hops: [],
		idleAt: 0,
		pinned: false,
		broken: false,
		inFlight: 0,
		disposed: false,
		closed: false,
	};
	const engine = {
		opts: { defaultExecTimeoutMs: 25, maxOutputBytes: 1024, idleTimeoutMs: 60_000, clock },
		pool: new Map([["compute", record]]),
		acquireQueue: new Map(),
		aliasGeneration: new Map(),
		acquireActive: new Map(),
		disposed: false,
	};
	const pending = execCommand(
		engine,
		"compute",
		"true",
		25,
		undefined,
		1,
		{ clock, deadlineAt: 25 },
	);
	await flushMicrotasks();
	assert.equal(typeof callback, "function");
	clock.advance(25);
	await assert.rejects(pending, /deadline|expired|timeout/i);
	callback(null, { close: () => { lateCloseCalls += 1; } });
	await Promise.resolve();
	assert.equal(lateCloseCalls, 1);
	assert.equal(record.inFlight, 0);
});

test("AuthChallengeBroker enforces prompt, UTF-8 event, and global pending caps before admission", async () => {
	const { broker, clock, events } = await createBroker();
	const baseRequest = {
		alias: "compute",
		method: "",
		name: "",
		instr: "",
		lang: "",
	};
	const assertRejectedWithoutAdmission = async (request) => {
		const beforeIds = new Set(broker.pendingIds());
		const before = {
			events: events.length,
			timers: clock.timers.size,
			pending: beforeIds.size,
		};
		let outcome;
		const attempt = Promise.resolve()
			.then(() => broker.request(request))
			.then(
				(value) => { outcome = { ok: true, value }; return outcome; },
				(error) => { outcome = { ok: false, error }; return outcome; },
			);
		await flushMicrotasks();
		const observed = {
			outcome,
			events: events.length,
			timers: clock.timers.size,
			pending: broker.pendingIds().length,
		};
		for (const id of broker.pendingIds()) {
			if (!beforeIds.has(id)) broker.cancel(id);
		}
		await attempt;
		assert.equal(observed.outcome?.ok, false);
		assert.match(
			String(observed.outcome?.error?.message ?? observed.outcome?.error),
			/limit|cap/i,
		);
		assert.deepEqual({
			events: observed.events,
			timers: observed.timers,
			pending: observed.pending,
		}, before);
	};


	const atPromptCap = broker.request({
		...baseRequest,
		prompts: Array.from({ length: 32 }, (_value, index) => ({
			prompt: `p${index}`,
			echo: false,
		})),
	});
	assert.equal(broker.pendingIds().length, 1);
	broker.cancel(broker.pendingIds()[0]);
	assert.deepEqual(await atPromptCap, { state: "cancelled" });
	await assertRejectedWithoutAdmission({
		...baseRequest,
		prompts: Array.from({ length: 33 }, () => ({ prompt: "p", echo: false })),
	});

	const atByteCap = broker.request({
		...baseRequest,
		alias: "a".repeat(32 * 1024),
		prompts: [],
	});
	assert.equal(broker.pendingIds().length, 1);
	broker.cancel(broker.pendingIds()[0]);
	assert.deepEqual(await atByteCap, { state: "cancelled" });
	await assertRejectedWithoutAdmission({
		...baseRequest,
		alias: `${"a".repeat(32 * 1024 - 1)}界`,
		prompts: [],
	});

	const admitted = Array.from({ length: 32 }, (_value, index) => broker.request({
		...baseRequest,
		alias: `compute-${index}`,
		prompts: [],
	}));
	assert.equal(broker.pendingIds().length, 32);
	assert.equal(clock.timers.size, 32);
	await assertRejectedWithoutAdmission({
		...baseRequest,
		alias: "compute-over-cap",
		prompts: [],
	});
	broker.cancelAll();
	assert.deepEqual(
		await Promise.all(admitted),
		Array.from({ length: 32 }, () => ({ state: "cancelled" })),
	);
	assert.equal(clock.timers.size, 0);
});

test("one SSH connection rejects a second concurrent keyboard-interactive challenge", async (t) => {
	const { broker, clock, events } = await createBroker();
	const { client, outcome } = await createInteractiveClientHarness(t, { broker, clock });
	let firstFinishCalls = 0;
	let secondFinishCalls = 0;
	client.emit(
		"keyboard-interactive",
		"first",
		"",
		"",
		[{ prompt: "Password:", echo: false }],
		() => { firstFinishCalls += 1; },
	);
	await flushMicrotasks();
	client.emit(
		"keyboard-interactive",
		"second",
		"",
		"",
		[{ prompt: "OTP:", echo: false }],
		() => { secondFinishCalls += 1; },
	);
	await flushMicrotasks();
	const snapshot = {
		openChallenges: events.filter((event) => event.type === "auth" && event.state === undefined).length,
		pending: broker.pendingIds().length,
		destroyCalls: client.destroyCalls,
	};
	broker.cancelAll();
	const result = await outcome;

	assert.equal(snapshot.openChallenges, 1);
	assert.equal(snapshot.pending, 0);
	assert.equal(snapshot.destroyCalls, 1);
	assert.equal(result.ok, false);
	assert.match(String(result.error?.message ?? result.error), /concurrent|limit|cap/i);
	assert.equal(firstFinishCalls, 0);
	assert.equal(secondFinishCalls, 0);
});

test("keyboard-interactive rejects oversized prompt arrays before normalization", async (t) => {
	const { broker, clock } = await createBroker();
	const { client, outcome } = await createInteractiveClientHarness(t, { broker, clock });
	let mapAccesses = 0;
	const prompts = new Proxy(
		Array.from({ length: 33 }, () => ({ prompt: "Password:", echo: false })),
		{
			get(target, property, receiver) {
				if (property === "map") {
					mapAccesses += 1;
					throw new Error("oversized prompts must not be normalized");
				}
				return Reflect.get(target, property, receiver);
			},
		},
	);
	assert.doesNotThrow(() => {
		client.emit("keyboard-interactive", "", "", "", prompts, () => {
			throw new Error("oversized challenge must not be answered");
		});
	});
	await flushMicrotasks();
	const result = await outcome;
	assert.equal(mapAccesses, 0);
	assert.equal(client.destroyCalls, 1);
	assert.equal(result.ok, false);
	assert.match(String(result.error?.message ?? result.error), /prompt|limit|cap/i);
});

test("openExecStream replays bounded early data and exactly one early terminal event", async (t) => {
	const [{ Client }, openExecStream] = await Promise.all([
		import("ssh2"),
		exported(SSH_ENGINE, "openExecStream"),
	]);
	const originalConnect = Client.prototype.connect;
	const originalExec = Client.prototype.exec;
	const originalDestroy = Client.prototype.destroy;
	const originalEnd = Client.prototype.end;
	let clientEndCalls = 0;
	const streams = [];
	const scenarios = [
		(stream) => {
			stream.emit("data", Buffer.from("ab"));
			stream.emit("close");
			stream.emit("error", new Error("ignored after close"));
		},
		(stream) => {
			stream.emit("data", Buffer.from("cd"));
			stream.emit("error", new Error("early stream error"));
			stream.emit("close");
		},
		(stream) => {
			stream.emit("data", Buffer.from("abcde"));
			stream.emit("close");
			stream.emit("error", new Error("ignored after overflow"));
		},
	];
	Client.prototype.connect = function connect() {
		queueMicrotask(() => this.emit("ready"));
		return this;
	};
	Client.prototype.destroy = function destroy() { return this; };
	Client.prototype.end = function end() {
		clientEndCalls += 1;
		return this;
	};
	Client.prototype.exec = function exec(_command, callback) {
		const stream = new EventEmitter();
		stream.closeCalls = 0;
		stream.close = () => { stream.closeCalls += 1; };
		stream.on("error", () => {});
		streams.push(stream);
		callback(null, stream);
		scenarios.shift()(stream);
	};
	t.after(() => {
		Client.prototype.connect = originalConnect;
		Client.prototype.exec = originalExec;
		Client.prototype.destroy = originalDestroy;
		Client.prototype.end = originalEnd;
	});

	const clock = new FakeClock();
	const entry = {
		alias: "compute",
		host: "compute.invalid",
		hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		port: 22,
		user: "runner",
		auth: { kind: "password", password: "secret" },
		proxyJump: [],
	};
	const engine = {
		store: { find: (alias) => alias === entry.alias ? entry : undefined },
		opts: { connectTimeoutMs: 1_000, maxOutputBytes: 4, clock },
	};
	const observeReplay = async () => {
		const session = await openExecStream(
			engine,
			entry.alias,
			"tail -f log",
			{ clock, deadlineAt: clock.now() + 1_000 },
		);
		const replay = [];
		session.onData = (chunk) => replay.push(["data", Buffer.from(chunk).toString("utf8")]);
		session.onClose = (error) => replay.push(["terminal", error]);
		return replay;
	};

	const closed = await observeReplay();
	assert.equal(closed.length, 2);
	assert.deepEqual(closed[0], ["data", "ab"]);
	assert.deepEqual(closed[1], ["terminal", undefined]);

	const errored = await observeReplay();
	assert.equal(errored.length, 2);
	assert.deepEqual(errored[0], ["data", "cd"]);
	assert.equal(errored[1][0], "terminal");
	assert.match(String(errored[1][1]?.message ?? errored[1][1]), /early stream error/);

	const overflowed = await observeReplay();
	assert.equal(overflowed.length, 2);
	assert.deepEqual(overflowed[0], ["data", "abcd"]);
	assert.equal(overflowed[1][0], "terminal");
	assert.match(String(overflowed[1][1]?.message ?? overflowed[1][1]), /overflow|limit|cap/i);
	assert.equal(streams[2].closeCalls, 1);
	assert.equal(clientEndCalls, 3);
});

test("dropAlias and dispose abort pending acquires and discard late clients", async (t) => {
	const [{ Client }, { SshEngine }] = await Promise.all([
		import("ssh2"),
		import(SSH_ENGINE),
	]);
	const originalConnect = Client.prototype.connect;
	const originalDestroy = Client.prototype.destroy;
	const originalEnd = Client.prototype.end;
	const clients = [];
	Client.prototype.connect = function connect() {
		this.destroyCalls = 0;
		this.endCalls = 0;
		clients.push(this);
		return this;
	};
	Client.prototype.destroy = function destroy() {
		this.destroyCalls += 1;
		return this;
	};
	Client.prototype.end = function end() {
		this.endCalls += 1;
		return this;
	};
	t.after(() => {
		Client.prototype.connect = originalConnect;
		Client.prototype.destroy = originalDestroy;
		Client.prototype.end = originalEnd;
	});

	const entry = {
		alias: "compute",
		host: "compute.invalid",
		hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		port: 22,
		user: "runner",
		auth: { kind: "password", password: "secret" },
		proxyJump: [],
	};
	const exercise = async (action) => {
		const clock = new FakeClock();
		const engine = new SshEngine(
			{ find: (alias) => alias === entry.alias ? entry : undefined },
			{
				connectTimeoutMs: 1_000,
				defaultExecTimeoutMs: 1_000,
				idleTimeoutMs: 60_000,
				clock,
			},
		);
		let settled;
		const pending = engine.exec(entry.alias, "true", 1_000, {
			clock,
			deadlineAt: 1_000,
		}).then(
			(value) => { settled = { ok: true, value }; return settled; },
			(error) => { settled = { ok: false, error }; return settled; },
		);
		const client = clients.at(-1);
		assert.ok(client);
		if (action === "dropAlias") engine.dropAlias(entry.alias);
		else engine.dispose();
		await flushMicrotasks();
		const snapshot = {
			settled,
			acquireQueue: engine.acquireQueue.size,
			acquireActive: engine.acquireActive.size,
			aliasGeneration: engine.aliasGeneration.size,
			pool: engine.pool.size,
			destroyCalls: client.destroyCalls,
		};

		client.emit("ready");
		await flushMicrotasks();
		const result = await pending;
		if (action === "dropAlias") engine.dispose();
		return { snapshot, result, client };
	};

	for (const action of ["dropAlias", "dispose"]) {
		const { snapshot, result, client } = await exercise(action);
		assert.equal(snapshot.settled?.ok, false, `${action} must reject immediately`);
		assert.match(
			String(snapshot.settled?.error?.message ?? snapshot.settled?.error),
			/abort|cancel|disposed|invalidated/i,
		);
		assert.deepEqual({
			acquireQueue: snapshot.acquireQueue,
			acquireActive: snapshot.acquireActive,
			aliasGeneration: snapshot.aliasGeneration,
			pool: snapshot.pool,
		}, {
			acquireQueue: 0,
			acquireActive: 0,
			aliasGeneration: 0,
			pool: 0,
		});
		assert.equal(snapshot.destroyCalls, 1);
		assert.equal(result.ok, false);
		assert.equal(client.endCalls, 1);
	}
});

test("cancelAllForAliases cancels only the challenges targeting the dropped alias", async () => {
	const { broker, events } = await createBroker();
	const dropped = broker.request({ alias: "Kelvin2_outside", method: "keyboard-interactive", prompts: [{ prompt: "OTP" }] });
	const kept = broker.request({ alias: "test_cluster_alt", method: "keyboard-interactive", prompts: [{ prompt: "OTP" }] });
	const droppedEvent = authEvent(events.filter((e) => e.alias === "Kelvin2_outside"), "keyboard-interactive");

	const cancelled = broker.cancelAllForAliases(["Kelvin2_outside"]);
	assert.deepEqual(cancelled, [droppedEvent.id]);
	assert.deepEqual(await dropped, { state: "cancelled" });
	assert.ok(events.some((candidate) => candidate.id === droppedEvent.id && candidate.state === "cancelled"));

	// The untouched alias still resolves normally.
	const keptEvent = authEvent(events.filter((e) => e.alias === "test_cluster_alt"), "keyboard-interactive");
	broker.answer(keptEvent.id, ["123456"]);
	assert.deepEqual(await kept, { state: "answered", answers: ["123456"] });
});

test("cancelAllForAliases tolerates bad input and unknown aliases", async () => {
	const { broker } = await createBroker();
	assert.deepEqual(broker.cancelAllForAliases(), []);
	assert.deepEqual(broker.cancelAllForAliases([]), []);
	assert.deepEqual(broker.cancelAllForAliases(["", 42, null]), []);
	assert.deepEqual(broker.cancelAllForAliases(["ghost"]), []);
});

test("dropAlias fires the host hook so stale challenges are cancelled", async (t) => {
	const { SshEngine } = await import(SSH_ENGINE);
	const engine = new SshEngine(
		{ find: () => undefined },
		{ connectTimeoutMs: 1_000, defaultExecTimeoutMs: 1_000, idleTimeoutMs: 60_000 },
	);
	t.after(() => engine.dispose());
	const dropped = [];
	engine.onAliasDrop = (alias) => dropped.push(alias);
	engine.dropAlias("Kelvin2_outside");
	engine.dropAlias("Kelvin2_outside"); // idempotent path must still notify once more, harmlessly
	assert.ok(dropped.includes("Kelvin2_outside"));
	// A throwing hook must not break teardown.
	engine.onAliasDrop = () => { throw new Error("boom"); };
	assert.doesNotThrow(() => engine.dropAlias("Kelvin2_outside"));
});

test("openExecStream with interactiveAuth:false never reaches the interactive prompter", async (t) => {
	const [{ Client }, openExecStream] = await Promise.all([
		import("ssh2"),
		exported(SSH_ENGINE, "openExecStream"),
	]);
	const originalConnect = Client.prototype.connect;
	const originalExec = Client.prototype.exec;
	const originalDestroy = Client.prototype.destroy;
	const originalEnd = Client.prototype.end;
	const challenges = [];
	let client;
	Client.prototype.connect = function connect(config) {
		client = this;
		this.testConfig = config;
		queueMicrotask(() => this.emit("ready"));
		return this;
	};
	Client.prototype.exec = function exec(_command, callback) {
		const stream = new EventEmitter();
		stream.close = () => {};
		stream.on("error", () => {});
		callback(null, stream);
		queueMicrotask(() => stream.emit("close"));
	};
	Client.prototype.destroy = function destroy() { return this; };
	Client.prototype.end = function end() { return this; };
	t.after(() => {
		Client.prototype.connect = originalConnect;
		Client.prototype.exec = originalExec;
		Client.prototype.destroy = originalDestroy;
		Client.prototype.end = originalEnd;
	});

	const clock = new FakeClock();
	const entry = {
		alias: "compute",
		host: "compute.invalid",
		hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		port: 22,
		user: "runner",
		auth: { kind: "password", password: "secret" },
		proxyJump: [],
	};
	const engine = {
		store: { find: (alias) => alias === entry.alias ? entry : undefined },
		opts: { connectTimeoutMs: 1_000, maxOutputBytes: 4, clock },
		interactivePrompter: (request) => { challenges.push(request); return Promise.resolve({ state: "answered", answers: ["x"] }); },
	};
	const session = await openExecStream(engine, entry.alias, "tail -f log", {
		clock,
		deadlineAt: clock.now() + 1_000,
		interactiveAuth: false,
	});
	session.onData = () => {};
	await new Promise((resolve) => { session.onClose = resolve; });
	assert.deepEqual(challenges, [], "a background open must never raise an auth challenge");
	assert.equal(client.testConfig.tryKeyboard, undefined, "tryKeyboard must stay off for non-interactive opens");
});
