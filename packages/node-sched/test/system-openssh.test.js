import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	NoOpenSshMasterError,
	parseOpenSshControlPath,
	SystemOpenSshTransport,
	systemOpenSshControlMasterSupported,
	validateSshEntry,
} from "../lib/system-openssh.js";

class FakeReadable extends EventEmitter {
	pause() { this.paused = true; }
	resume() { this.paused = false; }
}

class FakeChild extends EventEmitter {
	constructor(pid) {
		super();
		this.pid = pid;
		this.stdout = new FakeReadable();
		this.stderr = new FakeReadable();
		this.stdin = Object.assign(new EventEmitter(), {
			endedWith: undefined,
			end: (value) => { this.stdin.endedWith = value; },
		});
		this.killCalls = [];
	}

	kill(signal) {
		this.killCalls.push(signal);
		return true;
	}
}

class ScriptedChildProcess {
	constructor(scripts = []) {
		this.scripts = [...scripts];
		this.calls = [];
	}

	spawn(file, args, options) {
		const child = new FakeChild(10_000 + this.calls.length);
		const script = this.scripts.shift();
		this.calls.push({ file, args, options, child });
		if (script) queueMicrotask(() => script(child));
		return child;
	}
}

class FakePty {
	constructor() {
		this.dataListeners = new Set();
		this.exitListeners = new Set();
		this.writes = [];
		this.resizes = [];
		this.killCalls = [];
		this.paused = false;
	}

	onData(listener) {
		this.dataListeners.add(listener);
		return { dispose: () => this.dataListeners.delete(listener) };
	}

	onExit(listener) {
		this.exitListeners.add(listener);
		return { dispose: () => this.exitListeners.delete(listener) };
	}

	emitData(data) { for (const listener of [...this.dataListeners]) listener(data); }
	emitExit(exitCode = 0, signal = 0) {
		for (const listener of [...this.exitListeners]) listener({ exitCode, signal });
	}
	write(data) { this.writes.push(data); }
	resize(cols, rows) { this.resizes.push([cols, rows]); }
	kill(signal) { this.killCalls.push(signal); }
	pause() { this.paused = true; }
	resume() { this.paused = false; }
}

function closeWith(code, { stdout, stderr } = {}) {
	return (child) => {
		if (stdout !== undefined) child.stdout.emit("data", Buffer.from(stdout));
		if (stderr !== undefined) child.stderr.emit("data", Buffer.from(stderr));
		child.emit("exit", code, null);
		child.emit("close", code, null);
	};
}

const masterReady = () => closeWith(0, { stdout: "Master running\n" });
const CONTROL_PATH = "/tmp/dsh-system-openssh-test.sock";
const configReady = () => closeWith(0, {
	stdout: `host gateway\ncontrolpath ${CONTROL_PATH}\nproxyjump bastion\n`,
});

test("system OpenSSH validates aliases and refuses credential material", () => {
	assert.equal(validateSshEntry("HPDC_outside"), "HPDC_outside");
	assert.equal(validateSshEntry("user@host.example"), "user@host.example");
	for (const value of ["", "-host", "host name", "host\nname", "host;touch", "host$(id)", "h".repeat(256)]) {
		assert.throws(() => validateSshEntry(value), /sshEntry/);
	}
	assert.equal(validateSshEntry("h".repeat(255)), "h".repeat(255));
	for (const field of ["password", "otp", "passphrase", "credentials", "auth", "keyboardInteractive"]) {
		assert.throws(
			() => new SystemOpenSshTransport({ sshEntry: "gateway", [field]: "secret" }),
			/does not accept authentication field/,
		);
	}
	assert.equal(systemOpenSshControlMasterSupported("darwin"), true);
	assert.equal(systemOpenSshControlMasterSupported("win32"), false);
	assert.throws(
		() => new SystemOpenSshTransport({ sshEntry: "gateway", platform: "win32" }),
		(error) => error.code === "system_openssh_unsupported",
	);
});

