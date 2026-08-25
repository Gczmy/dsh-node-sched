/**
 * Embedded SSH engine for @zzc/dsh-node-sched.
 *
 * Adapted from @linxin666/dsh-ssh (https://github.com/zhu1090093659/dsh-web,
 * packages/dsh-ssh, Apache License 2.0). Ported TypeScript -> ESM JavaScript,
 * trimmed to the Phase-1 surface: host store (+ ~/.ssh/config import),
 * per-alias persistent connection pool with ProxyJump chains, pooled exec
 * with timeout/truncation, and standalone PTY shell sessions for the web
 * terminal. SFTP / tunnels / cluster exec are Phase 2 (engine seams kept).
 *
 * Security model (inherited):
 *  - secrets live in ~/.dsh/dsh-ssh.json (mode 0600); the browser only ever
 *    receives secret-free summaries;
 *  - every route using this engine MUST be fenced loopback-only by the caller;
 *  - ssh-agent auth stores only the agent socket path, never key material.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "ssh2";

const DEFAULTS = {
	idleTimeoutMs: 30 * 60_000,
	connectTimeoutMs: 15_000,
	keepaliveIntervalMs: 15_000,
	maxOutputBytes: 2 * 1024 * 1024,
	defaultExecTimeoutMs: 60_000,
};

// ─────────────────────────────────────────────────────────────── store ──

export function expandHome(p) {
	if (!p) return p;
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function normalizeAgentPath(p) {
	const v = (p ?? "").trim();
	if (!v) return undefined;
	if (v.toLowerCase() === "pageant") return process.platform === "win32" ? "pageant" : undefined;
	return expandHome(v);
}

export class HostStore {
	constructor(file = join(homedir(), ".dsh", "dsh-ssh.json")) {
		this.file = file;
		this.data = { version: 1, hosts: [] };
		this.#load();
	}

	#load() {
		try {
			if (existsSync(this.file)) {
				const parsed = JSON.parse(readFileSync(this.file, "utf8"));
				if (parsed && Array.isArray(parsed.hosts)) this.data = parsed;
			}
		} catch {
			/* corrupted store: start empty, never crash the plugin */
		}
	}

	#save() {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const tmp = this.file + ".tmp";
		writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
		renameSync(tmp, this.file);
	}

	list() {
		return this.data.hosts;
	}

	find(alias) {
		return this.data.hosts.find((h) => h.alias === alias);
	}

	create(payload) {
		const entry = normalizePayload(payload, true);
		this.data.hosts.push(entry);
		this.#save();
		return entry;
	}

	update(alias, payload) {
		const entry = this.find(alias);
		if (!entry) throw new Error(`alias '${alias}' not found`);
		const patch = normalizePayload(payload, false);
		// Omitted auth keeps stored secrets (the browser never receives them back).
		const next = { ...entry, ...patch, auth: patch.auth ?? entry.auth };
		next.alias = alias; // alias is the immutable key
		next.updatedAt = Date.now();
		this.data.hosts.splice(this.data.hosts.indexOf(entry), 1, next);
		this.#save();
		return next;
	}

	remove(alias) {
		const entry = this.find(alias);
		if (!entry) return false;
		this.data.hosts.splice(this.data.hosts.indexOf(entry), 1);
		this.#save();
		return true;
	}

	summarize(entry) {
		let keyReady = true;
		if (entry.auth.kind === "key") {
			const p = entry.auth.keyPath ? expandHome(entry.auth.keyPath) : undefined;
			keyReady = p !== undefined && existsSync(p);
		}
		return {
			alias: entry.alias, host: entry.host, port: entry.port, user: entry.user,
			auth: entry.auth.kind, keyReady, proxyJump: entry.proxyJump ?? [],
			description: entry.description, environment: entry.environment,
			tags: entry.tags ?? [], location: entry.location,
			createdAt: entry.createdAt, updatedAt: entry.updatedAt,
		};
	}

	/**
	 * One-shot parse of a standard ~/.ssh/config (Host/HostName/User/Port/
	 * IdentityFile/User/ProxyJump). Existing aliases are skipped.
	 */
	importSshConfig(configPath = join(homedir(), ".ssh", "config")) {
		if (!existsSync(configPath)) throw new Error("ssh config not found: " + configPath);
		const text = readFileSync(configPath, "utf8");
		const blocks = [];
		let cur = null;
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const m = line.match(/^(\S+)\s+(.+)$/);
			if (!m) continue;
			const key = m[1].toLowerCase().replace(/=.*$/, "");
			const value = m[2].trim();
			if (key === "host") {
				cur = { patterns: value.split(/\s+/), opts: {} };
				blocks.push(cur);
			} else if (cur) {
				cur.opts[key] = value;
			}
		}
		let added = 0, skipped = 0;
		const skippedNames = [];
		for (const block of blocks) {
			if (block.patterns.some((pat) => pat.includes("*") || pat.includes("?"))) continue;
			const alias = block.patterns[0];
			const hostName = block.opts.hostname;
			if (!hostName) { skipped += 1; skippedNames.push(alias); continue; }
			if (this.find(alias)) { skipped += 1; continue; }
			try {
				this.create({
					alias,
					host: hostName,
					port: parseInt(block.opts.port || "22", 10) || 22,
					user: block.opts.user || process.env.USER || "root",
					auth: block.opts.identityagent
						? { kind: "agent", agentPath: block.opts.identityagent }
						: { kind: "key", keyPath: block.opts.identityfile ? block.opts.identityfile.split(/\s+/)[0] : "~/.ssh/id_rsa" },
					proxyJump: block.opts.proxyjump ? block.opts.proxyjump.split(/\s+/) : [],
					tags: ["imported"],
				});
				added += 1;
			} catch {
				skipped += 1;
				skippedNames.push(alias);
			}
		}
		return { parsed: blocks.length, added, skipped, skippedNames };
	}
}

