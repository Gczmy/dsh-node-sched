import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import cp, { execFileSync } from "node:child_process";
import fs, {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";

const INDEX = "../lib/index.js";
const SSH_ENGINE = "../lib/ssh-engine.js";
const ENTRY_OVERRIDE = "../lib/entry-override.js";

async function exported(modulePath, name) {
	const module = await import(modulePath);
	assert.equal(typeof module[name], "function", `${name} must be an exported function`);
	return module[name];
}

test("all sched tools propagate cancellation through the query and OpenSSH process", async () => {
	await withBackendRoutes({}, async ({ state }) => {
		assert.equal(state.tools.size, 6);
		for (const [name, tool] of state.tools) {
			const args = { task_id: "batch:task" };
			const preAborted = new AbortController();
			const reason = new Error(`cancel ${name}`);
			preAborted.abort(reason);
			const before = state.spawnCalls.length;
			await assert.rejects(tool.execute(args, { signal: preAborted.signal }), (error) => error === reason);
			assert.equal(state.spawnCalls.length, before, `${name} must not spawn after cancellation`);

			state.hangCommands = true;
			const controller = new AbortController();
			const pending = tool.execute(args, { signal: controller.signal });
			const rejected = assert.rejects(pending, (error) => error === reason);
			let call;
			for (let tick = 0; tick < 30 && !call; tick += 1) {
				await new Promise((resolve) => setImmediate(resolve));
				call = state.spawnCalls.slice(before).find(({ args }) => !args.includes("-G") && !args.includes("-O"));
			}
			assert.ok(call, `${name} must start its command`);
			controller.abort(reason);
			await rejected;
			assert.deepEqual(call.child.killCalls, ["SIGTERM"], `${name} must terminate its SSH child`);
			assert.equal(state.spawnCalls.slice(before).filter(({ args }) => !args.includes("-G") && !args.includes("-O")).length, 1);
			state.hangCommands = false;
		}
	});
});

function responseRecorder() {
	return Object.assign(new EventEmitter(), {
		status: undefined,
		headers: undefined,
		writableEnded: false,
		destroyed: false,
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(body = "") {
			this.body += String(body);
			this.writableEnded = true;
		},
	});
}

class FakeChild extends EventEmitter {
	constructor() {
		super();
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.stdin = {
			endedWith: undefined,
			end: (value) => { this.stdin.endedWith = value; },
		};
		this.killCalls = [];
	}

	kill(signal) {
		this.killCalls.push(signal);
		return true;
	}
}

function requestFor(url, {
	method = "GET",
	origin,
	body,
	bodyGate,
	authorization,
} = {}) {
	const headers = { host: "127.0.0.1:3000" };
	if (origin !== undefined) headers.origin = origin;
	if (authorization !== undefined) headers.authorization = authorization;
	return Object.assign(new EventEmitter(), {
		method,
		url,
		headers,
		socket: { remoteAddress: "127.0.0.1" },
		async *[Symbol.asyncIterator]() {
			if (bodyGate) await bodyGate;
			if (body !== undefined) yield Buffer.from(JSON.stringify(body));
		},
	});
}

function statusFixture(document = {}) {
	const fixture = {
		schema_version: 1,
		limit: 200,
		truncated: { batches: false, jobs: false },
		next_cursor: null,
		next_job_cursor: null,
		daemon_health: {},
		cpu: { used: 0, total: 0 },
		batches: [],
		jobs: [],
		gpus: [],
		...document,
	};
	fixture.batches = fixture.batches.map((batch) => ({ revision: 1, ...batch }));
	fixture.gpus = fixture.gpus.map((gpu) => ({ revision: 1, assignments: [], ...gpu }));
	return fixture;
}

test("host memory reservations and resource wait reasons retain strict status validation", async () => {
	const canonical = await exported(INDEX, "canonicalStatusDocument");
	const batch = batchStatus("b", "train");
	const memory = { used_gib: 32.5, total_gib: 96, reserve_gib: 16, default_job_gib: 8, available_gib: null };
	for (const reason of ["cpu", "host_memory", "gpu", "parallel", "draining", "batch_blocked"]) {
		const doc = statusFixture({ batches: [batch], jobs: [{ ...jobStatus(batch, "a", { status: "pending" }), wait_reason: reason }], host_memory: memory });
		assert.equal(canonical(doc), doc);
	}
	for (const value of [-1, NaN, Infinity, "12", true]) {
		assert.throws(() => canonical(statusFixture({ host_memory: { ...memory, used_gib: value } })), /host_memory/);
	}
	assert.throws(() => canonical(statusFixture({ host_memory: { ...memory, available_gib: undefined } })), /host_memory/);
	assert.doesNotThrow(() => canonical(statusFixture()));
});

function batchStatus(id, name, { status = "active", revision = 1 } = {}) {
	return {
		id,
		name,
		batch_id: id,
		batch_name: name,
		status,
		progress: "0/1",
		depends_on: [],
		revision,
	};
}

function jobStatus(batch, task, { status = "failed", version = 1 } = {}) {
	return {
		id: `${batch.id}-${task}-v${version}`,
		batch_id: batch.id,
		batch_name: batch.name,
		task,
		version,
		status,
		wait_reason: null,
	};
}

function sshPublicKeyBlob(keyType, value) {
	const field = (text) => {
		const bytes = Buffer.from(text);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		return Buffer.concat([length, bytes]);
	};
	return Buffer.concat([field(keyType), field(value)]);
}


async function withBackendRoutes(statusDocument, callback, { beforeApply } = {}) {
	const apply = await exported(INDEX, "apply");
	const previousSpawn = cp.spawn;
	const previousHome = process.env.HOME;
	const home = mkdtempSync(path.join(tmpdir(), "nodesched-review-"));
	const routes = new Map();
	const state = {
		tools: new Map(),
		upgrades: new Map(),
		hangCommands: false,
		commands: [],
		statusOutage: false,
		masterOutage: false,
		masterOutageAliases: new Set(),
		hangMasterAliases: new Set(),
		spawnCalls: [],
	};
	let dispose;
	process.env.HOME = home;
	beforeApply?.({ home });
	cp.spawn = (_command, args) => {
		const remoteCommand = String(args.at(-1));
		state.commands.push(remoteCommand);
		const child = new FakeChild();
		state.spawnCalls.push({ args: [...args], child });
		let code = 0;
		let stdout = "ok\n";
		let stderr = "";
		if (args.includes("-G")) {
			const alias = String(args.at(-1)).replace(/[^A-Za-z0-9_.-]/g, "_");
			stdout = `host ${alias}\ncontrolpath /tmp/dsh-review-${alias}.sock\n`;
			stderr = "";
		} else if (args.includes("-O") && args.includes("check")) {
			if (state.masterOutage || state.masterOutageAliases.has(String(args.at(-1)))) {
				code = 255;
				stdout = "";
				stderr = "Control socket connect: No such file or directory";
			} else {
				stdout = "";
				stderr = "Master running (pid=1234)";
			}
		} else if (remoteCommand.includes(" status --json")) {
			if (state.statusOutage) {
				code = 255;
				stdout = "";
				stderr = "status preflight unavailable";
			} else {
				const page = typeof statusDocument === "function"
					? statusDocument(remoteCommand, state)
					: statusDocument;
				stdout = `${JSON.stringify(statusFixture(page))}\n`;
			}
		} else if (remoteCommand.includes(" history") && remoteCommand.includes(" --json")) {
			stdout = `${JSON.stringify({
				schema_version: 1,
				history: [{
					id: "batch-a-fit-v1",
					batch_id: "batch-a",
					batch_name: "train",
					task: "fit",
					status: "done",
					version: 1,
					rc: 0,
					gpu: null,
					started_at: "2026-08-29T00:00:00+00:00",
					finished_at: "2026-08-29T00:01:00+00:00",
					duration_seconds: 60,
					failure: null,
				}],
				limit: 1,
				truncated: false,
				next_cursor: null,
			})}\n`;
		} else if (remoteCommand.includes("hostname &&") && remoteCommand.includes(" config get")) {
			stdout = "compute-01\n{\"node\":\"compute-01\"}\n";
		}
		const hangingMasterCheck = args.includes("-O")
			&& args.includes("check")
			&& state.hangMasterAliases.has(String(args.at(-1)));
		const hangingCommand = state.hangCommands && !args.includes("-G") && !args.includes("-O");
		if (hangingCommand) child.kill = (signal) => {
			child.killCalls.push(signal);
			queueMicrotask(() => child.emit("close", null, signal));
			return true;
		};
		if (!hangingMasterCheck && !hangingCommand) queueMicrotask(() => {
			if (stdout) child.stdout.emit("data", Buffer.from(stdout));
			if (stderr) child.stderr.emit("data", Buffer.from(stderr));
			child.emit("close", code);
		});
		return child;
	};
	try {
		dispose = apply({
			logger: { info() {}, warn() {}, error() {} },
			systemPrompt: { section() {} },
			tools: { register(tool) { state.tools.set(tool.name, tool); return () => {}; } },
			webServer: {
				register(route) {
					routes.set(route.path, route.handler);
					return () => routes.delete(route.path);
				},
				registerUpgrade(route) {
					state.upgrades.set(route.path, route.handler);
					return () => state.upgrades.delete(route.path);
				},
			},
		}, {
			sshEntry: "gateway",
			schedBin: "/opt/sched",
			probeCommand: "daemon status",
			connectTimeoutSec: 1,
			pollFallbackSec: 3_600,
			transport: "auto",
			mutationMode: "ssh",
			mutationTarget: "writer",
			mutationSession: "",
			mutationExpectedNode: "compute-01",
		});
		const token = readFileSync(
			path.join(home, ".dsh", "node-sched-access-token"),
			"utf8",
		).trim();
		const request = async (url, options = {}) => {
			const handler = routes.get(url.split("?")[0]);
			assert.equal(typeof handler, "function", `missing route ${url}`);
			const response = responseRecorder();
			await handler(requestFor(url, {
				...options,
				authorization: options.authorization ?? `Bearer ${token}`,
			}), response);
			return {
				status: response.status,
				body: response.body ? JSON.parse(response.body) : undefined,
			};
		};
		// apply() launches its read-only activation probe/refresher in the
		// background. system-openssh first performs a local mux check, so allow
		// that promise chain to settle before an assertion resets command history.
		await new Promise((resolve) => setImmediate(resolve));
		await callback({ request, state, home, token });
	} finally {
		try {
			dispose?.();
		} finally {
			cp.spawn = previousSpawn;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(home, { recursive: true, force: true });
		}
	}
}

test("event tail resolves config without authentication and shares only the existing SSH connection", async (t) => {
	const { SshEngine } = await import(SSH_ENGINE);
	const configCalls = [];
	const streamCommands = [];
	let clientEndCalls = 0;
	let record;
	const client = new EventEmitter();
	const channel = Object.assign(new EventEmitter(), {
		stderr: new EventEmitter(),
		closeCalls: 0,
		close() { this.closeCalls++; this.emit("close"); },
	});
	client.exec = (command, callback) => { streamCommands.push(command); callback(null, channel); };
	client.end = () => { clientEndCalls++; };
	t.mock.method(Client.prototype, "connect", () => { assert.fail("event tail must never create a new SSH connection"); });
	t.mock.method(SshEngine.prototype, "execRetryable", async () => ({ success: true, stdout: JSON.stringify(statusFixture()), stderr: "" }));
	t.mock.method(SshEngine.prototype, "execOnce", async function (alias, command, _timeout, options) {
		if (command !== "cat $HOME/.sched/config.json") return { success: true, stdout: "ok", stderr: "" };
		configCalls.push(options);
		assert.equal(options.interactiveAuth, false);
		assert.equal(options.requireExistingConnection, true);
		assert.ok(options.signal instanceof AbortSignal);
		record = { client, hops: [], inFlight: 0, idleAt: Date.now(), broken: false, disposed: false, closed: false };
		this.pool.set(alias, record);
		return { success: true, stdout: '{"node":"compute-01"}', stderr: "" };
	});
	t.mock.method(WebSocketServer.prototype, "handleUpgrade", (_req, socket, _head, done) => done(socket.webSocket));
	await withBackendRoutes(statusFixture(), async ({ state, token }) => {
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [],
			send(value) { this.sent.push(JSON.parse(value)); },
			close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit("close"); },
		});
		const req = requestFor("/sched/ws/events", { origin: "http://127.0.0.1:3000" });
		req.headers["sec-websocket-protocol"] = `sched-auth, ${token}`;
		state.upgrades.get("/sched/ws/events")(req, { webSocket: ws, destroy() { assert.fail("authenticated socket rejected"); } }, Buffer.alloc(0));
		for (let tick = 0; tick < 20 && !streamCommands.length; tick++) await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(configCalls.length, 1);
		assert.deepEqual(streamCommands, ["tail -n 50 -F $HOME/.sched/compute-01/scheduler.log 2>/dev/null"]);
		assert.equal(record.inFlight, 1);
		channel.emit("data", Buffer.from("decision sample\n"));
		assert.ok(ws.sent.some((frame) => frame.type === "log" && frame.line === "decision sample"));
		ws.close();
		assert.equal(channel.closeCalls, 1);
		assert.equal(record.inFlight, 0);
		assert.equal(clientEndCalls, 0, "closing the dashboard must not close the shared SSH connection");
	}, {
		beforeApply({ home }) {
			mkdirSync(path.join(home, ".dsh"), { recursive: true, mode: 0o700 });
			writeFileSync(path.join(home, ".dsh", "nodesched_entry.json"), JSON.stringify({ sshEntry: "gateway", schedAlias: "compute" }), { mode: 0o600 });
		},
	});
});

