import cp from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
	appendLimitedOutput,
	createLimitedOutput,
	finalizeLimitedOutput,
	limitedOutputText,
} from "./output-limit.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function isBrokenPipe(error) {
	return error?.code === "EPIPE";
}

function runChild(command, {
	timeoutMs = DEFAULT_TIMEOUT_MS,
	stdinData,
	maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
	onStart,
	onClose,
} = {}) {
	const started = Date.now();
	const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
	return new Promise((resolve) => {
		const child = cp.spawn("/bin/bash", ["-c", command], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		onStart?.(child);
		const stdout = createLimitedOutput();
		const stderr = createLimitedOutput();
		let timedOut = false;
		let stdinError;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			finalizeLimitedOutput(stdout);
			finalizeLimitedOutput(stderr);
			onClose?.(child);
			resolve({
				...result,
				stdout: limitedOutputText(stdout),
				stderr: limitedOutputText(stderr) || result.error || "",
				timedOut,
				durationMs: Date.now() - started,
			});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
			finish({ ok: false, code: -1, error: `command timed out after ${budget} ms` });
		}, budget);
		child.stdout.on("data", (chunk) => appendLimitedOutput(stdout, chunk, maxOutputBytes));
		child.stderr.on("data", (chunk) => appendLimitedOutput(stderr, chunk, maxOutputBytes));
		child.on("error", (error) => finish({ ok: false, code: -1, error: error.message }));
		child.on("close", (code) => {
			if (settled) return;
			finish({
				ok: code === 0 && !timedOut && (!stdinError || isBrokenPipe(stdinError)),
				code: timedOut ? -1 : (code ?? -1),
				error: stdinError && !isBrokenPipe(stdinError) ? stdinError.message : undefined,
			});
		});
		child.stdin.on("error", (error) => { stdinError = error; });
		if (stdinData === undefined) child.stdin.end();
		else child.stdin.end(stdinData);
	});
}

/** Local implementation of the transport contract used by the sched plugin. */
export class LocalTransport {
	constructor(options = {}) {
		this.options = { ...options };
		this.children = new Set();
		this.streams = new Set();
	}

	exec(command, options = {}) {
		return runChild(String(command), {
			...this.options,
			...options,
			onStart: (child) => this.children.add(child),
			onClose: (child) => this.children.delete(child),
		});
	}

	execStdin(command, data, options = {}) {
		return runChild(String(command), {
			...this.options,
			...options,
			stdinData: data,
			onStart: (child) => this.children.add(child),
			onClose: (child) => this.children.delete(child),
		});
	}

	async openStream(command) {
		const child = cp.spawn("/bin/bash", ["-c", String(command)], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let closed = false;
		let closeNotified = false;
		let onData;
		let onClose;
		const pendingChunks = [];
		const session = {
			get onData() { return onData; },
			set onData(handler) {
				onData = typeof handler === "function" ? handler : undefined;
				if (onData) {
					for (const chunk of pendingChunks.splice(0)) onData(chunk);
				}
			},
			get onClose() { return onClose; },
			set onClose(handler) {
				onClose = typeof handler === "function" ? handler : undefined;
				if (closed && onClose && !closeNotified) {
					closeNotified = true;
					onClose();
				}
			},
			close: () => {
				if (closed) return;
				try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
			},
			pause: () => { child.stdout.pause(); child.stderr.pause(); },
			resume: () => { child.stdout.resume(); child.stderr.resume(); },
		};
		const deliver = (chunk) => {
			if (onData) onData(chunk);
			else pendingChunks.push(chunk);
		};
		child.stdout.on("data", (chunk) => {
			const text = stdoutDecoder.write(chunk);
			if (text) deliver(Buffer.from(text, "utf8"));
		});
		child.stderr.on("data", (chunk) => {
			const text = stderrDecoder.write(chunk);
			if (text) deliver(Buffer.from(text, "utf8"));
		});
		const ended = () => {
			if (closed) return;
			const stdoutTail = stdoutDecoder.end();
			const stderrTail = stderrDecoder.end();
			if (stdoutTail) deliver(Buffer.from(stdoutTail, "utf8"));
			if (stderrTail) deliver(Buffer.from(stderrTail, "utf8"));
			closed = true;
			this.streams.delete(session);
			if (onClose && !closeNotified) {
				closeNotified = true;
				onClose();
			}
		};
		child.on("close", ended);
		child.on("error", ended);
		this.streams.add(session);
		return session;
	}

	dispose() {
		for (const child of this.children) {
			try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
		}
		for (const stream of this.streams) stream.close();
		this.children.clear();
		this.streams.clear();
	}
}