function normalizePayload(payload, requireAll) {
	const alias = String(payload.alias ?? "").trim();
	// 更新语义（requireAll=false）：未提供的字段不出现在补丁里，
	// 绝不用空串覆盖已存值
	const pickStr = (v) => (requireAll || v !== undefined ? String(v ?? "").trim() : undefined);
	const host = pickStr(payload.host);
	const user = pickStr(payload.user);
	if (requireAll) {
		if (!/^[A-Za-z0-9_.-]+$/.test(alias)) throw new Error("invalid alias");
		if (!host) throw new Error("host required");
		if (!user) throw new Error("user required");
	}
	const now = Date.now();
	const out = {};
	if (host !== undefined) out.host = host;
	if (user !== undefined) out.user = user;
	if (requireAll || payload.port !== undefined) out.port = clampInt(payload.port, 1, 65535, 22);
	if (Array.isArray(payload.proxyJump)) out.proxyJump = payload.proxyJump.map(String);
	if (requireAll || payload.description !== undefined) out.description = payload.description ? String(payload.description) : undefined;
	if (requireAll || payload.environment !== undefined) out.environment = payload.environment ? String(payload.environment) : undefined;
	if (requireAll || payload.location !== undefined) out.location = payload.location ? String(payload.location) : undefined;
	if (Array.isArray(payload.tags) || requireAll) out.tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
	if (requireAll) { out.alias = alias; out.createdAt = now; out.updatedAt = now; }
	const auth = payload.auth;
	if (auth && typeof auth === "object") {
		const kind = auth.kind;
		if (!["key", "password", "agent"].includes(kind)) throw new Error("invalid auth kind");
		out.auth = { kind };
		if (kind === "key") {
			out.auth.keyPath = auth.keyPath ? String(auth.keyPath) : undefined;
			out.auth.passphrase = auth.passphrase !== "" && auth.passphrase !== undefined ? String(auth.passphrase) : undefined;
			if (requireAll && !out.auth.keyPath) throw new Error("keyPath required for key auth");
		} else if (kind === "password") {
			if (auth.password) out.auth.password = String(auth.password);
			if (requireAll && !out.auth.password) throw new Error("password required for password auth");
		} else {
			out.auth.agentPath = auth.agentPath ? String(auth.agentPath) : undefined;
		}
	} else if (requireAll) {
		throw new Error("auth required");
	}
	return out;
}

function clampInt(v, lo, hi, dflt) {
	const n = parseInt(v, 10);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(Math.max(n, lo), hi);
}

// ──────────────────────────────────────────────── connection pool ──

export class SshEngine {
	constructor(store, options = {}) {
		this.store = store;
		this.opts = { ...DEFAULTS, ...options };
		this.pool = new Map();       // alias -> record
		this.acquireQueue = new Map();
		this.sweepTimer = setInterval(() => sweepPool(this), Math.max(10_000, this.opts.idleTimeoutMs / 4));
		this.sweepTimer.unref?.();
	}