test("X-H01 cancel consumer always passes the confirmed --yes flag", async () => {
	const buildOperationCommand = await exported(INDEX, "buildOperationCommand");
	assert.equal(
		buildOperationCommand("cancel", "batch-20260829", "/opt/sched"),
		"/opt/sched cancel 'batch-20260829' --yes",
	);
});

test("X-M01 successful operation HTTP result preserves the envelope text", async () => {
	const operationHttpResult = await exported(INDEX, "operationHttpResult");
	assert.deepEqual(
		operationHttpResult({ ok: true, code: 0, text: "submitted batch-20260829", raw: undefined }),
		{ ok: true, code: 0, text: "submitted batch-20260829" },
	);
});

test("X-M01 failed operation HTTP result preserves the CLI rejection", async () => {
	const operationHttpResult = await exported(INDEX, "operationHttpResult");
	assert.deepEqual(
		operationHttpResult({
			ok: false,
			code: 1,
			text: "confirmation requires --yes",
			raw: undefined,
		}),
		{ ok: false, code: 1, text: "confirmation requires --yes" },
	);
});

test("X-M02 status summary consumes canonical status plus wait_reason", async () => {
	const summarizeStatus = await exported(INDEX, "summarizeStatus");
	const text = summarizeStatus(statusFixture({
		batches: [
			{
				id: "active-id",
				name: "active",
				batch_id: "active-id",
				batch_name: "active",
				status: "active",
				progress: "0/1",
				depends_on: [],
			},
			{
				id: "old-id",
				name: "old",
				batch_id: "old-id",
				batch_name: "old",
				status: "discarded",
				progress: "0/1",
				depends_on: [],
			},
		],
		jobs: [
			{
				id: "active-id-fit-v1",
				batch_id: "active-id",
				batch_name: "active",
				task: "quota",
				version: 1,
				status: "pending",
				wait_reason: "quota",
			},
		],
	}));
	assert.match(text, /job active-id:quota \[pending\].*wait_reason=quota/);
	assert.doesNotMatch(text, /batch old \[discarded\]/);
	assert.match(text, /1 terminal, 1 active\/blocked/);
});

test("X-M03 mutations use an explicit verified writer, never the query target", async () => {
	const resolveMutationWriter = await exported(INDEX, "resolveMutationWriter");
	const writer = { mode: "engine", alias: "compute" };
	assert.deepEqual(
		resolveMutationWriter({
			queryTarget: { mode: "engine", alias: "gateway" },
			configuredWriter: writer,
			schedConfigNode: "compute-01",
			writerHostname: "compute-01",
		}),
		writer,
	);
});

test("X-M03 mutation routing fails closed when the writer is missing", async () => {
	const resolveMutationWriter = await exported(INDEX, "resolveMutationWriter");
	assert.throws(
		() => resolveMutationWriter({
			queryTarget: { mode: "local" },
			configuredWriter: undefined,
			schedConfigNode: "compute-01",
			writerHostname: "compute-01",
		}),
		/explicit|writer|missing/i,
	);
});

test("X-M03 mutation routing rejects a writer on the wrong host", async () => {
	const resolveMutationWriter = await exported(INDEX, "resolveMutationWriter");
	assert.throws(
		() => resolveMutationWriter({
			configuredWriter: { mode: "engine", alias: "wrong-host" },
			schedConfigNode: "compute-01",
			writerHostname: "gateway-01",
		}),
		/hostname|node|writer|mismatch/i,
	);
});

test("X-H05 writer verification requires the exact normalized node name", async () => {
	const resolveMutationWriter = await exported(INDEX, "resolveMutationWriter");
	const writer = { mode: "engine", alias: "compute", expectedNode: "COMPUTE-01." };
	assert.equal(
		resolveMutationWriter({
			configuredWriter: writer,
			schedConfigNode: "compute-01",
			writerHostname: "compute-01.",
		}),
		writer,
	);
	assert.throws(
		() => resolveMutationWriter({
			configuredWriter: writer,
			schedConfigNode: "compute-01",
			writerHostname: "compute-01.example.test",
		}),
		/hostname|node|writer|mismatch/i,
	);
});

test("D-M01 every sensitive sched read route rejects a non-loopback request", async () => {
	const guardReadRequest = await exported(INDEX, "guardReadRequest");
	for (const url of [
		"/sched/api/status",
		"/sched/api/history",
		"/sched/api/gpus",
		"/sched/api/incidents",
		"/sched/api/config",
		"/sched/api/daemon",
		"/sched/api/log?task=batch%3Atask",
	]) {
		const response = responseRecorder();
		const allowed = guardReadRequest({
			method: "GET",
			url,
			socket: { remoteAddress: "192.0.2.10" },
			headers: { host: "public.example", origin: "https://public.example" },
		}, response);
		assert.equal(allowed, false, url);
		assert.equal(response.status, 403, url);
		assert.match(response.body, /forbidden|loopback/i, url);
	}
});

test("all HTTP sched routes require the exact local bearer token", async () => {
	const guardReadRequest = await exported(INDEX, "guardReadRequest");
	const guardMutationRequest = await exported(INDEX, "guardMutationRequest");
	const token = "local-secret-token";
	const base = {
		url: "/sched/api/status",
		socket: { remoteAddress: "127.0.0.1" },
		headers: {
			host: "127.0.0.1:3000",
			origin: "http://127.0.0.1:3000",
		},
	};
	for (const authorization of [undefined, "Bearer wrong-token"]) {
		const readResponse = responseRecorder();
		assert.equal(
			guardReadRequest({
				...base,
				method: "GET",
				headers: { ...base.headers, authorization },
			}, readResponse, token),
			false,
		);
		assert.equal(readResponse.status, 401);

		const writeResponse = responseRecorder();
		assert.equal(
			guardMutationRequest({
				...base,
				method: "POST",
				headers: { ...base.headers, authorization },
			}, writeResponse, token),
			false,
		);
		assert.equal(writeResponse.status, 401);
	}
	assert.equal(
		guardReadRequest({
			...base,
			method: "GET",
			headers: { ...base.headers, authorization: `Bearer ${token}` },
		}, responseRecorder(), token),
		true,
	);
	assert.equal(
		guardMutationRequest({
			...base,
			method: "POST",
			headers: { ...base.headers, authorization: `Bearer ${token}` },
		}, responseRecorder(), token),
		true,
	);
});

