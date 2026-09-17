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
	signal,
	onStart,
	onClose,
} = {}) {
	const started = Date.now();
	const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
	const abortMessage = () => signal?.reason?.message || "command cancelled";
	if (signal?.aborted) return Promise.resolve({
		ok: false, code: -1, stdout: "", stderr: abortMessage(),
		aborted: true, timedOut: false, durationMs: 0,
	});
	return new Promise((resolve) => {
		const child = cp.spawn("/bin/bash", ["-c", command], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const stdout = createLimitedOutput();
		const stderr = createLimitedOutput();
		let timedOut = false;
		let aborted = false;
		let stdinError;
		let settled = false;
		let leaderExited = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			finalizeLimitedOutput(stdout);
			finalizeLimitedOutput(stderr);
			onClose?.(child);
			resolve({
				...result,
				stdout: limitedOutputText(stdout),
				stderr: limitedOutputText(stderr) || result.error || "",
				timedOut,
				aborted,
				durationMs: Date.now() - started,
			});
		};
		const stop = (reason) => {
			if (settled) return;
			if (!leaderExited) {
				try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
			}
			child.stdout.destroy();
			child.stderr.destroy();
			finish({ ok: false, code: -1, error: reason });
		};
		const onAbort = () => {
			if (settled || aborted) return;
			aborted = true;
			stop(abortMessage());
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop(`command timed out after ${budget} ms`);
		}, budget);
		child.stdout.on("data", (chunk) => appendLimitedOutput(stdout, chunk, maxOutputBytes));
		child.stderr.on("data", (chunk) => appendLimitedOutput(stderr, chunk, maxOutputBytes));
		child.on("error", (error) => finish({ ok: false, code: -1, error: error.message }));
		child.on("exit", () => {
			leaderExited = true;
		});
		child.on("close", (code) => {
			if (settled) return;
			finish({
				ok: code === 0 && !timedOut && !aborted && (!stdinError || isBrokenPipe(stdinError)),
				code: timedOut || aborted ? -1 : (code ?? -1),
				error: aborted ? abortMessage() : stdinError && !isBrokenPipe(stdinError) ? stdinError.message : undefined,
			});
		});
		child.stdin.on("error", (error) => { stdinError = error; });
		onStart?.(child, stop);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		if (!aborted) {
			if (stdinData === undefined) child.stdin.end();
			else child.stdin.end(stdinData);
		}
	});
}

/** Local implementation of the transport contract used by the sched plugin. */
export class LocalTransport {
	constructor(options = {}) {
		this.options = { ...options };
		this.children = new Map();
		this.streams = new Set();
	}

	exec(command, options = {}) {
		return runChild(String(command), {
			...this.options,
			...options,
			onStart: (child, stop) => this.children.set(child, stop),
			onClose: (child) => this.children.delete(child),
		});
	}

	execStdin(command, data, options = {}) {
		return runChild(String(command), {
			...this.options,
			...options,
			stdinData: data,
			onStart: (child, stop) => this.children.set(child, stop),
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
		let leaderExited = false;
		let killTimer;
		let pending = createLimitedOutput();
		const pendingLimit = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		const session = {
			get onData() { return onData; },
			set onData(handler) {
				onData = typeof handler === "function" ? handler : undefined;
				if (onData) {
					finalizeLimitedOutput(pending);
					const text = limitedOutputText(pending);
					pending = createLimitedOutput();
					if (text) onData(Buffer.from(text, "utf8"));
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
				if (closed || killTimer !== undefined) return;
				if (leaderExited) {
					child.stdout.destroy();
					child.stderr.destroy();
					ended();
					return;
				}
				try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
				killTimer = setTimeout(() => {
					if (!leaderExited) {
						try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
					}
					child.stdout.destroy();
					child.stderr.destroy();
					ended();
				}, 1000);
				killTimer.unref?.();
			},
			pause: () => { child.stdout.pause(); child.stderr.pause(); },
			resume: () => { child.stdout.resume(); child.stderr.resume(); },
		};
		const deliver = (chunk) => {
			if (onData) onData(chunk);
			else appendLimitedOutput(pending, chunk, pendingLimit);
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
			clearTimeout(killTimer);
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
		child.on("exit", () => { leaderExited = true; });
		this.streams.add(session);
		return session;
	}

	dispose() {
		for (const stop of this.children.values()) stop("local transport disposed");
		for (const stream of this.streams) stream.close();
		this.children.clear();
		this.streams.clear();
	}
}