test("ssh -G control paths are absolute, expanded, and token-free", () => {
	assert.equal(
		parseOpenSshControlPath(`host gateway\ncontrolpath ${CONTROL_PATH}\n`),
		CONTROL_PATH,
	);
	assert.equal(parseOpenSshControlPath("host gateway\ncontrolpath none\n"), null);
	assert.equal(
		parseOpenSshControlPath("controlpath ~/.ssh/cm-test\n", { home: "/home/tester" }),
		"/home/tester/.ssh/cm-test",
	);
	assert.throws(() => parseOpenSshControlPath("controlpath relative/socket\n"), /absolute/);
	assert.throws(() => parseOpenSshControlPath("controlpath /tmp/cm-%C\n"), /unresolved token/);
	assert.throws(
		() => parseOpenSshControlPath("controlpath /tmp/one\ncontrolpath /tmp/two\n"),
		/multiple/,
	);
});

test("checkMaster only issues a bounded, non-interactive mux check", async () => {
	const childProcess = new ScriptedChildProcess([configReady(), masterReady()]);
	const transport = new SystemOpenSshTransport({
		sshEntry: "HPDC_outside",
		childProcess,
		masterCheckTimeoutMs: 50,
	});
	const status = await transport.checkMaster();
	assert.equal(status.ready, true);
	assert.equal(Number.isNaN(Date.parse(status.checkedAt)), false);
	assert.equal(childProcess.calls.length, 2);
	assert.deepEqual(childProcess.calls[0].args, [
		"-G", "-o", "BatchMode=yes", "HPDC_outside",
	]);
	assert.deepEqual(childProcess.calls[1].args, [
		"-o", "BatchMode=yes", "-S", CONTROL_PATH, "-O", "check", "HPDC_outside",
	]);
	assert.equal(childProcess.calls[1].options.shell, false);
	transport.dispose();
});

test("missing ControlMaster has a stable status and typed error without opening a session", async () => {
	const unavailable = closeWith(255, { stderr: "Control socket connect: No such file" });
	const childProcess = new ScriptedChildProcess([
		configReady(), unavailable,
		configReady(), masterReady(),
	]);
	const transport = new SystemOpenSshTransport({ sshEntry: "gateway", childProcess });
	const [status, concurrentStatus] = await Promise.all([
		transport.checkMaster(),
		transport.checkMaster(),
	]);
	assert.deepEqual(
		{ ready: status.ready, code: status.code, errorType: typeof status.error },
		{ ready: false, code: "no_control_master", errorType: "string" },
	);
	assert.deepEqual(concurrentStatus, status);
	assert.match(status.error, /ssh gateway/i);
	await assert.rejects(
		transport.exec("hostname"),
		(error) => error instanceof NoOpenSshMasterError && error.code === "no_control_master",
	);
	assert.equal(childProcess.calls.length, 2, "concurrent and cached failures must not fork another check");
	const refreshed = await transport.checkMaster({ force: true });
	assert.equal(refreshed.ready, true, "an explicit user recheck must bypass the negative cache");
	assert.equal(childProcess.calls.length, 4);
	transport.dispose();
});

test("an aborted waiter does not cancel a shared ControlMaster probe", async () => {
	const childProcess = new ScriptedChildProcess([() => {}, masterReady()]);
	const transport = new SystemOpenSshTransport({ sshEntry: "gateway", childProcess });
	const controller = new AbortController();
	const cancelled = transport.checkMaster({ signal: controller.signal });
	const shared = transport.checkMaster();
	controller.abort();
	assert.equal((await cancelled).code, "operation_aborted");
	assert.deepEqual(childProcess.calls[0].child.killCalls, []);
	childProcess.calls[0].child.stdout.emit("data", Buffer.from(`controlpath ${CONTROL_PATH}\n`));
	childProcess.calls[0].child.emit("exit", 0, null);
	childProcess.calls[0].child.emit("close", 0, null);
	assert.equal((await shared).ready, true);
	assert.equal(childProcess.calls.length, 2);
	transport.dispose();
});

test("a shortened caller deadline does not populate the shared negative cache", async () => {
	const unavailable = closeWith(255, { stderr: "Control socket connect: No such file" });
	const childProcess = new ScriptedChildProcess([
		configReady(), unavailable,
		configReady(), unavailable,
	]);
	const transport = new SystemOpenSshTransport({
		sshEntry: "gateway",
		childProcess,
		masterCheckTimeoutMs: 50,
	});
	assert.equal((await transport.checkMaster({ timeoutMs: 10 })).ready, false);
	assert.equal((await transport.checkMaster()).ready, false);
	assert.equal(childProcess.calls.length, 4);
	transport.dispose();
});