test("access token is stable and private on disk", async () => {
	const loadOrCreateAccessToken = await exported(INDEX, "loadOrCreateAccessToken");
	const directory = mkdtempSync(path.join(tmpdir(), "nodesched-token-"));
	const file = path.join(directory, "private", "token");
	try {
		const first = loadOrCreateAccessToken(file);
		const second = loadOrCreateAccessToken(file);
		assert.equal(first, second);
		assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
		assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
		assert.equal(statSync(file).mode & 0o777, 0o600);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("websocket upgrades require bearer token in a subprotocol, never the URL", async () => {
	const websocketRequestAllowed = await exported(INDEX, "websocketRequestAllowed");
	const token = "local-secret-token";
	const request = {
		url: "/sched/ws/events",
		socket: { remoteAddress: "127.0.0.1" },
		headers: {
			host: "127.0.0.1:3000",
			origin: "http://127.0.0.1:3000",
			"sec-websocket-protocol": `sched-auth, ${token}`,
		},
	};
	assert.equal(websocketRequestAllowed(request, token), true);
	assert.equal(
		websocketRequestAllowed({
			...request,
			headers: {
				...request.headers,
				"sec-websocket-protocol": "sched-auth, wrong-token",
			},
		}, token),
		false,
	);
	assert.equal(
		websocketRequestAllowed({
			...request,
			url: `/sched/ws/events?token=${token}`,
			headers: {
				...request.headers,
				"sec-websocket-protocol": "sched-auth",
			},
		}, token),
		false,
	);
});

test("event-tail stop clears escalation on child exit before delayed close", async () => {
	const stopProcessTreeWithGrace = await exported(INDEX, "stopProcessTreeWithGrace");
	const child = new FakeChild();
	stopProcessTreeWithGrace(child, undefined, 5);
	assert.deepEqual(child.killCalls, ["SIGTERM"]);

	child.emit("exit", 0);
	await new Promise((resolve) => setTimeout(resolve, 15));
	child.emit("close", 0);
	assert.deepEqual(child.killCalls, ["SIGTERM"]);
});


test("event-tail pending open keeps its sole slot after abort until the SSH open settles", async () => {
	const beginPendingOpen = await exported(INDEX, "beginPendingOpen");
	const pending = new Set();
	const first = beginPendingOpen(pending, 1);
	assert.ok(first);
	first.controller.abort(new Error("last event client closed"));
	assert.equal(first.controller.signal.aborted, true);
	assert.equal(beginPendingOpen(pending, 1), undefined);
	assert.equal(pending.size, 1);

	first.settle();
	const next = beginPendingOpen(pending, 1);
	assert.ok(next);
	next.settle();
	assert.equal(pending.size, 0);
});
test("terminal pending opens retain their cap slot until settle and abort on websocket close", async () => {
	const serveTerminalWebSocket = await exported(INDEX, "serveTerminalWebSocket");
	const clients = new Set();
	const terminalSlots = new Set();
	const opens = [];
	const makeWs = () => {
		const ws = new EventEmitter();
		ws.OPEN = 1;
		ws.readyState = ws.OPEN;
		ws.bufferedAmount = 0;
		ws.sent = [];
		ws.closeCalls = 0;
		ws.send = (value) => ws.sent.push(value);
		ws.close = () => {
			ws.closeCalls += 1;
			ws.readyState = 3;
			ws.emit("close");
		};
		return ws;
	};
	const openShell = (_alias, _size, options) => new Promise((resolve) => {
		opens.push({ options, resolve });
	});
	const sockets = Array.from({ length: 4 }, makeWs);
	const serving = sockets.map((ws) => serveTerminalWebSocket({
		ws,
		clients,
		slots: terminalSlots,
		maxSlots: 4,
		openShell,
		openDeadlineAt: 123_456,
		alias: "compute",
		cols: 80,
		rows: 24,
	}));
	assert.equal(opens.length, 4);
	for (const [index, ws] of sockets.entries()) {
		ws.emit("close");
		assert.equal(opens[index].options.signal.aborted, true);
		assert.equal(opens[index].options.deadlineAt, 123_456);
	}
	assert.equal(clients.size, 0);
	assert.equal(terminalSlots.size, 4);

	const rejected = makeWs();
	const rejectedServing = serveTerminalWebSocket({
		ws: rejected,
		clients,
		slots: terminalSlots,
		maxSlots: 4,
		openShell,
		openDeadlineAt: 123_456,
		alias: "compute",
		cols: 80,
		rows: 24,
	});
	assert.equal(opens.length, 4);
	assert.equal(rejected.closeCalls, 1);

	const sessions = opens.map(({ resolve }) => {
		const session = { closeCalls: 0, close() { this.closeCalls += 1; } };
		resolve(session);
		return session;
	});
	await Promise.all([...serving, rejectedServing]);
	assert.equal(terminalSlots.size, 0);
	assert.deepEqual(sessions.map((session) => session.closeCalls), [1, 1, 1, 1]);

	const activeWs = makeWs();
	const activeSession = { closeCalls: 0, close() { this.closeCalls += 1; } };
	await serveTerminalWebSocket({
		ws: activeWs,
		clients,
		slots: terminalSlots,
		maxSlots: 4,
		openShell: async () => activeSession,
		openDeadlineAt: 123_456,
		alias: "compute",
		cols: 80,
		rows: 24,
	});
	assert.equal(clients.size, 1);
	assert.equal(terminalSlots.size, 1);
	activeWs.close();
	assert.equal(terminalSlots.size, 0);
	assert.equal(activeSession.closeCalls, 1);
});

test("terminal ready precedes synchronously replayed shell output", async () => {
	const serveTerminalWebSocket = await exported(INDEX, "serveTerminalWebSocket");
	const ws = new EventEmitter();
	ws.OPEN = 1;
	ws.readyState = ws.OPEN;
	ws.bufferedAmount = 0;
	ws.sent = [];
	ws.send = (value) => ws.sent.push(JSON.parse(value));
	ws.close = () => {
		ws.readyState = 3;
		ws.emit("close");
	};
	const session = {
		close() {},
		set onData(handler) {
			handler(Buffer.from("early prompt"));
		},
		set onExit(handler) {
			this.exitHandler = handler;
		},
	};

	await serveTerminalWebSocket({
		ws,
		clients: new Set(),
		slots: new Set(),
		maxSlots: 1,
		openShell: async () => session,
		openDeadlineAt: Date.now() + 1_000,
		alias: "compute",
		cols: 80,
		rows: 24,
	});
	assert.deepEqual(ws.sent.map(({ type }) => type), ["ready", "output"]);
	assert.equal(ws.sent[1].data, "early prompt");
	ws.close();
});

test("terminal output preserves UTF-8 across source chunks and 64 KiB websocket frames", async () => {
	const serveTerminalWebSocket = await exported(INDEX, "serveTerminalWebSocket");
	const ws = new EventEmitter();
	ws.OPEN = 1;
	ws.readyState = ws.OPEN;
	ws.bufferedAmount = 0;
	ws.sent = [];
	ws.send = (value) => ws.sent.push(JSON.parse(value));
	ws.close = () => {
		ws.readyState = 3;
		ws.emit("close");
	};
	const expected = `${"a".repeat(65_535)}你z`;
	const bytes = Buffer.from(expected, "utf8");
	const session = {
		close() {},
		set onData(handler) {
			handler(bytes.subarray(0, 65_536));
			handler(bytes.subarray(65_536));
		},
		set onExit(handler) {
			this.exitHandler = handler;
		},
	};

	await serveTerminalWebSocket({
		ws,
		clients: new Set(),
		slots: new Set(),
		maxSlots: 1,
		openShell: async () => session,
		openDeadlineAt: Date.now() + 1_000,
		alias: "compute",
		cols: 80,
		rows: 24,
	});
	const outputFrames = ws.sent.filter(({ type }) => type === "output");
	assert.equal(outputFrames.map(({ data }) => data).join(""), expected);
	assert.equal(outputFrames.some(({ data }) => data.includes("�")), false);
	assert.equal(outputFrames.every(({ data }) => Buffer.byteLength(data, "utf8") <= 64 * 1024), true);
	ws.close();
});

test("D-M02 partial auth patch preserves omitted key and secret fields", async () => {
	const mergeAuthPatch = await exported(SSH_ENGINE, "mergeAuthPatch");
	assert.deepEqual(
		mergeAuthPatch(
			{ kind: "key", keyPath: "/keys/id_ed25519", passphrase: "old", kbdintPassword: "otp" },
			{ passphrase: "new" },
		),
		{ kind: "key", keyPath: "/keys/id_ed25519", passphrase: "new", kbdintPassword: "otp" },
	);
});

test("D-M02 explicit null clears one auth field without clearing siblings", async () => {
	const mergeAuthPatch = await exported(SSH_ENGINE, "mergeAuthPatch");
	const merged = mergeAuthPatch(
		{ kind: "key", keyPath: "/keys/id_ed25519", passphrase: "secret", kbdintPassword: "otp" },
		{ passphrase: null },
	);
	assert.deepEqual(merged, { kind: "key", keyPath: "/keys/id_ed25519", kbdintPassword: "otp" });
});

test("D-M02 auth kind switch drops incompatible old-kind credentials", async () => {
	const mergeAuthPatch = await exported(SSH_ENGINE, "mergeAuthPatch");
	assert.deepEqual(
		mergeAuthPatch(
			{ kind: "key", keyPath: "/keys/id_ed25519", passphrase: "secret", kbdintPassword: "otp" },
			{ kind: "password", password: "new-password" },
		),
		{ kind: "password", password: "new-password", kbdintPassword: "otp" },
	);
});

test("D-M04 CLI stdin runner forwards cancellation and enforces total/output bounds", async () => {
	const makeRunner = await exported(INDEX, "makeRunner");
	const child = new FakeChild();
	let spawnCall;
	const fakeProcess = {
		spawn(command, args, options) {
			spawnCall = { command, args, options };
			return child;
		},
	};
	const signal = new AbortController().signal;
	const run = makeRunner(fakeProcess, { sshEntry: "gateway", connectTimeoutSec: 5 });
	const pending = run("cat > upload.json", {
		timeoutMs: 321,
		maxOutputBytes: 4,
		stdinData: Buffer.from("payload"),
		signal,
	});
	child.stderr.emit("data", Buffer.from("你好", "utf8"));
	child.emit("close", 1);
	const result = await pending;
	assert.equal(spawnCall.options.timeout, 321);
	assert.equal(spawnCall.options.signal, signal);
	assert.deepEqual(child.stdin.endedWith, Buffer.from("payload"));
	assert.equal(Buffer.byteLength(result.stderr.split("\n…[")[0], "utf8") <= 4, true);
	assert.match(result.stderr, /truncated 3 bytes/);
});

test("D-M05 status consumer always requests a bounded current-status document", async () => {
	const buildStatusCommand = await exported(INDEX, "buildStatusCommand");
	assert.equal(
		buildStatusCommand({ schedBin: "/opt/sched" }),
		"/opt/sched status --json --limit 200",
	);
	assert.equal(
		buildStatusCommand({ schedBin: "/opt/sched", limit: 25 }),
		"/opt/sched status --json --limit 25",
	);
	assert.throws(() => buildStatusCommand({ schedBin: "/opt/sched", limit: 0 }), /limit/i);
});

test("D-L02 entry override fsyncs its file and parent before reporting success", async () => {
	const persistEntryOverride = await exported(ENTRY_OVERRIDE, "persistEntryOverride");
	const calls = [];
	const tempFile = "/virtual/nodesched_entry.json.tmp-test";
	const file = "/virtual/nodesched_entry.json";
	const fakeFs = {
		constants: {
			O_WRONLY: 1,
			O_CREAT: 2,
			O_EXCL: 4,
			O_CLOEXEC: 8,
			O_NOFOLLOW: 16,
			O_RDONLY: 32,
			O_DIRECTORY: 64,
		},
		readFileSync(target, encoding) {
			calls.push(["read", target, encoding]);
			return JSON.stringify({ sshEntry: "old", mode: "auto" });
		},
		mkdirSync(directory, options) { calls.push(["mkdir", directory, options]); },
		openSync(target, flags, mode) {
			calls.push(["open", target, flags, mode]);
			return target.includes(".tmp-") ? 71 : 73;
		},
		writeFileSync(target, content, options) { calls.push(["write", target, content, options]); },
		fsyncSync(fd) { calls.push(["fsync", fd]); },
		closeSync(fd) { calls.push(["close", fd]); },
		renameSync(from, to) { calls.push(["rename", from, to]); },
	};
	persistEntryOverride({
		fs: fakeFs,
		file,
		patch: { sshEntry: "new" },
		tempFile,
	});
	const write = calls.find(([kind]) => kind === "write");
	assert.equal(write[1], 71);
	assert.deepEqual(JSON.parse(write[2]), { sshEntry: "new", mode: "auto" });
	const tempOpenIndex = calls.findIndex((call) => call[0] === "open" && call[1] === tempFile);
	const writeIndex = calls.findIndex(([kind]) => kind === "write");
	const tempFsyncIndex = calls.findIndex((call) => call[0] === "fsync" && call[1] === 71);
	const tempCloseIndex = calls.findIndex((call) => call[0] === "close" && call[1] === 71);
	const renameIndex = calls.findIndex(([kind]) => kind === "rename");
	const directoryOpenIndex = calls.findIndex((call) => call[0] === "open" && call[1] === "/virtual");
	const directoryFsyncIndex = calls.findIndex((call) => call[0] === "fsync" && call[1] === 73);
	const directoryCloseIndex = calls.findIndex((call) => call[0] === "close" && call[1] === 73);
	assert.ok(tempOpenIndex >= 0);
	assert.ok(writeIndex > tempOpenIndex);
	assert.ok(tempFsyncIndex > writeIndex);
	assert.ok(tempCloseIndex > tempFsyncIndex);
	assert.ok(renameIndex > tempCloseIndex);
	assert.ok(directoryOpenIndex >= 0 && directoryOpenIndex < tempOpenIndex);
	assert.ok(directoryFsyncIndex > renameIndex);
	assert.ok(directoryCloseIndex > directoryFsyncIndex);

	const durabilityFailure = new Error("parent directory fsync failed");
	let failedDirectoryFsync = false;
	assert.throws(
		() => persistEntryOverride({
			fs: {
				...fakeFs,
				fsyncSync(fd) {
					if (fd === 73 && !failedDirectoryFsync) {
						failedDirectoryFsync = true;
						throw durabilityFailure;
					}
				},
			},
			file,
			patch: { sshEntry: "unpublished" },
			tempFile: "/virtual/nodesched_entry.json.tmp-failing",
		}),
		(error) => error === durabilityFailure,
	);

	const foreignTemp = "/virtual/nodesched_entry.json.tmp-foreign";
	const unlinked = [];
	const tempConflict = new Error("temp already exists");
	assert.throws(
		() => persistEntryOverride({
			fs: {
				...fakeFs,
				openSync(target, ...args) {
					if (target === foreignTemp) throw tempConflict;
					return fakeFs.openSync(target, ...args);
				},
				unlinkSync(target) { unlinked.push(target); },
			},
			file,
			patch: { sshEntry: "blocked" },
			tempFile: foreignTemp,
		}),
		(error) => error === tempConflict,
	);
	assert.deepEqual(unlinked, []);
});

test("entry override restores the previous generation after directory commit failure", async () => {
	const persistEntryOverride = await exported(ENTRY_OVERRIDE, "persistEntryOverride");
	const directory = mkdtempSync(path.join(tmpdir(), "node-sched-entry-rollback-"));
	const file = path.join(directory, "nodesched_entry.json");
	const previous = { sshEntry: "gateway", schedAlias: "compute", mode: "auto" };
	writeFileSync(file, `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600 });
	let failedDirectoryCommit = false;
	const wrappedFs = {
		...fs,
		fsyncSync(fd) {
			if (!failedDirectoryCommit && fs.fstatSync(fd).isDirectory()) {
				failedDirectoryCommit = true;
				throw new Error("injected directory commit failure");
			}
			return fs.fsyncSync(fd);
		},
	};
	try {
		assert.throws(
			() => persistEntryOverride({
				fs: wrappedFs,
				file,
				patch: { schedAlias: null },
			}),
			/directory commit failure/,
		);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), previous);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("entry override rollback preserves exact malformed and absent prior states", async () => {
	const persistEntryOverride = await exported(ENTRY_OVERRIDE, "persistEntryOverride");
	for (const [label, previousContent] of [
		["absent", undefined],
		["malformed", "{operator-owned malformed content\n"],
		["non-object", "[\"operator\", \"content\"]\n"],
	]) {
		const directory = mkdtempSync(path.join(tmpdir(), `node-sched-entry-${label}-`));
		const file = path.join(directory, "nodesched_entry.json");
		if (previousContent !== undefined) {
			writeFileSync(file, previousContent, { mode: 0o600 });
		}
		let failedDirectoryCommit = false;
		const wrappedFs = {
			...fs,
			fsyncSync(fd) {
				if (!failedDirectoryCommit && fs.fstatSync(fd).isDirectory()) {
					failedDirectoryCommit = true;
					throw new Error("injected exact-state commit failure");
				}
				return fs.fsyncSync(fd);
			},
		};
		try {
			assert.throws(
				() => persistEntryOverride({
					fs: wrappedFs,
					file,
					patch: { schedAlias: null },
				}),
				/exact-state commit failure/,
			);
			if (previousContent === undefined) {
				assert.equal(fs.existsSync(file), false, `${label} must stay absent`);
			} else {
				assert.equal(readFileSync(file, "utf8"), previousContent, label);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

test("X-H02 status-derived task references keep the exact batch id", async () => {
	const buildTaskCommand = await exported(INDEX, "buildTaskCommand");
	const reference = { batch_id: "train-20260829T120000", batch_name: "train", task: "fit" };
	assert.equal(
		buildTaskCommand("log", reference, { schedBin: "/opt/sched", lines: 100 }),
		"/opt/sched log 'train-20260829T120000:fit' -n 100",
	);
});

test("X-H03 history consumer uses the real bounded JSON protocol", async () => {
	const buildHistoryCommand = await exported(INDEX, "buildHistoryCommand");
	assert.equal(buildHistoryCommand({ schedBin: "/opt/sched" }), "/opt/sched history --json --limit 50");
	assert.equal(
		buildHistoryCommand({ schedBin: "/opt/sched", batch: "train", limit: 7 }),
		"/opt/sched history 'train' --json --limit 7",
	);
});

test("request JSON parser rejects excessive depth and node counts", async () => {
	const parseBoundedJson = await exported(INDEX, "parseBoundedJson");
	assert.deepEqual(parseBoundedJson('{"ok":[1,true,null]}'), { ok: [1, true, null] });
	assert.throws(
		() => parseBoundedJson(`${'{"a":'.repeat(33)}null${"}".repeat(33)}`),
		/depth|complex/i,
	);
	assert.throws(
		() => parseBoundedJson(JSON.stringify(Array.from({ length: 10_001 }, () => 0))),
		/node|complex/i,
	);
});

test("client exception logs stay private and reject symlink targets", async () => {
	const appendPrivateClientLog = await exported(INDEX, "appendPrivateClientLog");
	const home = mkdtempSync(path.join(tmpdir(), "dsh-client-log-"));
	const previous = process.umask(0);
	try {
		appendPrivateClientLog(home, "first\n");
		const log = path.join(home, ".sched", "client-exceptions.log");
		assert.equal(statSync(path.dirname(log)).mode & 0o777, 0o700);
		assert.equal(statSync(log).mode & 0o777, 0o600);
		assert.equal(readFileSync(log, "utf8"), "first\n");
		rmSync(log);
		const outside = path.join(home, "outside.log");
		symlinkSync(outside, log);
		assert.throws(() => appendPrivateClientLog(home, "escaped\n"));
		assert.throws(() => statSync(outside));
	} finally {
		process.umask(previous);
		rmSync(home, { recursive: true, force: true });
	}
});

test("X-H04 status consumer rejects legacy job.batch and missing exact IDs", async () => {
	const summarizeStatus = await exported(INDEX, "summarizeStatus");
	assert.throws(
		() => summarizeStatus(statusFixture({
			jobs: [{
				id: "job-v1",
				batch: "legacy-name",
				batch_name: "display-name-is-not-an-id",
				task: "fit",
				version: 1,
				status: "pending",
				wait_reason: null,
			}],
		})),
		/canonical|batch_id|legacy|status/i,
	);
});

test("X-H04 status API fails closed on a legacy status document", async () => {
	await withBackendRoutes({
		batches: [],
		jobs: [{
			id: "job-v1",
			batch_id: "batch-20260829",
			batch: "legacy-name",
			batch_name: "display-name",
			task: "fit",
			version: 1,
			status: "pending",
			wait_reason: null,
		}],
		gpus: [],
	}, async ({ request }) => {
		const response = await request("/sched/api/status", {
			method: "GET",
			origin: "http://127.0.0.1:3000",
		});
		assert.equal(response.status, 503);
		assert.equal(response.body.ok, false);
		assert.equal(response.body.raw, undefined);
	});
});

test("canonical status validation rejects unknown states and referential gaps", async () => {
	const isCanonicalStatusDocument = await exported(INDEX, "isCanonicalStatusDocument");
	const batch = {
		id: "batch-a",
		name: "display",
		batch_id: "batch-a",
		batch_name: "display",
		status: "active",
		progress: "0/1",
		depends_on: [],
	};
	const job = {
		id: "batch-a-fit-v1",
		batch_id: "batch-a",
		batch_name: "display",
		task: "fit",
		version: 1,
		status: "pending",
		wait_reason: null,
	};
	assert.equal(isCanonicalStatusDocument(statusFixture({
		batches: [batch],
		jobs: [job],
	})), true);
	assert.equal(isCanonicalStatusDocument(statusFixture({
		batches: [{ ...batch, status: "mystery" }],
		jobs: [job],
	})), false);
	assert.equal(isCanonicalStatusDocument(statusFixture({
		batches: [],
		jobs: [job],
	})), false);
});

test("scheduler mutation commands carry one durable request id", async () => {
	const buildIdempotentMutationCommand = await exported(INDEX, "buildIdempotentMutationCommand");
	assert.equal(
		buildIdempotentMutationCommand(
			"/opt/sched gpu-free 0 --yes",
			"/opt/sched",
			"request-123",
			{
				kind: "gpu",
				id: "0",
				expectedStatus: "assigned",
				expectedQuarantined: 0,
				expectedRevision: 1,
				expectedAssignments: [],
			},
		),
		"/opt/sched request 'request-123' --expect-kind 'gpu' --expect-id '0'"
			+ " --expect-status 'assigned' --expect-revision 1 --expect-quarantined 0"
			+ " --expect-assignments-json '[]' -- gpu-free 0 --yes",
	);
	assert.throws(
		() => buildIdempotentMutationCommand("/other/sched retry x", "/opt/sched", "request-123"),
		/configured sched binary/i,
	);
	assert.throws(
		() => buildIdempotentMutationCommand("/opt/sched retry x", "/opt/sched", "../bad"),
		/request id/i,
	);
});

test("durable upload names bind request id to payload bytes", async () => {
	const durableUploadName = await exported(INDEX, "durableUploadName");
	const first = durableUploadName("submit-request", '{"name":"a"}');
	assert.equal(first, durableUploadName("submit-request", '{"name":"a"}'));
	assert.notEqual(first, durableUploadName("submit-request", '{"name":"b"}'));
	assert.match(first, /^nodesched-upload-submit-request-[0-9a-f]{32}\.json$/);
});

test("local mutation uploads atomically replace symlinks without escaping", async () => {
	const writePrivateUpload = await exported(INDEX, "writePrivateUpload");
	const home = mkdtempSync(path.join(tmpdir(), "dsh-upload-"));
	const directory = path.join(home, "inbox");
	const outside = path.join(home, "outside.json");
	const target = path.join(directory, "nodesched-upload-request-deadbeef.json");
	mkdirSync(directory);
	writeFileSync(outside, "outside", { mode: 0o600 });
	symlinkSync(outside, target);
	try {
		assert.equal(
			writePrivateUpload(
				directory,
				"nodesched-upload-request-deadbeef.json",
				'{"safe":true}',
			),
			target,
		);
		assert.equal(readFileSync(target, "utf8"), '{"safe":true}');
		assert.equal(readFileSync(outside, "utf8"), "outside");
		assert.equal(statSync(directory).mode & 0o777, 0o700);
		assert.equal(statSync(target).mode & 0o777, 0o600);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("fresh writer status enforces exact mutation preconditions", async () => {
	const assertMutationPreconditions = await exported(INDEX, "assertMutationPreconditions");
	const document = statusFixture({
		batches: [{
			id: "batch-a",
			name: "display",
			batch_id: "batch-a",
			batch_name: "display",
			status: "active",
			progress: "0/1",
			depends_on: [],
		}],
		jobs: [{
			id: "batch-a-fit-v2",
			batch_id: "batch-a",
			batch_name: "display",
			task: "fit",
			version: 2,
			status: "failed",
			wait_reason: null,
		}],
		gpus: [{ idx: 0, status: "free", job: null, quarantined: 0 }],
	});
	assert.doesNotThrow(() => assertMutationPreconditions(document, {
		kind: "task",
		id: "batch-a:fit",
		expectedStatus: "failed",
		expectedVersion: 2,
		expectedRevision: 1,
	}));
	assert.throws(() => assertMutationPreconditions(document, {
		kind: "task",
		id: "batch-a:fit",
		expectedStatus: "failed",
		expectedVersion: 1,
		expectedRevision: 1,
	}), /changed|version|precondition/i);
	assert.throws(() => assertMutationPreconditions(document, {
		kind: "gpu",
		id: "0",
		expectedStatus: "assigned",
		expectedRevision: 1,
		expectedAssignments: [],
	}), /changed|status|precondition/i);
});

test("mutation preparation runs after attestation and preflight on the writer", async () => {
	const verifyAndExecuteMutation = await exported(INDEX, "verifyAndExecuteMutation");
	const events = [];
	const result = await verifyAndExecuteMutation({
		configuredWriter: { mode: "engine", alias: "writer", expectedNode: "compute-01" },
		command: null,
		schedBin: "/opt/sched",
		executeRead: async () => {
			events.push("attest");
			return {
				ok: true,
				code: 0,
				stdout: 'compute-01\n{"node":"compute-01"}\n',
				stderr: "",
			};
		},
		preflight: async () => events.push("preflight"),
		prepare: async () => {
			events.push("prepare");
			return {
				command: "/opt/sched submit '/tmp/batch.json'",
				cleanup: async () => events.push("cleanup"),
			};
		},
		executeMutation: async (_writer, command) => {
			events.push(`mutate:${command}`);
			return { ok: true };
		},
	});
	assert.equal(result.ok, true);
	assert.deepEqual(events, [
		"attest",
		"preflight",
		"prepare",
		"mutate:/opt/sched submit '/tmp/batch.json'",
		"cleanup",
	]);
});

test("ambiguous SSH exits retain uploaded mutation payloads for exact replay", async () => {
	const verifyAndExecuteMutation = await exported(INDEX, "verifyAndExecuteMutation");
	for (const code of [-1, 75, 137, 255, 0]) {
		let cleaned = false;
		await verifyAndExecuteMutation({
			configuredWriter: { mode: "engine", alias: "writer", expectedNode: "compute-01", schedBin: "/opt/sched" },
			executeRead: async () => ({ ok: true, stdout: 'compute-01\n{"node":"compute-01"}\n' }),
			prepare: async () => ({ command: "/opt/sched submit '/tmp/batch.json'", cleanup: async () => { cleaned = true; } }),
			executeMutation: async () => ({ ok: false, code }),
		});
		assert.equal(cleaned, false, `exit ${code} must keep the payload`);
	}
});

test("X-H05 writer identity is attested immediately before every mutation", async () => {
	const verifyAndExecuteMutation = await exported(INDEX, "verifyAndExecuteMutation");
	const configuredWriter = {
		mode: "engine",
		alias: "writer",
		expectedNode: "compute-01",
		schedBin: "/opt/sched",
	};
	const events = [];
	let transportHostname = "compute-01";
	const executeRead = async (writer, command, timeoutMs) => {
		events.push(["verify", writer.alias, command, timeoutMs]);
		return {
			ok: true,
			code: 0,
			stdout: `${transportHostname}\n{"node":"compute-01"}\n`,
			stderr: "",
		};
	};
	const executeMutation = async (writer, command, timeoutMs) => {
		events.push(["mutate", writer.alias, command, timeoutMs]);
		return { ok: true, code: 0, stdout: "done", stderr: "" };
	};
	const first = await verifyAndExecuteMutation({
		configuredWriter,
		command: "/opt/sched cancel 'batch-a' --yes",
		timeoutMs: 1_234,
		executeRead,
		executeMutation,
	});
	assert.equal(first.ok, true);
	transportHostname = "patched-gateway";
	await assert.rejects(
		verifyAndExecuteMutation({
			configuredWriter,
			command: "/opt/sched cancel 'batch-b' --yes",
			timeoutMs: 1_234,
			executeRead,
			executeMutation,
		}),
		/hostname|node|writer|mismatch|verification/i,
	);
	assert.deepEqual(events.map(([kind]) => kind), ["verify", "mutate", "verify"]);
	assert.equal(events[0][3], 1_234);
	assert.equal(events[1][2], "/opt/sched cancel 'batch-a' --yes");
});

test("X-H05 mutation gate serializes different operations on the single writer", async () => {
	const WriteGate = await exported(INDEX, "WriteGate");
	const gate = new WriteGate();
	let releaseFirst;
	const first = gate.run("cancel:batch-a", () => new Promise((resolve) => {
		releaseFirst = resolve;
	}));

	await assert.rejects(
		gate.run("retry:batch-b", async () => "must not run"),
		/cancel:batch-a|already in flight|concurrent write/i,
	);

	releaseFirst("cancelled");
	assert.equal(await first, "cancelled");
	assert.equal(await gate.run("retry:batch-b", async () => "retried"), "retried");
});

test("D-H01 destructive preflight runs on the attested writer immediately before mutation", async () => {
	const verifyAndExecuteMutation = await exported(INDEX, "verifyAndExecuteMutation");
	const configuredWriter = {
		mode: "engine",
		alias: "writer",
		expectedNode: "compute-01",
		schedBin: "/opt/sched",
	};
	const events = [];
	const executeRead = async (writer) => {
		events.push(["verify", writer]);
		return {
			ok: true,
			code: 0,
			stdout: "compute-01\n{\"node\":\"compute-01\"}\n",
			stderr: "",
		};
	};
	const preflight = async (writer, timeoutMs) => {
		events.push(["preflight", writer, timeoutMs]);
	};
	const executeMutation = async (writer) => {
		events.push(["mutate", writer]);
		return { ok: true, code: 0, stdout: "done", stderr: "" };
	};
	await verifyAndExecuteMutation({
		configuredWriter,
		command: "/opt/sched gpu-free 0 --yes",
		timeoutMs: 4_321,
		executeRead,
		executeMutation,
		preflight,
	});
	assert.deepEqual(events.map(([kind]) => kind), ["verify", "preflight", "mutate"]);
	assert.equal(events[1][1], configuredWriter);
	assert.equal(events[2][1], configuredWriter);
	assert.equal(events[1][2], 4_321);
});

test("D-H01 successful status entries expire and expose stale failure metadata", async () => {
	const FreshStatusCache = await exported(INDEX, "FreshStatusCache");
	let now = 10_000;
	const cache = new FreshStatusCache({ ttlMs: 100, now: () => now });
	const body = { ok: true, raw: { batches: [], jobs: [], gpus: [] } };
	cache.recordSuccess("engine:compute", body);
	let view = cache.read("engine:compute");
	assert.equal(view.body, body);
	assert.equal(view.fresh, true);
	assert.equal(view.stale, false);
	assert.equal(view.ageMs, 0);
	assert.equal(view.lastError, null);
	now += 99;
	view = cache.read("engine:compute");
	assert.equal(view.fresh, true);
	assert.equal(view.ageMs, 99);
	now += 1;
	cache.recordFailure("engine:compute", new Error("status transport outage"));
	view = cache.read("engine:compute");
	assert.equal(view.fresh, false);
	assert.equal(view.stale, true);
	assert.equal(view.ageMs, 100);
	assert.equal(view.body, body);
	assert.match(String(view.lastError), /status transport outage/);
	const required = cache.read("engine:compute", { requireFresh: true });
	assert.equal(required.fresh, false);
	assert.equal(required.stale, true);
	assert.equal(required.body == null, true);
	assert.match(String(required.lastError), /status transport outage/);
});

test("D-H01 destructive GPU mutation forces fresh status and fails closed on outage", async () => {
	await withBackendRoutes({
		batches: [],
		jobs: [],
		gpus: [{ idx: 0, status: "assigned", job: "batch-a:fit", quarantined: 0 }],
	}, async ({ request, state }) => {
		const initial = await request("/sched/api/status", {
			method: "GET",
			origin: "http://127.0.0.1:3000",
		});
		assert.equal(initial.body.ok, true);
		state.statusOutage = true;
		state.commands.length = 0;
		const result = await request("/sched/api/op", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: {
				op: "gpu-free",
				id: "0",
				requestId: "gpu-outage-request",
				expectedStatus: "assigned",
				expectedQuarantined: 0,
				expectedRevision: 1,
				expectedAssignments: [],
			},
		});
		assert.equal(state.commands.some((command) => command.includes(" status --json")), true);
		assert.equal(state.commands.some((command) => command.includes(" gpu-free ")), false);
		assert.equal(result.body.ok, false);
		assert.match(JSON.stringify(result.body), /status|preflight|unavailable|outage/i);
	});
});
test("scheduler mutation route forwards durable id and exact source preconditions", async () => {
	await withBackendRoutes({
		batches: [],
		jobs: [],
		gpus: [{ idx: 0, status: "assigned", job: "batch-a:fit", quarantined: 0 }],
	}, async ({ request, state }) => {
		state.commands.length = 0;
		const result = await request("/sched/api/op", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: {
				op: "gpu-free",
				id: "0",
				requestId: "gpu-free-request",
				expectedStatus: "assigned",
				expectedQuarantined: 0,
				expectedRevision: 1,
				expectedAssignments: [],
			},
		});
		assert.equal(result.body.ok, true);
		assert.equal(
			state.commands.some((command) => command.includes(
				"/opt/sched request 'gpu-free-request'"
					+ " --expect-kind 'gpu' --expect-id '0'"
					+ " --expect-status 'assigned' --expect-revision 1 --expect-quarantined 0"
					+ " --expect-assignments-json '[]'"
					+ " -- gpu-free 0 --yes",
			)),
			true,
		);
	});
});

test("mutation replay reaches the durable receipt even after the original operation changed state", async () => {
	const batch = batchStatus("batch-a", "batch", { status: "active", revision: 8 });
	await withBackendRoutes({ batches: [batch], jobs: [], gpus: [] }, async ({ request, state }) => {
		state.commands.length = 0;
		const result = await request("/sched/api/op", {
			method: "POST", origin: "http://127.0.0.1:3000",
			body: { op: "retry", id: "batch-a", requestId: "lost-reply",
				expectedStatus: "blocked", expectedRevision: 7 },
		});
		assert.equal(result.body.ok, true);
		assert.ok(state.commands.some((command) => command.includes("request 'lost-reply'") && command.includes("--expect-revision 7")));
	});
});

test("host platform guard explains the WSL requirement before creating credential files", async () => {
	const assertHostPlatform = await exported(INDEX, "assertHostPlatform");
	assert.doesNotThrow(() => assertHostPlatform("linux"));
	assert.doesNotThrow(() => assertHostPlatform("darwin"));
	assert.throws(() => assertHostPlatform("win32"), /WSL2.*Linux filesystem/);
});

test("canonical status accepts maximum schema identifiers and dependencies independent of page size", async () => {
	const canonicalStatusDocument = await exported(INDEX, "canonicalStatusDocument");
	const batch = batchStatus(`${"b".repeat(128)}-20260907123000000`, "b".repeat(128));
	batch.depends_on = ["dependency-a", "dependency-b"];
	const job = jobStatus(batch, "t".repeat(128));
	assert.ok(job.id.length > 256);
	const gpus = [{ idx: 0, status: "assigned", job: `${batch.name}:${job.task}`, quarantined: 0 }];
	assert.doesNotThrow(() => canonicalStatusDocument(statusFixture({ limit: 1, batches: [batch], jobs: [job], gpus })));
});

test("writer preflight finds an exact batch outside the first batch page", async () => {
	const firstBatch = batchStatus("batch-a", "first");
	const targetBatch = batchStatus("batch-b", "target", { revision: 7 });
	await withBackendRoutes((command) => (
		command.includes("--cursor 'batch-next'")
			? {
				batches: [targetBatch],
				truncated: { batches: false, jobs: false },
				next_cursor: null,
				next_job_cursor: null,
			}
			: {
				batches: [firstBatch],
				truncated: { batches: true, jobs: false },
				next_cursor: "batch-next",
				next_job_cursor: null,
			}
	), async ({ request, state }) => {
		state.commands.length = 0;
		const result = await request("/sched/api/op", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: {
				op: "cancel",
				id: "batch-b",
				requestId: "cancel-page-two",
				expectedStatus: "active",
				expectedRevision: 7,
			},
		});
		assert.equal(result.body.ok, true);
		assert.equal(
			state.commands.some((command) => command.includes(
				"/opt/sched request 'cancel-page-two' --expect-kind 'batch' --expect-id 'batch-b'",
			)),
			true,
		);
	});
});

test("writer preflight nests job paging per batch page and checks the owning batch revision", async () => {
	const firstBatch = batchStatus("batch-a", "first");
	const targetBatch = batchStatus("batch-b", "target", { revision: 7 });
	const targetJob = jobStatus(targetBatch, "fit", { status: "failed", version: 2 });
	await withBackendRoutes((command) => {
		if (command.includes("--cursor 'batch-next'") && command.includes("--job-cursor 'job-next'")) {
			return {
				limit: 1,
				batches: [targetBatch],
				jobs: [targetJob],
				truncated: { batches: false, jobs: false },
				next_cursor: null,
				next_job_cursor: null,
			};
		}
		if (command.includes("--cursor 'batch-next'")) {
			return {
				limit: 1,
				batches: [targetBatch],
				jobs: [],
				truncated: { batches: false, jobs: true },
				next_cursor: null,
				next_job_cursor: "job-next",
			};
		}
		return {
			limit: 1,
			batches: [firstBatch],
			jobs: [],
			truncated: { batches: true, jobs: false },
			next_cursor: "batch-next",
			next_job_cursor: null,
		};
	}, async ({ request, state }) => {
		state.commands.length = 0;
		const result = await request("/sched/api/op", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: {
				op: "retry",
				id: "batch-b:fit",
				requestId: "retry-nested-page",
				expectedStatus: "failed",
				expectedVersion: 2,
				expectedRevision: 7,
			},
		});
		assert.equal(result.body.ok, true);
		assert.equal(
			state.commands.some((command) => command.includes(
				"/opt/sched request 'retry-nested-page' --expect-kind 'task' --expect-id 'batch-b:fit'"
					+ " --expect-status 'failed' --expect-revision 7 --expect-version 2",
			)),
			true,
		);
	});
});

test("writer preflight fails closed on cursor loops and status changes during paging", async (t) => {
	await t.test("batch cursor loop", async () => {
		const batch = batchStatus("batch-a", "first");
		await withBackendRoutes(() => ({
			batches: [batch],
			truncated: { batches: true, jobs: false },
			next_cursor: "loop",
			next_job_cursor: null,
		}), async ({ request, state }) => {
			state.commands.length = 0;
			const result = await request("/sched/api/op", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					op: "cancel",
					id: "missing-batch",
					requestId: "cursor-loop",
					expectedStatus: "active",
					expectedRevision: 1,
				},
			});
			assert.equal(result.body.ok, false);
			assert.match(result.body.text, /cursor loop|preflight unavailable/i);
			assert.equal(state.commands.some((command) => command.includes("/opt/sched request ")), false);
		});
	});

	await t.test("batch revision changes between job pages", async () => {
		const original = batchStatus("batch-a", "first", { revision: 1 });
		const changed = batchStatus("batch-a", "first", { revision: 2 });
		await withBackendRoutes((command) => (
			command.includes("--job-cursor 'job-next'")
				? {
					batches: [changed],
					jobs: [jobStatus(changed, "fit", { status: "failed", version: 2 })],
					truncated: { batches: false, jobs: false },
					next_cursor: null,
					next_job_cursor: null,
				}
				: {
					batches: [original],
					jobs: [],
					truncated: { batches: false, jobs: true },
					next_cursor: null,
					next_job_cursor: "job-next",
				}
		), async ({ request, state }) => {
			state.commands.length = 0;
			const result = await request("/sched/api/op", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					op: "retry",
					id: "batch-a:fit",
					requestId: "unstable-pagination",
					expectedStatus: "failed",
					expectedVersion: 2,
					expectedRevision: 2,
				},
			});
			assert.equal(result.body.ok, false);
			assert.match(result.body.text, /changed during paging|preflight unavailable/i);
			assert.equal(state.commands.some((command) => command.includes("/opt/sched request ")), false);
		});
	});

	await t.test("job cursor loop", async () => {
		const batch = batchStatus("batch-a", "first");
		await withBackendRoutes(() => ({
			batches: [batch],
			truncated: { batches: false, jobs: true },
			next_cursor: null,
			next_job_cursor: "loop",
		}), async ({ request, state }) => {
			state.commands.length = 0;
			const result = await request("/sched/api/op", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					op: "retry",
					id: "batch-a:missing",
					requestId: "job-cursor-loop",
					expectedStatus: "failed",
					expectedVersion: 1,
					expectedRevision: 1,
				},
			});
			assert.equal(result.body.ok, false);
			assert.match(result.body.text, /job cursor loop|preflight unavailable/i);
			assert.equal(state.commands.some((command) => command.includes("/opt/sched request ")), false);
		});
	});

	await t.test("GPU state changes between batch pages", async () => {
		const firstBatch = batchStatus("batch-a", "first");
		const targetBatch = batchStatus("batch-b", "target");
		await withBackendRoutes((command) => (
			command.includes("--cursor 'batch-next'")
				? {
					batches: [targetBatch],
					gpus: [{ idx: 0, status: "free", job: null, quarantined: 0, revision: 2 }],
				}
				: {
					batches: [firstBatch],
					gpus: [{ idx: 0, status: "free", job: null, quarantined: 0, revision: 1 }],
					truncated: { batches: true, jobs: false },
					next_cursor: "batch-next",
					next_job_cursor: null,
				}
		), async ({ request, state }) => {
			state.commands.length = 0;
			const result = await request("/sched/api/op", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					op: "cancel",
					id: "batch-b",
					requestId: "unstable-gpus",
					expectedStatus: "active",
					expectedRevision: 1,
				},
			});
			assert.equal(result.body.ok, false);
			assert.match(result.body.text, /GPU.*changed|preflight unavailable/i);
			assert.equal(state.commands.some((command) => command.includes("/opt/sched request ")), false);
		});
	});

	await t.test("malformed later page", async () => {
		const batch = batchStatus("batch-a", "first");
		await withBackendRoutes((command) => (
			command.includes("--job-cursor 'job-next'")
				? {
					schema_version: 2,
					batches: [batch],
					truncated: { batches: false, jobs: false },
					next_cursor: null,
					next_job_cursor: null,
				}
				: {
					batches: [batch],
					truncated: { batches: false, jobs: true },
					next_cursor: null,
					next_job_cursor: "job-next",
				}
		), async ({ request, state }) => {
			state.commands.length = 0;
			const result = await request("/sched/api/op", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					op: "retry",
					id: "batch-a:missing",
					requestId: "invalid-later-page",
					expectedStatus: "failed",
					expectedVersion: 1,
					expectedRevision: 1,
				},
			});
			assert.equal(result.body.ok, false);
			assert.match(result.body.text, /schema_version|invalid|preflight unavailable/i);
			assert.equal(state.commands.some((command) => command.includes("/opt/sched request ")), false);
		});
	});

	await t.test("total page limit", async () => {
		await withBackendRoutes((command) => {
			const match = command.match(/--cursor '(\d+)'/);
			const page = match ? Number(match[1]) : 0;
			return {
				batches: [batchStatus(`batch-${page}`, `page-${page}`)],
				truncated: { batches: true, jobs: false },
				next_cursor: String(page + 1),
				next_job_cursor: null,
			};
		}, async ({ request, state }) => {
			state.commands.length = 0;
			const result = await request("/sched/api/op", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					op: "cancel",
					id: "missing-batch",
					requestId: "page-limit",
					expectedStatus: "active",
					expectedRevision: 1,
				},
			});
			assert.equal(result.body.ok, false);
			assert.match(result.body.text, /paging limit|preflight unavailable/i);
			assert.equal(state.commands.some((command) => command.includes("/opt/sched request ")), false);
		});
	});
});

test("GPU writer preflight uses one canonical page even when batch and job cursors are truncated", async () => {
	await withBackendRoutes({
		gpus: [{ idx: 0, status: "assigned", job: "batch-a:fit", quarantined: 0 }],
		truncated: { batches: true, jobs: true },
		next_cursor: "batch-next",
		next_job_cursor: "job-next",
	}, async ({ request, state }) => {
		state.commands.length = 0;
		const result = await request("/sched/api/op", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: {
				op: "gpu-free",
				id: "0",
				requestId: "gpu-first-page",
				expectedStatus: "assigned",
				expectedQuarantined: 0,
				expectedRevision: 1,
				expectedAssignments: [],
			},
		});
		assert.equal(result.body.ok, true);
		const statusCommands = state.commands.filter((command) => command.includes(" status --json"));
		assert.equal(statusCommands.length, 1);
		assert.doesNotMatch(statusCommands[0], /--cursor|--job-cursor/);
	});
});


test("D-H02 mutation guard requires same-origin POST for every mutation route", async () => {
	const guardMutationRequest = await exported(INDEX, "guardMutationRequest");
	const accessToken = "test-access-token";
	const routes = [
		"/sched/api/entry",
		"/sched/api/config",
		"/sched/api/dryrun",
		"/sched/api/submit",
		"/sched/api/op",
		"/sched/ssh/hosts",
		"/sched/ssh/import",
		"/sched/ssh/host-key",
		"/sched/ssh/test",
		"/sched/ssh/exec",
		"/sched/ssh/use-system",
		"/sched/ssh/bind",
		"/sched/ssh/unbind",
		"/sched/api/client-log",
		"/sched/ssh/auth-answer",
	];
	for (const url of routes) {
		for (const method of ["GET", "PATCH", "DELETE"]) {
			const response = responseRecorder();
			assert.equal(guardMutationRequest(requestFor(url, {
				method,
				origin: "http://127.0.0.1:3000",
				authorization: `Bearer ${accessToken}`,
			}), response, accessToken), false, `${method} ${url}`);
			assert.equal(response.status, 405, `${method} ${url}`);
		}
		for (const origin of [undefined, "https://foreign.example", "http://localhost:3000", "https://127.0.0.1:3000"]) {
			const response = responseRecorder();
			assert.equal(guardMutationRequest(requestFor(url, {
				method: "POST",
				origin,
				authorization: `Bearer ${accessToken}`,
			}), response, accessToken), false, `${String(origin)} ${url}`);
			assert.equal(response.status, 403, `${String(origin)} ${url}`);
		}
		const response = responseRecorder();
		assert.equal(guardMutationRequest(requestFor(url, {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			authorization: `Bearer ${accessToken}`,
		}), response, accessToken), true, url);
		assert.equal(response.status, undefined, url);
	}
});

test("D-H02 mutation-only HTTP routes enforce the shared POST and Origin guard", async () => {
	await withBackendRoutes({ batches: [], jobs: [], gpus: [] }, async ({ request }) => {
		for (const url of [
			"/sched/api/dryrun",
			"/sched/api/submit",
			"/sched/api/op",
			"/sched/ssh/import",
			"/sched/ssh/host-key",
			"/sched/ssh/test",
			"/sched/ssh/exec",
			"/sched/ssh/use-system",
			"/sched/ssh/bind",
			"/sched/ssh/unbind",
			"/sched/api/client-log",
			"/sched/ssh/auth-answer",
		]) {
			const get = await request(url, {
				method: "GET",
				origin: "http://127.0.0.1:3000",
			});
			assert.equal(get.status, 405, `GET ${url}`);
			const missingOrigin = await request(url, { method: "POST", body: {} });
			assert.equal(missingOrigin.status, 403, `missing Origin ${url}`);
			const foreignOrigin = await request(url, {
				method: "POST",
				origin: "https://foreign.example",
				body: {},
			});
			assert.equal(foreignOrigin.status, 403, `foreign Origin ${url}`);
			const sameOrigin = await request(url, {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {},
			});
			assert.notEqual(sameOrigin.status, 403, `same Origin ${url}`);
			assert.notEqual(sameOrigin.status, 405, `POST ${url}`);
		}
		const patchHost = await request("/sched/ssh/hosts?alias=compute", {
			method: "PATCH",
			origin: "http://127.0.0.1:3000",
			body: {},
		});
		assert.equal(patchHost.status, 405);
		const deleteHost = await request("/sched/ssh/hosts?alias=compute", {
			method: "DELETE",
			origin: "http://127.0.0.1:3000",
		});
		assert.equal(deleteHost.status, 405);
		const missingOriginHost = await request("/sched/ssh/hosts", {
			method: "POST",
			body: {},
		});
		assert.equal(missingOriginHost.status, 403);
		const postHost = await request("/sched/ssh/hosts", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: {},
		});
		assert.notEqual(postHost.status, 403);
		assert.notEqual(postHost.status, 405);
	});
});

test("SSH config import reuses a safe known_hosts pin without a live credentialed connection", async () => {
	const blob = sshPublicKeyBlob("ssh-ed25519", "known-hosts-integration");
	await withBackendRoutes(
		{ batches: [], jobs: [], gpus: [] },
		async ({ request, home }) => {
			const imported = await request("/sched/ssh/import", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {},
			});
			assert.equal(imported.status, 200);
			assert.equal(imported.body.result.added, 1);
			assert.equal(imported.body.result.pinned, 1);
			assert.equal(imported.body.result.pending, 0);

			const listed = await request("/sched/ssh/hosts");
			assert.equal(listed.body.hosts.length, 1);
			assert.equal(listed.body.hosts[0].hostKeyReady, true);
			assert.equal(listed.body.hosts[0].hostKeys[0].source, "known_hosts");
			assert.ok(Number.isInteger(listed.body.hosts[0].revision));

			const prepared = await request("/sched/ssh/host-key", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					action: "prepare",
					targetAlias: "compute",
					expectedHostRevision: listed.body.hosts[0].revision,
				},
			});
			assert.equal(prepared.body.ok, true);
			assert.equal(prepared.body.state, "already_trusted");

			writeFileSync(
				path.join(home, ".ssh", "known_hosts"),
				`@revoked compute.example ssh-ed25519 ${blob.toString("base64")}\n`,
				{ mode: 0o600 },
			);
			const revoked = await request("/sched/ssh/host-key", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					action: "prepare",
					targetAlias: "compute",
					expectedHostRevision: listed.body.hosts[0].revision,
				},
			});
			assert.equal(revoked.status, 409);
			assert.equal(revoked.body.code, "SSH_HOST_KEY_REVOKED");
		},
		{
			beforeApply({ home }) {
				const sshDirectory = path.join(home, ".ssh");
				mkdirSync(sshDirectory, { mode: 0o700 });
				writeFileSync(path.join(sshDirectory, "config"), [
					"Host compute",
					"  HostName compute.example",
					"  User runner",
					"  IdentityFile ~/.ssh/id_test",
					"",
				].join("\n"), { mode: 0o600 });
				writeFileSync(
					path.join(sshDirectory, "known_hosts"),
					`compute.example ssh-ed25519 ${blob.toString("base64")}\n`,
					{ mode: 0o600 },
				);
			},
		},
	);
});

test("first TOFU probe refuses a host key marked @revoked in known_hosts", async (t) => {
	const observedKey = sshPublicKeyBlob("ssh-ed25519", "revoked-first-tofu-key");
	const originalConnect = Client.prototype.connect;
	const originalDestroy = Client.prototype.destroy;
	Client.prototype.connect = function connect(config) {
		queueMicrotask(() => config.hostVerifier(observedKey));
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

	await withBackendRoutes(
		{ batches: [], jobs: [], gpus: [] },
		async ({ request }) => {
			const imported = await request("/sched/ssh/import", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {},
			});
			assert.equal(imported.status, 200);
			assert.equal(imported.body.result.pinned, 0);
			assert.equal(imported.body.result.pending, 1);

			const listed = await request("/sched/ssh/hosts");
			const target = listed.body.hosts.find((host) => host.alias === "compute");
			const prepared = await request("/sched/ssh/host-key", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					action: "prepare",
					targetAlias: "compute",
					expectedHostRevision: target.revision,
				},
			});
			assert.equal(prepared.status, 409);
			assert.equal(prepared.body.code, "SSH_HOST_KEY_REVOKED");
			assert.equal(prepared.body.state, undefined);
		},
		{
			beforeApply({ home }) {
				const sshDirectory = path.join(home, ".ssh");
				mkdirSync(sshDirectory, { mode: 0o700 });
				writeFileSync(path.join(sshDirectory, "config"), [
					"Host compute",
					"  HostName compute.example",
					"  User runner",
					"",
				].join("\n"), { mode: 0o600 });
				writeFileSync(
					path.join(sshDirectory, "known_hosts"),
					`@revoked compute.example ssh-ed25519 ${observedKey.toString("base64")}\n`,
					{ mode: 0o600 },
				);
			},
		},
	);
});

test("host-key rotation refuses a newly observed key marked @revoked in known_hosts", async (t) => {
	const trustedKey = sshPublicKeyBlob("ssh-ed25519", "trusted-before-rotation");
	const observedKey = sshPublicKeyBlob("ssh-ed25519", "revoked-rotation-key");
	const originalConnect = Client.prototype.connect;
	const originalDestroy = Client.prototype.destroy;
	Client.prototype.connect = function connect(config) {
		queueMicrotask(() => config.hostVerifier(observedKey));
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

	await withBackendRoutes(
		{ batches: [], jobs: [], gpus: [] },
		async ({ request }) => {
			const imported = await request("/sched/ssh/import", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {},
			});
			assert.equal(imported.status, 200);
			assert.equal(imported.body.result.pinned, 1);

			const listed = await request("/sched/ssh/hosts");
			const target = listed.body.hosts.find((host) => host.alias === "compute");
			const prepared = await request("/sched/ssh/host-key", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					action: "prepare",
					mode: "rotate",
					targetAlias: "compute",
					hostAlias: "compute",
					expectedHostRevision: target.revision,
				},
			});
			assert.equal(prepared.status, 409);
			assert.equal(prepared.body.code, "SSH_HOST_KEY_REVOKED");
			assert.equal(prepared.body.state, undefined);
		},
		{
			beforeApply({ home }) {
				const sshDirectory = path.join(home, ".ssh");
				mkdirSync(sshDirectory, { mode: 0o700 });
				writeFileSync(path.join(sshDirectory, "config"), [
					"Host compute",
					"  HostName compute.example",
					"  User runner",
					"",
				].join("\n"), { mode: 0o600 });
				writeFileSync(
					path.join(sshDirectory, "known_hosts"),
					[
						`compute.example ssh-ed25519 ${trustedKey.toString("base64")}`,
						`@revoked compute.example ssh-ed25519 ${observedKey.toString("base64")}`,
						"",
					].join("\n"),
					{ mode: 0o600 },
				);
			},
		},
	);
});

test("partial known_hosts reuse returns the refreshed target revision for the remaining TOFU hop", async (t) => {
	const originalConnect = Client.prototype.connect;
	const originalDestroy = Client.prototype.destroy;
	Client.prototype.connect = function connect(config) {
		queueMicrotask(() => config.hostVerifier(sshPublicKeyBlob("ssh-ed25519", "observed-jump-key")));
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

	await withBackendRoutes(
		{ batches: [], jobs: [], gpus: [] },
		async ({ request }) => {
			const imported = await request("/sched/ssh/import", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {},
			});
			assert.equal(imported.status, 200);
			assert.equal(imported.body.result.pinned, 1);
			assert.equal(imported.body.result.pending, 1);

			const listed = await request("/sched/ssh/hosts");
			const target = listed.body.hosts.find((host) => host.alias === "compute");
			assert.equal(target.revision, 2);
			const prepared = await request("/sched/ssh/host-key", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					action: "prepare",
					targetAlias: "compute",
					expectedHostRevision: target.revision,
				},
			});
			assert.equal(prepared.status, 200);
			assert.equal(prepared.body.state, "confirmation_required");
			assert.equal(prepared.body.challenge.target.alias, "jump");
			assert.equal(prepared.body.challenge.targetRevision, 2);

			const confirmed = await request("/sched/ssh/host-key", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
				body: {
					action: "confirm",
					targetAlias: "compute",
					hostAlias: "jump",
					challengeId: prepared.body.challenge.id,
					fingerprint: prepared.body.challenge.observed.fingerprint,
					expectedHostRevision: prepared.body.challenge.targetRevision,
				},
			});
			assert.equal(confirmed.status, 200);
			assert.equal(confirmed.body.state, "trusted");
		},
		{
			beforeApply({ home }) {
				const sshDirectory = path.join(home, ".ssh");
				mkdirSync(sshDirectory, { mode: 0o700 });
				writeFileSync(path.join(sshDirectory, "config"), [
					"Host jump",
					"  HostName jump.invalid",
					"  User runner",
					"  IdentityFile ~/.ssh/id_test",
					"Host compute",
					"  HostName compute.example",
					"  User runner",
					"  IdentityFile ~/.ssh/id_test",
					"  ProxyJump jump",
					"",
				].join("\n"), { mode: 0o600 });
				const blob = sshPublicKeyBlob("ssh-ed25519", "known-target-key");
				writeFileSync(
					path.join(sshDirectory, "known_hosts"),
					`compute.example ssh-ed25519 ${blob.toString("base64")}\n`,
					{ mode: 0o600 },
				);
			},
		},
	);
});

test("D-H03 remote inbox writes enforce umask 077, directory 0700, and file 0600", async () => {
	const buildRemoteInboxWriteCommand = await exported(INDEX, "buildRemoteInboxWriteCommand");
	const root = mkdtempSync(path.join(tmpdir(), "nodesched-inbox-"));
	const remotePath = path.join(root, "inbox", "payload.json");
	try {
		const command = buildRemoteInboxWriteCommand(remotePath);
		assert.match(command, /umask\s+077/);
		assert.equal(command.search(/umask\s+077/) < command.indexOf(remotePath), true);
		execFileSync("/bin/sh", ["-c", command], {
			input: Buffer.from("{\"batch\":\"batch-a\"}\n"),
			stdio: ["pipe", "pipe", "pipe"],
		});
		assert.equal(statSync(path.dirname(remotePath)).mode & 0o777, 0o700);
		assert.equal(statSync(remotePath).mode & 0o777, 0o600);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("status and history builders forward independent stable cursors", async () => {
	const { buildStatusCommand, buildHistoryCommand } = await import(INDEX);
	assert.equal(
		buildStatusCommand({
			schedBin: "/opt/sched",
			limit: 25,
			cursor: "batch-cursor",
			jobCursor: "job-cursor",
		}),
		"/opt/sched status --json --limit 25 --cursor 'batch-cursor' --job-cursor 'job-cursor'",
	);
	assert.equal(
		buildHistoryCommand({
			schedBin: "/opt/sched",
			batch: "train",
			limit: 7,
			cursor: "history-cursor",
		}),
		"/opt/sched history 'train' --json --limit 7 --cursor 'history-cursor'",
	);
});

test("task diagnosis consumes the scheduler JSON task contract", async () => {
	const buildTaskCommand = await exported(INDEX, "buildTaskCommand");
	assert.equal(
		buildTaskCommand("task", { batch_id: "batch-a", task: "fit" }, { schedBin: "/opt/sched" }),
		"/opt/sched task 'batch-a:fit' --json",
	);
});

test("canonical status requires revisions, sorted GPU assignments, and independent cursors", async () => {
	const canonicalStatusDocument = await exported(INDEX, "canonicalStatusDocument");
	const document = statusFixture({
		truncated: { batches: true, jobs: true },
		next_cursor: "batch-next",
		next_job_cursor: "job-next",
		batches: [{
			id: "batch-a",
			name: "train",
			batch_id: "batch-a",
			batch_name: "train",
			status: "active",
			progress: "0/1",
			depends_on: [],
			revision: 8,
		}],
		gpus: [{
			idx: 0,
			status: "assigned",
			job: "batch-a:fit",
			quarantined: 0,
			revision: 11,
			assignments: [
				{ job_id: "batch-a:fit", vram_gib: 8 },
				{ job_id: "batch-a:validate", vram_gib: 4 },
			],
		}],
	});
	assert.equal(canonicalStatusDocument(document), document);
	assert.throws(
		() => canonicalStatusDocument({
			...document,
			gpus: [{
				...document.gpus[0],
				assignments: [...document.gpus[0].assignments].reverse(),
			}],
		}),
		/sorted|assignments/i,
	);
	assert.throws(
		() => canonicalStatusDocument({ ...document, next_job_cursor: null }),
		/job.*cursor|truncated/i,
	);
});

test("batch and GPU request bindings include revision and exact sorted assignments", async () => {
	const buildIdempotentMutationCommand = await exported(INDEX, "buildIdempotentMutationCommand");
	assert.equal(
		buildIdempotentMutationCommand(
			"/opt/sched cancel 'batch-a' --yes",
			"/opt/sched",
			"cancel-a",
			{ kind: "batch", id: "batch-a", expectedStatus: "active", expectedRevision: 9 },
		),
		"/opt/sched request 'cancel-a' --expect-kind 'batch' --expect-id 'batch-a'"
			+ " --expect-status 'active' --expect-revision 9 -- cancel 'batch-a' --yes",
	);
	assert.equal(
		buildIdempotentMutationCommand(
			"/opt/sched gpu-free 0 --yes",
			"/opt/sched",
			"gpu-a",
			{
				kind: "gpu",
				id: "0",
				expectedStatus: "assigned",
				expectedQuarantined: 0,
				expectedRevision: 12,
				expectedAssignments: [
					{ job_id: "batch-a:fit", vram_gib: 8 },
					{ job_id: "batch-a:validate", vram_gib: 4 },
				],
			},
		),
		"/opt/sched request 'gpu-a' --expect-kind 'gpu' --expect-id '0'"
			+ " --expect-status 'assigned' --expect-revision 12 --expect-quarantined 0"
			+ " --expect-assignments-json '[{\"job_id\":\"batch-a:fit\",\"vram_gib\":8},{\"job_id\":\"batch-a:validate\",\"vram_gib\":4}]'"
			+ " -- gpu-free 0 --yes",
	);
});

test("unknown mutation outcomes retain payloads while definitive outcomes clean up", async () => {
	const verifyAndExecuteMutation = await exported(INDEX, "verifyAndExecuteMutation");
	const outcomes = [-1, 75, 0, 65];
	const cleanupCodes = [];
	for (const code of outcomes) {
		await verifyAndExecuteMutation({
			configuredWriter: { mode: "local", expectedNode: "compute-01" },
			command: null,
			schedBin: "/opt/sched",
			executeRead: async () => ({
				ok: true,
				code: 0,
				stdout: "compute-01\n{\"node\":\"compute-01\"}\n",
				stderr: "",
			}),
			prepare: async () => ({
				command: "/opt/sched submit '/tmp/payload.json'",
				cleanup: async () => cleanupCodes.push(code),
			}),
			executeMutation: async () => ({ ok: code === 0, code, stdout: "", stderr: "" }),
		});
	}
	assert.deepEqual(cleanupCodes, [0, 65]);
});

test("remote inbox replacement is atomic under concurrent uploads and leaves no temp files", async () => {
	const buildRemoteInboxWriteCommand = await exported(INDEX, "buildRemoteInboxWriteCommand");
	const root = mkdtempSync(path.join(tmpdir(), "nodesched-upload-race-"));
	const target = path.join(root, "inbox", "nodesched-upload-request-deadbeef.json");
	const command = buildRemoteInboxWriteCommand(target);
	try {
		const first = cp.spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
		const second = cp.spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
		first.stdin.end('{"payload":"first"}');
		second.stdin.end('{"payload":"second"}');
		await Promise.all([
			new Promise((resolve, reject) => first.once("close", (code) => code === 0 ? resolve() : reject(new Error(`first ${code}`)))),
			new Promise((resolve, reject) => second.once("close", (code) => code === 0 ? resolve() : reject(new Error(`second ${code}`)))),
		]);
		assert.ok(['{"payload":"first"}', '{"payload":"second"}'].includes(readFileSync(target, "utf8")));
		const leftovers = readdirSync(path.dirname(target)).filter((name) => name.endsWith(".tmp"));
		assert.deepEqual(leftovers, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("status summaries never label a truncated page length as the total", async () => {
	const summarizeStatus = await exported(INDEX, "summarizeStatus");
	const summary = summarizeStatus(statusFixture({
		truncated: { batches: true, jobs: true },
		next_cursor: "batch-next",
		next_job_cursor: "job-next",
	}));
	assert.match(summary, /shown|page|more/i);
	assert.doesNotMatch(summary, /0 total/);
});

test("batch truncation scopes jobs, live, and by-status even when the job cursor is complete", async () => {
	const summarizeStatus = await exported(INDEX, "summarizeStatus");
	const summary = summarizeStatus(statusFixture({
		batches: [batchStatus("batch-a", "first")],
		truncated: { batches: true, jobs: false },
		next_cursor: "batch-next",
		next_job_cursor: null,
	}));
	const jobsLine = summary.split("\n").find((line) => line.startsWith("jobs:"));
	assert.match(jobsLine, /shown|scope|page/i);
	assert.match(jobsLine, /live .*shown/i);
	assert.match(jobsLine, /by-status shown/i);
	assert.doesNotMatch(jobsLine, /total/i);
});

test("job truncation scopes jobs, live, and by-status when the batch cursor is complete", async () => {
	const summarizeStatus = await exported(INDEX, "summarizeStatus");
	const batch = batchStatus("batch-a", "first");
	const summary = summarizeStatus(statusFixture({
		batches: [batch],
		jobs: [jobStatus(batch, "fit", { status: "running" })],
		truncated: { batches: false, jobs: true },
		next_cursor: null,
		next_job_cursor: "job-next",
	}));
	const jobsLine = summary.split("\n").find((line) => line.startsWith("jobs:"));
	assert.match(jobsLine, /shown|scope|page/i);
	assert.match(jobsLine, /live 1 shown/i);
	assert.match(jobsLine, /by-status shown/i);
	assert.doesNotMatch(jobsLine, /total/i);
});

test("event tail framing bounds a huge unterminated UTF-8 line and preserves split code points", async () => {
	const ByteLineFramer = await exported(INDEX, "ByteLineFramer");
	const lines = [];
	const framer = new ByteLineFramer({ maxLineBytes: 16, onLine: (line) => lines.push(line) });
	const encoded = Buffer.from(`你好${"x".repeat(100)}`, "utf8");
	framer.push(encoded.subarray(0, 2));
	framer.push(encoded.subarray(2));
	assert.equal(framer.bufferedBytes <= 16, true);
	assert.equal(lines.length, 0);
	framer.push(Buffer.from("\n"));
	assert.match(lines[0], /^你好/);
	assert.match(lines[0], /truncated \d+ bytes/);
});

test("CLI SSH timeout sends TERM, waits, sends KILL, and settles on child close", async () => {
	const makeRunner = await exported(INDEX, "makeRunner");
	const child = new FakeChild();
	child.pid = undefined;
	child.kill = (signal) => {
		child.killCalls.push(signal);
		if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
		return true;
	};
	const run = makeRunner({ spawn: () => child }, {
		sshEntry: "gateway",
		connectTimeoutSec: 5,
		termGraceMs: 2,
	});
	const result = await run("hang", { timeoutMs: 2 });
	assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
	assert.equal(result.code, -1);
	assert.match(result.stderr, /timed out/i);
});

test("CLI SSH deadline settles after leader exit even when close never arrives", async () => {
	const makeRunner = await exported(INDEX, "makeRunner");
	const child = new FakeChild();
	child.pid = undefined;
	const run = makeRunner({ spawn: () => child }, {
		sshEntry: "gateway",
		connectTimeoutSec: 5,
		termGraceMs: 2,
	});
	const pending = run("leader-exits", { timeoutMs: 5 });
	child.emit("exit", 0);
	const result = await Promise.race([
		pending,
		new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
	]);
	assert.notEqual(result, "hung");
	assert.equal(result.code, 0);
	assert.match(result.stderr, /timed out/i);
});

test("CLI SSH abort settles after leader exit without recycled-group escalation", {
	skip: process.platform === "win32",
}, async () => {
	const makeRunner = await exported(INDEX, "makeRunner");
	const child = new FakeChild();
	child.pid = 43_210;
	const controller = new AbortController();
	const groupSignals = [];
	const originalKill = process.kill;
	process.kill = (pid, signal) => {
		groupSignals.push([pid, signal]);
		return true;
	};
	try {
		const run = makeRunner({ spawn: () => child }, {
			sshEntry: "gateway",
			connectTimeoutSec: 5,
			termGraceMs: 2,
		});
		const pending = run("hang", { timeoutMs: 1_000, signal: controller.signal });
		controller.abort();
		child.emit("exit", null, "SIGTERM");
		child.emit("error", new Error("late child error"));
		const result = await Promise.race([
			pending,
			new Promise((resolve) => setTimeout(() => resolve("hung"), 25)),
		]);
		assert.notEqual(result, "hung");
		assert.deepEqual(groupSignals, [[-43_210, "SIGTERM"]]);
		assert.equal(result.code, -1);
		assert.match(result.stderr, /aborted/i);
		child.emit("close", null);
		assert.deepEqual(groupSignals, [[-43_210, "SIGTERM"]]);
	} finally {
		process.kill = originalKill;
	}
});

test("retained upload GC removes only old durable payloads", async () => {
	const gcPrivateUploads = await exported(INDEX, "gcPrivateUploads");
	const directory = mkdtempSync(path.join(tmpdir(), "nodesched-upload-gc-"));
	const oldPayload = path.join(directory, "nodesched-upload-old-deadbeef.json");
	const recentPayload = path.join(directory, "nodesched-upload-new-deadbeef.json");
	const unrelated = path.join(directory, "operator.json");
	try {
		writeFileSync(oldPayload, "{}");
		writeFileSync(recentPayload, "{}");
		writeFileSync(unrelated, "{}");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		utimesSync(oldPayload, old, old);
		assert.equal(gcPrivateUploads(directory), 1);
		assert.throws(() => readFileSync(oldPayload));
		assert.equal(readFileSync(recentPayload, "utf8"), "{}");
		assert.equal(readFileSync(unrelated, "utf8"), "{}");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("CLI SSH kills a real TERM-ignoring tracked process group and settles after close", async () => {
	const makeRunner = await exported(INDEX, "makeRunner");
	const childProcess = {
		spawn(_command, _args, options) {
			return cp.spawn(
				process.execPath,
				[
					"-e",
					"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
				],
				{ ...options, timeout: undefined, signal: undefined },
			);
		},
	};
	const run = makeRunner(childProcess, {
		sshEntry: "unused",
		connectTimeoutSec: 5,
		termGraceMs: 25,
	});
	const result = await run("unused", { timeoutMs: 100 });
	assert.equal(result.code, -1);
	assert.match(result.stderr, /timed out/i);
});

test("status and history HTTP paging forward each cursor end to end", async () => {
	await withBackendRoutes({ batches: [], jobs: [], gpus: [] }, async ({ request, state }) => {
		state.commands.length = 0;
		const status = await request(
			"/sched/api/status?limit=25&cursor=batch-cursor&job_cursor=job-cursor",
			{ method: "GET", origin: "http://127.0.0.1:3000" },
		);
		assert.equal(status.status, 200);
		assert.equal(
			state.commands.some((command) => command.includes(
				"status --json --limit 25 --cursor 'batch-cursor' --job-cursor 'job-cursor'",
			)),
			true,
		);
		state.commands.length = 0;
		const history = await request(
			"/sched/api/history?batch=train&limit=1&cursor=history-cursor",
			{ method: "GET", origin: "http://127.0.0.1:3000" },
		);
		assert.equal(history.status, 200);
		assert.equal(history.body.raw.history[0].batch_id, "batch-a");
		assert.equal(
			state.commands.some((command) => command.includes(
				"history 'train' --json --limit 1 --cursor 'history-cursor'",
			)),
			true,
		);
	});
});

test("task and unbound durable requests always carry the required revision", async () => {
	const buildIdempotentMutationCommand = await exported(INDEX, "buildIdempotentMutationCommand");
	assert.equal(
		buildIdempotentMutationCommand(
			"/opt/sched retry 'batch-a:fit'",
			"/opt/sched",
			"retry-fit",
			{
				kind: "task",
				id: "batch-a:fit",
				expectedStatus: "failed",
				expectedVersion: 2,
				expectedRevision: 8,
			},
		),
		"/opt/sched request 'retry-fit' --expect-kind 'task' --expect-id 'batch-a:fit'"
			+ " --expect-status 'failed' --expect-revision 8 --expect-version 2"
			+ " -- retry 'batch-a:fit'",
	);
	assert.equal(
		buildIdempotentMutationCommand(
			"/opt/sched daemon start",
			"/opt/sched",
			"daemon-start",
		),
		"/opt/sched request 'daemon-start' --expect-revision 0 -- daemon start",
	);
});

test("terminal cleanup is armed while openShell is pending and releases client capacity", async () => {
	const serveTerminalWebSocket = await exported(INDEX, "serveTerminalWebSocket");
	const ws = new EventEmitter();
	ws.OPEN = 1;
	ws.readyState = ws.OPEN;
	ws.bufferedAmount = 0;
	ws.send = () => {};
	ws.close = () => {
		ws.readyState = 3;
		ws.emit("close");
	};
	const clients = new Set();
	const slots = new Set();
	let resolveShell;
	let shellCloseCalls = 0;
	const pending = serveTerminalWebSocket({
		ws,
		clients,
		slots,
		alias: "compute",
		cols: 80,
		rows: 24,
		openShell: (_alias, _size, options) => {
			assert.equal(options.signal.aborted, false);
			return new Promise((resolve) => { resolveShell = resolve; });
		},
	});
	assert.equal(clients.size, 1);
	ws.readyState = 3;
	ws.emit("close");
	assert.equal(clients.size, 0);
	assert.equal(slots.size, 1);
	resolveShell({
		close() { shellCloseCalls += 1; },
		pause() {},
		resume() {},
		send() {},
		resize() {},
	});
	await pending;
	assert.equal(shellCloseCalls, 1);
	assert.equal(clients.size, 0);
	assert.equal(slots.size, 0);
});

test("ssh unbind persists before publishing or dropping the active alias", async (t) => {
	const { SshEngine } = await import(SSH_ENGINE);
	const originalDropAlias = SshEngine.prototype.dropAlias;
	const dropped = [];
	SshEngine.prototype.dropAlias = function dropAlias(alias) {
		dropped.push(alias);
		return originalDropAlias.call(this, alias);
	};
	t.after(() => { SshEngine.prototype.dropAlias = originalDropAlias; });

	await withBackendRoutes(statusFixture(), async ({ request, home }) => {
		const originalFsyncSync = fs.fsyncSync;
		fs.fsyncSync = (fd) => {
			if (fs.fstatSync(fd).isDirectory()) {
				throw new Error("entry override parent fsync failed");
			}
			return originalFsyncSync(fd);
		};
		syncBuiltinESMExports();
		let failed;
		try {
			failed = await request("/sched/ssh/unbind", {
				method: "POST",
				origin: "http://127.0.0.1:3000",
			});
		} finally {
			fs.fsyncSync = originalFsyncSync;
			syncBuiltinESMExports();
		}
		assert.ok(failed.status >= 400);
		assert.notEqual(failed.body?.ok, true);
		assert.deepEqual(dropped, []);

		const succeeded = await request("/sched/ssh/unbind", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
		});
		assert.equal(succeeded.status, 200);
		assert.equal(succeeded.body?.ok, true);
		assert.equal(succeeded.body?.prev, "compute");
		assert.deepEqual(dropped, ["compute"]);
	}, {
		beforeApply({ home }) {
			const directory = path.join(home, ".dsh");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(path.join(directory, "nodesched_entry.json"), JSON.stringify({
				sshEntry: "gateway",
				schedAlias: "compute",
			}), { mode: 0o600 });
		},
	});
});

test("system OpenSSH mode switches only after a live ControlMaster check and persists atomically", async () => {
	await withBackendRoutes(statusFixture(), async ({ request, state, home }) => {
		const overrideFile = path.join(home, ".dsh", "nodesched_entry.json");
		state.masterOutage = true;
		const failed = await request("/sched/ssh/use-system", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: { sshEntry: "HPDC_outside" },
		});
		assert.equal(failed.status, 409);
		assert.equal(failed.body?.ok, false);
		assert.equal(failed.body?.code, "no_control_master");
		assert.match(failed.body?.error, /ssh HPDC_outside/i);
		assert.deepEqual(JSON.parse(readFileSync(overrideFile, "utf8")), {
			sshEntry: "gateway",
			schedAlias: "compute",
		});
		const legacyUpdate = await request("/sched/api/entry", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: { entry: "HPDC_outside" },
		});
		assert.equal(legacyUpdate.status, 410);
		assert.equal(legacyUpdate.body?.code, "entry_update_moved");
		assert.deepEqual(JSON.parse(readFileSync(overrideFile, "utf8")), {
			sshEntry: "gateway",
			schedAlias: "compute",
		}, "the legacy entry endpoint must not bypass the candidate master check");

		state.masterOutage = false;
		const switched = await request("/sched/ssh/use-system", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: { sshEntry: "HPDC_outside" },
		});
		assert.equal(switched.status, 200);
		assert.equal(switched.body?.ok, true);
		assert.equal(switched.body?.mode, "system-openssh");
		assert.equal(switched.body?.sshEntry, "HPDC_outside");
		assert.equal(switched.body?.master?.ready, true);
		assert.deepEqual(JSON.parse(readFileSync(overrideFile, "utf8")), {
			sshEntry: "HPDC_outside",
			schedAlias: null,
		});

		await new Promise((resolve) => setImmediate(resolve));
		state.hangMasterAliases.add("HPDC_outside");
		const activeCheckBoundary = state.spawnCalls.length;
		const activeBindingRequest = request("/sched/ssh/binding");
		await new Promise((resolve) => setImmediate(resolve));
		const activeMasterCheck = state.spawnCalls.slice(activeCheckBoundary).filter(({ args }) => (
			args.includes("-O")
			&& args.includes("check")
			&& args.at(-1) === "HPDC_outside"
		)).at(-1);
		assert.ok(activeMasterCheck, "active ControlMaster check must be in flight");

		state.masterOutageAliases.add("missing-master");
		const rejectedCandidate = await request("/sched/ssh/use-system", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: { sshEntry: "missing-master" },
		});
		assert.equal(rejectedCandidate.status, 409);
		assert.equal(rejectedCandidate.body?.code, "no_control_master");
		assert.deepEqual(JSON.parse(readFileSync(overrideFile, "utf8")), {
			sshEntry: "HPDC_outside",
			schedAlias: null,
		}, "a rejected candidate must not replace the active system transport");
		assert.deepEqual(
			activeMasterCheck.child.killCalls,
			[],
			"a rejected candidate must not dispose or abort an active system transport",
		);
		state.hangMasterAliases.delete("HPDC_outside");
		activeMasterCheck.child.emit("close", 0);
		const activeBinding = await activeBindingRequest;
		assert.equal(activeBinding.body?.sshEntry, "HPDC_outside");
		assert.equal(activeBinding.body?.master?.ready, true);

		const binding = await request("/sched/ssh/binding");
		assert.equal(binding.body?.mode, "system-openssh");
		assert.equal(binding.body?.sshEntry, "HPDC_outside");
		assert.equal(binding.body?.master?.ready, true);
	}, {
		beforeApply({ home }) {
			const directory = path.join(home, ".dsh");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(path.join(directory, "nodesched_entry.json"), JSON.stringify({
				sshEntry: "gateway",
				schedAlias: "compute",
			}), { mode: 0o600 });
		},
	});
});

test("a request captured on system alias A never reacquires A after switching to B", async () => {
	await withBackendRoutes(statusFixture(), async ({ request, state }) => {
		const select = async (sshEntry) => request("/sched/ssh/use-system", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: { sshEntry },
		});
		assert.equal((await select("system-a")).body?.ok, true);

		let releaseBody;
		const bodyGate = new Promise((resolve) => { releaseBody = resolve; });
		const staleDryRun = request("/sched/api/dryrun", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: { content: "{}" },
			bodyGate,
		});
		await Promise.resolve();

		assert.equal((await select("system-b")).body?.ok, true);
		await new Promise((resolve) => setImmediate(resolve));
		const switchBoundary = state.spawnCalls.length;
		state.hangMasterAliases.add("system-b");
		const activeCheckBoundary = state.spawnCalls.length;
		const activeBindingRequest = request("/sched/ssh/binding");
		await new Promise((resolve) => setImmediate(resolve));
		const activeMasterCheck = state.spawnCalls.slice(activeCheckBoundary).filter(({ args }) => (
			args.includes("-O")
			&& args.includes("check")
			&& args.at(-1) === "system-b"
		)).at(-1);
		assert.ok(activeMasterCheck);

		releaseBody();
		const staleResult = await staleDryRun;
		assert.equal(staleResult.body?.ok, false);
		assert.deepEqual(activeMasterCheck.child.killCalls, []);
		assert.equal(
			state.spawnCalls.slice(switchBoundary).some(({ args }) => args.at(-1) === "system-a"),
			false,
			"stale cleanup must not recreate or spawn the old alias",
		);

		state.hangMasterAliases.delete("system-b");
		activeMasterCheck.child.emit("close", 0);
		const activeBinding = await activeBindingRequest;
		assert.equal(activeBinding.body?.sshEntry, "system-b");
		assert.equal(activeBinding.body?.master?.ready, true);
	}, {
		beforeApply({ home }) {
			const directory = path.join(home, ".dsh");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(path.join(directory, "nodesched_entry.json"), JSON.stringify({
				sshEntry: "gateway",
				schedAlias: "compute",
			}), { mode: 0o600 });
		},
	});
});

test("an invalid persisted system entry degrades without blocking recovery to a valid alias", async () => {
	await withBackendRoutes(statusFixture(), async ({ request, home }) => {
		const initial = await request("/sched/ssh/binding");
		assert.equal(initial.body?.mode, "system-openssh");
		assert.equal(initial.body?.sshEntry, "-invalid-entry");
		assert.equal(initial.body?.master?.ready, false);
		assert.equal(initial.body?.master?.code, "system_openssh_unavailable");

		const recovered = await request("/sched/ssh/use-system", {
			method: "POST",
			origin: "http://127.0.0.1:3000",
			body: { sshEntry: "recovered-entry" },
		});
		assert.equal(recovered.status, 200);
		assert.equal(recovered.body?.ok, true);
		assert.equal(recovered.body?.sshEntry, "recovered-entry");
		assert.deepEqual(JSON.parse(readFileSync(path.join(home, ".dsh", "nodesched_entry.json"), "utf8")), {
			sshEntry: "recovered-entry",
			schedAlias: null,
		});
	}, {
		beforeApply({ home }) {
			const directory = path.join(home, ".dsh");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(path.join(directory, "nodesched_entry.json"), JSON.stringify({
				sshEntry: "-invalid-entry",
				schedAlias: null,
			}), { mode: 0o600 });
		},
	});
});