	list(query) {
		const needle = query?.trim().toLowerCase();
		return this.store.list()
			.filter((e) => !needle
				|| e.alias.toLowerCase().includes(needle)
				|| (e.description ?? "").toLowerCase().includes(needle)
				|| e.host.toLowerCase().includes(needle)
				|| (e.tags ?? []).some((t) => t.toLowerCase().includes(needle)))
			.map((e) => this.store.summarize(e));
	}

	async exec(alias, command, timeoutMs) {
		return execCommand(this, alias, command, timeoutMs);
	}

	/** 带 stdin 载荷的执行（远端临时文件写入等）。 */
	async execStdin(alias, command, stdinData, timeoutMs) {
		return execCommand(this, alias, command, timeoutMs, stdinData);
	}

	async openShell(alias, size) {
		return openShell(this, alias, size);
	}

	async test(alias) {
		const started = Date.now();
		try {
			const result = await this.exec(alias, "echo ok", 10_000);
			return result.success
				? { ok: true, latencyMs: result.durationMs }
				: { ok: false, latencyMs: result.durationMs, error: "remote exit code " + result.exitCode };
		} catch (error) {
			return { ok: false, latencyMs: Date.now() - started, error: msg(error) };
		}
	}

	dropAlias(alias) {
		disposeRecord(this, alias);
	}

	dispose() {
		clearInterval(this.sweepTimer);
		for (const alias of [...this.pool.keys()]) disposeRecord(this, alias);
	}
}

function msg(error) {
	if (error instanceof AggregateError) {
		// DNS 多目标失败：聚合错误的 message 为空，展开子错误才有信息量
		const parts = (error.errors ?? []).map((e) => msg(e));
		return parts.length > 0 ? parts.join("; ") : "all addresses failed";
	}
	const m = error instanceof Error ? error.message : String(error);
	return m || (error && error.constructor && error.constructor.name) || String(error);
}

export function buildConnectConfig(entry, sock, opts) {
	if (!entry.host) throw new Error(`alias '${entry.alias}': host is empty — fix the entry`);
	if (!entry.user) throw new Error(`alias '${entry.alias}': user is empty — fix the entry`);
	const config = {
		host: entry.host,
		port: entry.port,
		username: entry.user,
		readyTimeout: opts.connectTimeoutMs,
		keepaliveInterval: opts.keepaliveIntervalMs,
		keepaliveCountMax: 3,
	};
	if (sock !== undefined) config.sock = sock;
	if (entry.auth.kind === "password") {
		config.password = entry.auth.password;
	} else if (entry.auth.kind === "agent") {
		const agentPath = resolveAgentPath(entry.auth.agentPath);
		if (agentPath === undefined) throw new Error("ssh-agent is not available: set SSH_AUTH_SOCK or configure an agent path");
		config.agent = agentPath;
	} else {
		const keyPath = entry.auth.keyPath === undefined ? undefined : expandHome(entry.auth.keyPath);
		if (keyPath === undefined || !existsSync(keyPath)) {
			throw new Error("private key not found: " + (entry.auth.keyPath ?? "(unset)"));
		}
		config.privateKey = readFileSync(keyPath, "utf8");
		if (entry.auth.passphrase) config.passphrase = entry.auth.passphrase;
	}
	return config;
}

export function resolveAgentPath(agentPath) {
	const explicit = normalizeAgentPath(agentPath);
	if (explicit !== undefined) return explicit;
	const sock = process.env.SSH_AUTH_SOCK;
	if (sock) return sock;
	if (process.platform === "win32") return "pageant";
	return undefined;
}

function connectClient(config) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			try { client.destroy(); } catch { /* already closed */ }
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		client.once("ready", () => { if (!settled) { settled = true; resolve(client); } });
		// Persistent error listener: ssh2 can emit a second 'error' after the
		// once-listener is consumed (TCP ok, handshake drop); without it that
		// surfaces as an unhandled 'error' event crashing the host process.
		client.on("error", fail);
		try {
			client.connect(config);
		} catch (error) {
			fail(error);
		}
	});
}