test("exec uses safe argv, mux-only fallback blocking, stdin, and no retry", async () => {
	const remoteCommand = "printf '%s' \"$HOME\"; echo $(id)";
	const childProcess = new ScriptedChildProcess([
		configReady(),
		masterReady(),
		closeWith(0, { stdout: "remote-ok" }),
		configReady(),
		masterReady(),
		closeWith(255, { stderr: "remote failed" }),
	]);
	const transport = new SystemOpenSshTransport({
		sshEntry: "HPDC_outside",
		connectTimeoutSec: 17,
		childProcess,
	});
	const first = await transport.execStdin(remoteCommand, Buffer.from("payload"));
	assert.equal(first.ok, true);
	assert.equal(first.stdout, "remote-ok");
	const call = childProcess.calls[2];
	assert.equal(call.file, "ssh");
	assert.deepEqual(call.args, [
		"-T",
		"-o", "BatchMode=yes",
		"-o", "ControlMaster=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
		"-o", "PermitLocalCommand=no",
		"-o", "ForkAfterAuthentication=no",
		"-o", "Tunnel=no",
		"-o", "ProxyCommand=false",
		"-o", "ConnectionAttempts=1",
		"-o", "ConnectTimeout=17",
		"-S", CONTROL_PATH,
		"HPDC_outside",
		remoteCommand,
	]);
	assert.equal(call.options.shell, false);
	assert.deepEqual(call.child.stdin.endedWith, Buffer.from("payload"));

	const failed = await transport.exec("false");
	assert.equal(failed.ok, false);
	assert.equal(failed.code, 255);
	assert.equal(childProcess.calls.length, 6, "command failure must not be retried");
	transport.dispose();
});

test("exec caps UTF-8 output and aborts before spawn", async () => {
	const childProcess = new ScriptedChildProcess([
		configReady(),
		masterReady(),
		closeWith(0, { stdout: "你好", stderr: "abcdefgh" }),
	]);
	const transport = new SystemOpenSshTransport({
		sshEntry: "gateway",
		childProcess,
		maxOutputBytes: 4,
	});
	const result = await transport.exec("large-output");
	assert.match(result.stdout, /^你/);
	assert.match(result.stdout, /truncated 3 bytes/);
	assert.match(result.stderr, /^abcd/);
	assert.match(result.stderr, /truncated 4 bytes/);

	const controller = new AbortController();
	controller.abort();
	const aborted = await transport.exec("must-not-spawn", { signal: controller.signal });
	assert.equal(aborted.ok, false);
	assert.equal(aborted.aborted, true);
	assert.match(aborted.stderr, /aborted/);
	assert.equal(childProcess.calls.length, 3);
	transport.dispose();
});

test("exec timeout terminates the tracked process group with TERM then KILL", async () => {
	const childProcess = new ScriptedChildProcess([configReady(), masterReady(), () => {}]);
	const signals = [];
	const transport = new SystemOpenSshTransport({
		sshEntry: "gateway",
		childProcess,
		killProcess: (pid, signal) => { signals.push([pid, signal]); },
		termGraceMs: 2,
	});
	const result = await transport.exec("hang", { timeoutMs: 10 });
	assert.equal(result.timedOut, true);
	assert.equal(result.code, -1);
	assert.match(result.stderr, /timed out/);
	const commandPid = childProcess.calls[2].child.pid;
	assert.deepEqual(signals, [[-commandPid, "SIGTERM"], [-commandPid, "SIGKILL"]]);
	assert.equal(transport.children.size, 0);
	transport.dispose();
});