/** Build one full jump chain (ProxyJump): hop clients in order, then target. */
async function connectChain(engine, entry) {
	const hops = [];
	let sock;
	const chain = entry.proxyJump ?? [];
	try {
		for (let index = 0; index < chain.length; index += 1) {
			const hopAlias = chain[index];
			const hop = engine.store.find(hopAlias);
			if (!hop) throw new Error(`proxyJump alias '${hopAlias}' not found — create it first`);
			const hopClient = await connectClient(buildConnectConfig(hop, sock, engine.opts));
			hops.push(hopClient);
			const next = index + 1 < chain.length ? engine.store.find(chain[index + 1]) : undefined;
			const nextHost = next ? next.host : entry.host;
			const nextPort = next ? next.port : entry.port;
			sock = await new Promise((resolve, reject) => {
				hopClient.forwardOut("127.0.0.1", 0, nextHost, nextPort, (error, stream) => {
					if (error) reject(error); else resolve(stream);
				});
			});
		}
	} catch (error) {
		for (const client of hops) { try { client.end(); } catch { /* closed */ } }
		throw error;
	}
	try {
		const target = await connectClient(buildConnectConfig(entry, sock, engine.opts));
		return { client: target, hops };
	} catch (error) {
		for (const client of hops) { try { client.end(); } catch { /* closed */ } }
		throw error;
	}
}

async function acquire(engine, alias) {
	const pending = engine.acquireQueue.get(alias);
	if (pending !== undefined) return pending;
	const task = doAcquire(engine, alias);
	engine.acquireQueue.set(alias, task);
	try {
		return await task;
	} finally {
		if (engine.acquireQueue.get(alias) === task) engine.acquireQueue.delete(alias);
	}
}

async function doAcquire(engine, alias) {
	const entry = engine.store.find(alias);
	if (!entry) throw new Error(`alias '${alias}' not found — add it first`);
	const { client, hops } = await connectChain(engine, entry);
	const record = { client, hops, idleAt: Date.now(), pinned: false, broken: false, inFlight: 0 };
	client.on("error", () => { record.broken = true; });
	client.on("close", () => { record.broken = true; });
	engine.pool.set(alias, record);
	return record;
}

export function disposeRecord(engine, alias, record) {
	const current = engine.pool.get(alias);
	if (record !== undefined && current !== record) return; // replaced concurrently
	if (current === undefined) return;
	engine.pool.delete(alias);
	endRecordChain(current);
}

function endRecordChain(record) {
	try { record.client.end(); } catch { /* closed */ }
	for (const hop of record.hops) { try { hop.end(); } catch { /* closed */ } }
}

function sweepPool(engine) {
	const cutoff = Date.now() - engine.opts.idleTimeoutMs;
	for (const [alias, record] of engine.pool) {
		if (!record.pinned && record.inFlight === 0 && record.idleAt < cutoff) disposeRecord(engine, alias, record);
	}
}

/** Run fn with a live client; reconnect (≤3 attempts) when broken mid-flight. */
async function withClient(engine, alias, fn, attempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		let record = engine.pool.get(alias);
		if (record === undefined || record.broken) {
			if (record !== undefined) disposeRecord(engine, alias, record);
			record = await acquire(engine, alias);
		}
		record.idleAt = Date.now();
		record.inFlight += 1;
		try {
			const result = await fn(record.client);
			record.idleAt = Date.now();
			return result;
		} catch (error) {
			lastError = error;
			// Retry only on mid-flight connection breaks (a reconnect may replay
			// non-idempotent commands — documented trade-off).
			if (!record.broken) throw error;
			disposeRecord(engine, alias, record);
		} finally {
			record.inFlight -= 1;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function appendOutput(target, chunk, maxBytes) {
	if (target.truncated) return;
	if (target.text.length + chunk.length > maxBytes) {
		let cut = chunk.toString("utf8").slice(0, maxBytes - target.text.length);
		if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
		target.text += cut + "…[output truncated]";
		target.truncated = true;
		return;
	}
	target.text += chunk.toString("utf8");
}

export async function execCommand(engine, alias, command, timeoutMs, stdinData) {
	const started = Date.now();
	const budget = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : engine.opts.defaultExecTimeoutMs;
	return withClient(engine, alias, async (client) => {
		return await new Promise((resolve, reject) => {
			client.exec(command, (error, stream) => {
				if (error) { reject(error); return; }
				const stdout = { text: "", truncated: false };
				const stderr = { text: "", truncated: false };
				let timedOut = false, settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({
						success: false, exitCode: null, timedOut,
						stdout: stdout.text, stderr: stderr.text,
						durationMs: Date.now() - started,
						error: timedOut ? `command timed out after ${budget} ms` : undefined,
					});
				};
				const timer = setTimeout(() => {
					timedOut = true;
					try { stream.signal("KILL"); } catch { /* channel gone */ }
					try { stream.close(); } catch { /* channel gone */ }
					finish(); // hard deadline: settle even if peer never acks close
				}, budget);
				stream.on("data", (chunk) => appendOutput(stdout, chunk, engine.opts.maxOutputBytes));
				stream.stderr.on("data", (chunk) => appendOutput(stderr, chunk, engine.opts.maxOutputBytes));
				// stdin 载荷（如远端临时文件内容）：写完即关 stdin，远端 cat/管道 收尾
				if (stdinData !== undefined) {
					try { stream.end(stdinData); } catch { /* channel gone */ }
				}
				stream.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (typeof code !== "number" && !timedOut) {
						reject(new Error("ssh: connection lost mid-flight (channel closed without an exit status)"));
						return;
					}
					resolve({
						success: code === 0, exitCode: code, timedOut,
						stdout: stdout.text, stderr: stderr.text,
						durationMs: Date.now() - started,
					});
				});
				stream.on("error", (streamError) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(streamError);
				});
			});
		});
	});
}