test("openStream reuses the mux-only argv, bounds early output, and reports close", async () => {
	const childProcess = new ScriptedChildProcess([
		configReady(),
		masterReady(),
		(child) => {
			const utf8 = Buffer.from("你abcdefgh", "utf8");
			child.stdout.emit("data", utf8.subarray(0, 2));
			child.stdout.emit("data", utf8.subarray(2));
			child.emit("exit", 0, null);
			child.emit("close", 0, null);
		},
	]);
	const transport = new SystemOpenSshTransport({
		sshEntry: "gateway",
		childProcess,
		maxOutputBytes: 6,
	});
	const stream = await transport.openStream("tail -F events.jsonl");
	let output = "";
	let closeCount = 0;
	stream.onData = (chunk) => { output += chunk.toString("utf8"); };
	stream.onClose = () => { closeCount += 1; };
	const outcome = await stream.closed;
	await Promise.resolve();
	assert.equal(outcome.code, 0);
	assert.match(output, /^你abc/);
	assert.match(output, /truncated 5 bytes/);
	assert.equal(closeCount, 1);
	assert.equal(childProcess.calls[2].args.includes("ProxyCommand=false"), true);
	assert.deepEqual(childProcess.calls[2].args.slice(-4, -2), ["-S", CONTROL_PATH]);
	assert.equal(transport.streams.size, 0);
	transport.dispose();
});

test("stream abort terminates its process group", async () => {
	const childProcess = new ScriptedChildProcess([configReady(), masterReady(), () => {}]);
	const signals = [];
	const controller = new AbortController();
	const transport = new SystemOpenSshTransport({
		sshEntry: "gateway",
		childProcess,
		killProcess: (pid, signal) => { signals.push([pid, signal]); },
		termGraceMs: 2,
	});
	const stream = await transport.openStream("tail -F file", { signal: controller.signal });
	controller.abort();
	const outcome = await stream.closed;
	assert.equal(outcome.aborted, true);
	assert.match(outcome.error, /aborted/);
	const streamPid = childProcess.calls[2].child.pid;
	assert.deepEqual(signals, [[-streamPid, "SIGTERM"], [-streamPid, "SIGKILL"]]);
	transport.dispose();
});

test("openPty uses a master-only system ssh PTY and adapts the terminal session", async () => {
	const childProcess = new ScriptedChildProcess([configReady(), masterReady()]);
	const processPty = new FakePty();
	const spawnCalls = [];
	const transport = new SystemOpenSshTransport({
		sshEntry: "HPDC_outside",
		connectTimeoutSec: 17,
		childProcess,
		ptyModule: {
			spawn(file, args, options) {
				spawnCalls.push({ file, args, options });
				return processPty;
			},
		},
	});
	const session = await transport.openPty({ cols: 120, rows: 42 });
	assert.deepEqual(spawnCalls[0].args, [
		"-tt", "-e", "none",
		"-o", "BatchMode=yes",
		"-o", "ControlMaster=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
		"-o", "PermitLocalCommand=no",
		"-o", "ForkAfterAuthentication=no",
		"-o", "Tunnel=no",
		"-o", "ProxyCommand=false",
		"-o", "ConnectionAttempts=1",
		"-o", "ConnectTimeout=17",
		"-S", CONTROL_PATH,
		"HPDC_outside",
	]);
	assert.equal(spawnCalls[0].options.cols, 120);
	assert.equal(spawnCalls[0].options.rows, 42);
	processPty.emitData("early\r\n");
	let output = "";
	session.onData = (data) => { output += data; };
	assert.equal(output, "early\r\n");
	session.send("whoami\r");
	session.resize(140, 50);
	assert.deepEqual(processPty.writes, ["whoami\r"]);
	assert.deepEqual(processPty.resizes, [[140, 50]]);
	session.pause();
	assert.equal(processPty.paused, true);
	session.resume();
	assert.equal(processPty.paused, false);

	processPty.emitExit(0, 0);
	let exit;
	session.onExit = (code, error) => { exit = { code, error }; };
	assert.deepEqual(exit, { code: 0, error: undefined });
	assert.equal(transport.ptys.size, 0);
	transport.dispose();
});

test("openPty never loads node-pty or starts ssh when the ControlMaster is missing", async () => {
	const childProcess = new ScriptedChildProcess([
		configReady(),
		closeWith(255, { stderr: "Control socket connect: No such file" }),
	]);
	let loaderCalls = 0;
	const transport = new SystemOpenSshTransport({
		sshEntry: "gateway",
		childProcess,
		ptyLoader() { loaderCalls += 1; return { spawn() {} }; },
	});
	await assert.rejects(
		transport.openPty({ cols: 80, rows: 24 }),
		(error) => error.code === "no_control_master",
	);
	assert.equal(loaderCalls, 0);
	assert.equal(childProcess.calls.length, 2);
	transport.dispose();
});