/**
 * Open a long-running exec stream (log tail 等)：独立连接 + 持久通道，
 * 行数据经 onData 交付；close() 断开。与 openShell 同样的隔离原则。
 */
export async function openExecStream(engine, alias, command) {
	const entry = engine.store.find(alias);
	if (!entry) throw new Error(`alias '${alias}' not found — add it first`);
	const { client, hops } = await connectChain(engine, entry);
	return await new Promise((resolve, reject) => {
		client.exec(command, (error, stream) => {
			if (error) {
				try { client.end(); } catch { /* closed */ }
				for (const hop of hops) { try { hop.end(); } catch { /* closed */ } }
				reject(error);
				return;
			}
			let tornDown = false;
			const teardown = () => {
				if (tornDown) return;
				tornDown = true;
				try { client.end(); } catch { /* closed */ }
				for (const hop of hops) { try { hop.end(); } catch { /* closed */ } }
			};
			const session = {
				onData: undefined,
				onClose: undefined,
				close: () => { try { stream.close(); } catch { /* gone */ } teardown(); },
			};
			stream.on("data", (chunk) => session.onData?.(chunk));
			stream.on("close", () => { teardown(); session.onClose?.(); });
			stream.on("error", () => { teardown(); session.onClose?.(); });
			resolve(session);
		});
	});
}

// ─────────────────────────────────────────────── PTY shell (terminal) ──

/**
 * Open a PTY shell session (standalone connection: closing the shell can
 * never tear down a pooled exec/tunnel sharing the alias).
 */
export async function openShell(engine, alias, size) {
	const entry = engine.store.find(alias);
	if (!entry) throw new Error(`alias '${alias}' not found — add it first`);
	const { client, hops } = await connectChain(engine, entry);
	return await new Promise((resolve, reject) => {
		client.shell({ term: "xterm-256color", cols: size.cols, rows: size.rows }, (error, stream) => {
			if (error) {
				try { client.end(); } catch { /* closed */ }
				for (const hop of hops) { try { hop.end(); } catch { /* closed */ } }
				reject(error);
				return;
			}
			let tornDown = false;
			const teardown = () => {
				if (tornDown) return;
				tornDown = true;
				try { client.end(); } catch { /* closed */ }
				for (const hop of hops) { try { hop.end(); } catch { /* closed */ } }
			};
			const session = {
				send: (data) => { try { stream.write(data); } catch { /* channel gone */ } },
				resize: (cols, rows) => { try { stream.setWindow(rows, cols, rows, cols); } catch { /* channel gone */ } },
				close: () => { try { stream.close(); } catch { /* channel gone */ } teardown(); },
				pause: () => { try { stream.pause(); } catch { /* channel gone */ } },
				resume: () => { try { stream.resume(); } catch { /* channel gone */ } },
			};
			stream.on("data", (chunk) => session.onData?.(chunk));
			stream.on("close", (code) => { teardown(); session.onExit?.(code); });
			stream.on("error", (streamError) => { teardown(); session.onExit?.(null, msg(streamError)); });
			resolve(session);
		});
	});
}
