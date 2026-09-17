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

import {
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import ssh2 from "ssh2";
import {
	appendLimitedOutput,
	createLimitedOutput,
	finalizeLimitedOutput,
	limitedOutputText,
} from "./output-limit.js";

const { Client, utils: ssh2Utils } = ssh2;

export const INTERACTIVE_AUTH_TIMEOUT_MS = 180_000;

const DEFAULTS = {
	idleTimeoutMs: 30 * 60_000,
	connectTimeoutMs: 15_000,
	interactiveAuthTimeoutMs: INTERACTIVE_AUTH_TIMEOUT_MS,
	keepaliveIntervalMs: 15_000,
	maxOutputBytes: 2 * 1024 * 1024,
	defaultExecTimeoutMs: 60_000,
};

export const HOST_STORE_MAX_BYTES = 1024 * 1024;
export const SSH_CONFIG_MAX_BYTES = 1024 * 1024;
export const KEYBOARD_INTERACTIVE_PROMPT_CAP = 32;
const HOST_STORE_MAX_HOSTS = 1024;
const HOST_STORE_MAX_JUMPS = 32;
const HOST_STORE_MAX_TAGS = 128;
const HOST_STORE_MAX_HOST_KEYS = 16;
const HOST_KEY_SOURCES = new Set(["legacy", "manual", "known_hosts", "probe"]);

function storedString(value, label, maxChars, { required = false } = {}) {
	if (typeof value !== "string" || (required && value.length === 0)) {
		throw new Error(`${label} must be ${required ? "a non-empty " : ""}string`);
	}
	if (value.length > maxChars) throw new Error(`${label} exceeds its size limit`);
	return value;
}

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

function safePromptText(value, maxChars = 500) {
	const raw = String(value ?? "").slice(0, maxChars);
	return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
		if (char === "\n") return "\\n";
		if (char === "\r") return "\\r";
		if (char === "\t") return "\\t";
		return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
}

export function normalizeKeyboardInteractivePrompts(prompts) {
	if (!Array.isArray(prompts)) return [];
	return prompts.map((value, index) => {
		const source = value && typeof value === "object" ? value : {};
		const prompt = value && typeof value === "object" ? (source.prompt ?? source.text) : value;
		return {
			id: String(index),
			prompt: safePromptText(prompt),
			echo: source.echo === true,
		};
	});
}

function normalizeInteractiveAnswers(value, count) {
	const raw = Array.isArray(value) ? value : (value && Array.isArray(value.answers) ? value.answers : [value]);
	return Array.from({ length: count }, (_, index) => String(raw[index] ?? ""));
}

function normalizeHostKey(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const fingerprint = String(value).trim();
	if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) {
		throw new Error("hostKey must be an OpenSSH SHA256 fingerprint");
	}
	return fingerprint;
}

function normalizeHostKeyRecord(value, defaultSource = "manual") {
	const source = typeof value === "string" ? { fingerprint: value } : value;
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		throw new Error("host key trust record must be an object");
	}
	const fingerprint = normalizeHostKey(source.fingerprint);
	if (!fingerprint) throw new Error("host key trust record fingerprint is required");
	const algorithm = source.algorithm === undefined ? undefined : String(source.algorithm).trim();
	if (algorithm !== undefined && !/^[A-Za-z0-9@._+-]{1,128}$/.test(algorithm)) {
		throw new Error("invalid host key algorithm");
	}
	const trustSource = String(source.source ?? defaultSource);
	if (!HOST_KEY_SOURCES.has(trustSource)) throw new Error("invalid host key trust source");
	const trustedAt = source.trustedAt === undefined ? undefined : Number(source.trustedAt);
	if (trustedAt !== undefined && (!Number.isFinite(trustedAt) || trustedAt < 0)) {
		throw new Error("invalid host key trust timestamp");
	}
	return {
		algorithm,
		fingerprint,
		source: trustSource,
		trustedAt,
	};
}

function normalizeHostKeys(value, defaultSource = "manual") {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > HOST_STORE_MAX_HOST_KEYS) {
		throw new Error(`hostKeys must be an array of at most ${HOST_STORE_MAX_HOST_KEYS} entries`);
	}
	const records = [];
	const seen = new Set();
	for (const candidate of value) {
		const record = normalizeHostKeyRecord(candidate, defaultSource);
		if (seen.has(record.fingerprint)) continue;
		seen.add(record.fingerprint);
		records.push(record);
	}
	return records;
}

export function trustedHostKeyRecords(entry) {
	const records = normalizeHostKeys(entry?.hostKeys, "legacy");
	if (records && records.length > 0) return records;
	const legacy = normalizeHostKey(entry?.hostKey);
	return legacy ? [{ fingerprint: legacy, source: "legacy", algorithm: undefined, trustedAt: undefined }] : [];
}

function ownedByCurrentUser(info) {
	return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function validateStoredHost(entry) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		throw new Error("invalid host store entry");
	}
	const alias = storedString(entry.alias, "host alias", 128, { required: true });
	if (!/^[A-Za-z0-9_.-]+$/.test(alias)) throw new Error("invalid host store alias");
	storedString(entry.host, `host '${alias}' address`, 255, { required: true });
	storedString(entry.user, `host '${alias}' user`, 255, { required: true });
	if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
		throw new Error(`invalid port in host store entry '${alias}'`);
	}
	if (!entry.auth || typeof entry.auth !== "object" || Array.isArray(entry.auth) || !Object.hasOwn(AUTH_FIELDS, entry.auth.kind)) {
		throw new Error(`invalid auth in host store entry '${alias}'`);
	}
	if (entry.auth.kind === "key") {
		storedString(entry.auth.keyPath, `host '${alias}' keyPath`, 4096, { required: true });
	} else if (entry.auth.kind === "password") {
		if (entry.auth.password !== undefined) storedString(entry.auth.password, `host '${alias}' password`, 65_536);
	} else if (entry.auth.agentPath !== undefined) {
		storedString(entry.auth.agentPath, `host '${alias}' agentPath`, 4096);
	}
	for (const field of ["passphrase", "kbdintPassword"]) {
		if (entry.auth[field] !== undefined) storedString(entry.auth[field], `host '${alias}' ${field}`, 65_536);
	}
	if (entry.hostKey !== undefined) normalizeHostKey(entry.hostKey);
	if (entry.proxyJump !== undefined) {
		if (!Array.isArray(entry.proxyJump) || entry.proxyJump.length > HOST_STORE_MAX_JUMPS) {
			throw new Error(`invalid proxyJump in host store entry '${alias}'`);
		}
		for (const jumpAlias of entry.proxyJump) {
			if (
				typeof jumpAlias !== "string"
				|| jumpAlias.length > 128
				|| !/^[A-Za-z0-9_.-]+$/.test(jumpAlias)
			) {
				throw new Error(`invalid proxyJump in host store entry '${alias}'`);
			}
		}
	}
	if (entry.tags !== undefined) {
		if (!Array.isArray(entry.tags) || entry.tags.length > HOST_STORE_MAX_TAGS) {
			throw new Error(`invalid tags in host store entry '${alias}'`);
		}
		for (const tag of entry.tags) storedString(tag, `host '${alias}' tag`, 128);
	}
	for (const field of ["description", "environment", "location"]) {
		if (entry[field] !== undefined) storedString(entry[field], `host '${alias}' ${field}`, 4096);
	}
	for (const field of ["createdAt", "updatedAt"]) {
		if (entry[field] !== undefined && (!Number.isFinite(entry[field]) || entry[field] < 0)) {
			throw new Error(`invalid ${field} in host store entry '${alias}'`);
		}
	}
	if (entry.revision !== undefined && (!Number.isInteger(entry.revision) || entry.revision < 0)) {
		throw new Error(`invalid revision in host store entry '${alias}'`);
	}
	const hostKeys = normalizeHostKeys(entry.hostKeys, "legacy");
	if (hostKeys && hostKeys.length > 0 && entry.hostKey !== undefined) {
		const primary = normalizeHostKey(entry.hostKey);
		if (!hostKeys.some((record) => record.fingerprint === primary)) {
			throw new Error(`hostKey must be present in hostKeys for '${alias}'`);
		}
	}
	if (entry.hostKeyAlias !== undefined) {
		storedString(entry.hostKeyAlias, `host '${alias}' hostKeyAlias`, 255, { required: true });
	}
	return entry;
}

function validateHostStoreDocument(document) {
	if (
		!document
		|| typeof document !== "object"
		|| Array.isArray(document)
		|| document.version !== 1
		|| (document.revision !== undefined && (!Number.isInteger(document.revision) || document.revision < 0))
		|| !Array.isArray(document.hosts)
		|| document.hosts.length > HOST_STORE_MAX_HOSTS
	) {
		throw new Error("invalid host store document");
	}
	const aliases = new Set();
	for (const entry of document.hosts) {
		validateStoredHost(entry);
		if (aliases.has(entry.alias)) throw new Error("duplicate alias in host store");
		aliases.add(entry.alias);
	}
	return document;
}

function serializeHostStore(document) {
	validateHostStoreDocument(document);
	const serialized = JSON.stringify(document, null, 2) + "\n";
	if (Buffer.byteLength(serialized, "utf8") > HOST_STORE_MAX_BYTES) {
		throw new Error(`host store exceeds the ${HOST_STORE_MAX_BYTES}-byte UTF-8 size limit`);
	}
	return serialized;
}

function readBoundedFd(fd, maxBytes, label) {
	const chunks = [];
	let total = 0;
	while (total <= maxBytes) {
		const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
		const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
		if (bytesRead === 0) break;
		chunks.push(chunk.subarray(0, bytesRead));
		total += bytesRead;
	}
	if (total > maxBytes) {
		throw new Error(`${label} exceeds the ${maxBytes}-byte size limit`);
	}
	return Buffer.concat(chunks, total);
}


export class HostStore {
	constructor(file = join(homedir(), ".dsh", "dsh-ssh.json")) {
		this.file = file;
		this.data = { version: 1, revision: 0, hosts: [] };
		this.externalChangeGeneration = 0;
		this.#load();
	}

	#load() {
		this.data = this.#readCurrent();
	}

	#readCurrent() {
		if (!existsSync(this.file)) return { version: 1, revision: 0, hosts: [] };
		let fd;
		try {
			const pathInfo = lstatSync(this.file);
			if (
				!pathInfo.isFile()
				|| pathInfo.isSymbolicLink()
				|| !ownedByCurrentUser(pathInfo)
				|| pathInfo.nlink !== 1
				|| (pathInfo.mode & 0o077) !== 0
				|| pathInfo.size > HOST_STORE_MAX_BYTES
			) {
				throw new Error("host store must be an owned regular file with mode 0600");
			}
			fd = openSync(
				this.file,
				constants.O_RDONLY
					| (constants.O_CLOEXEC ?? 0)
					| (constants.O_NOFOLLOW ?? 0),
			);
			const info = fstatSync(fd);
			if (
				!info.isFile()
				|| !ownedByCurrentUser(info)
				|| info.nlink !== 1
				|| info.dev !== pathInfo.dev
				|| info.ino !== pathInfo.ino
				|| info.size > HOST_STORE_MAX_BYTES
			) {
				throw new Error("host store changed during secure open");
			}
			const bytes = readBoundedFd(fd, HOST_STORE_MAX_BYTES, "host store");
			const loaded = validateHostStoreDocument(JSON.parse(bytes.toString("utf8")));
			return {
				...loaded,
				revision: loaded.revision ?? 0,
				hosts: loaded.hosts.map((entry) => ({ ...entry, revision: entry.revision ?? 0 })),
			};
		} catch (error) {
			throw new Error(`invalid or unsafe SSH host store: ${error.message}`, { cause: error });
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	#prepareDirectory() {
		const directory = dirname(this.file);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const directoryInfo = lstatSync(directory);
		if (
			!directoryInfo.isDirectory()
			|| directoryInfo.isSymbolicLink()
			|| !ownedByCurrentUser(directoryInfo)
		) {
			throw new Error("host store directory must be an owned real directory");
		}
		const directoryFd = openSync(
			directory,
			constants.O_RDONLY
				| (constants.O_DIRECTORY ?? 0)
				| (constants.O_CLOEXEC ?? 0)
				| (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const openedDirectory = fstatSync(directoryFd);
			if (
				!openedDirectory.isDirectory()
				|| !ownedByCurrentUser(openedDirectory)
				|| openedDirectory.dev !== directoryInfo.dev
				|| openedDirectory.ino !== directoryInfo.ino
			) {
				throw new Error("host store directory changed during secure open");
			}
			fchmodSync(directoryFd, 0o700);
		} finally {
			closeSync(directoryFd);
		}
		return { directory, directoryInfo };
	}

	#clearStaleLock(lockPath) {
		let fd;
		try {
			const pathInfo = lstatSync(lockPath);
			if (
				!pathInfo.isFile()
				|| pathInfo.isSymbolicLink()
				|| !ownedByCurrentUser(pathInfo)
				|| pathInfo.nlink !== 1
				|| (pathInfo.mode & 0o077) !== 0
				|| pathInfo.size > 4096
			) {
				throw new Error("host store lock is unsafe");
			}
			fd = openSync(
				lockPath,
				constants.O_RDONLY
					| (constants.O_CLOEXEC ?? 0)
					| (constants.O_NOFOLLOW ?? 0),
			);
			const info = fstatSync(fd);
			if (
				!info.isFile()
				|| !ownedByCurrentUser(info)
				|| info.nlink !== 1
				|| info.dev !== pathInfo.dev
				|| info.ino !== pathInfo.ino
				|| info.size > 4096
			) {
				throw new Error("host store lock changed during secure open");
			}
			const metadata = JSON.parse(readBoundedFd(fd, 4096, "host store lock").toString("utf8"));
			if (!Number.isInteger(metadata?.pid) || metadata.pid < 1) {
				throw new Error("host store lock metadata is invalid");
			}
			try {
				process.kill(metadata.pid, 0);
				return false;
			} catch (error) {
				if (error?.code !== "ESRCH") return false;
			}
			const latest = lstatSync(lockPath);
			if (latest.dev !== info.dev || latest.ino !== info.ino) return false;
			unlinkSync(lockPath);
			return true;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	#acquireLock() {
		this.#prepareDirectory();
		const lockPath = `${this.file}.lock`;
		const flags = constants.O_WRONLY
			| constants.O_CREAT
			| constants.O_EXCL
			| (constants.O_CLOEXEC ?? 0)
			| (constants.O_NOFOLLOW ?? 0);
		let fd;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				fd = openSync(lockPath, flags, 0o600);
				break;
			} catch (error) {
				if (error?.code !== "EEXIST" || attempt > 0 || !this.#clearStaleLock(lockPath)) {
					const busy = new Error("SSH host store is locked by another dsh process");
					busy.code = "SSH_HOST_STORE_BUSY";
					busy.status = 409;
					throw busy;
				}
			}
		}
		let lockInfo;
		try {
			lockInfo = fstatSync(fd);
			const metadata = `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: randomUUID() })}\n`;
			writeFileSync(fd, metadata, "utf8");
			fchmodSync(fd, 0o600);
			fsyncSync(fd);
		} catch (error) {
			try { closeSync(fd); } catch { /* best-effort close */ }
			try { unlinkSync(lockPath); } catch { /* best-effort owned lock cleanup */ }
			throw error;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			try {
				const current = lstatSync(lockPath);
				if (current.dev === lockInfo.dev && current.ino === lockInfo.ino) unlinkSync(lockPath);
			} finally {
				closeSync(fd);
			}
		};
	}

	#save(candidate) {
		const content = serializeHostStore(candidate);
		const previousContent = serializeHostStore(this.data);
		const releaseLock = this.#acquireLock();
		let current;
		try {
			current = this.#readCurrent();
		} catch (error) {
			releaseLock();
			throw error;
		}
		if (serializeHostStore(current) !== previousContent) {
			this.data = current;
			this.externalChangeGeneration += 1;
			releaseLock();
			const conflict = new Error("SSH host store changed in another dsh process; reload and retry");
			conflict.code = "SSH_HOST_STORE_CONFLICT";
			conflict.status = 409;
			throw conflict;
		}
		let directory;
		let directoryInfo;
		try {
			({ directory, directoryInfo } = this.#prepareDirectory());
		} catch (error) {
			releaseLock();
			throw error;
		}
		const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		const tempFlags = constants.O_WRONLY
			| constants.O_CREAT
			| constants.O_EXCL
			| (constants.O_CLOEXEC ?? 0)
			| (constants.O_NOFOLLOW ?? 0);
		let fd;
		let directoryFd;
		let ownsTmp = false;
		let renamed = false;
		try {
			directoryFd = openSync(
				directory,
				constants.O_RDONLY
					| (constants.O_DIRECTORY ?? 0)
					| (constants.O_CLOEXEC ?? 0)
					| (constants.O_NOFOLLOW ?? 0),
			);
			const openedDirectory = fstatSync(directoryFd);
			if (
				!openedDirectory.isDirectory()
				|| !ownedByCurrentUser(openedDirectory)
				|| openedDirectory.dev !== directoryInfo.dev
				|| openedDirectory.ino !== directoryInfo.ino
			) {
				throw new Error("host store directory changed during secure open");
			}
			fchmodSync(directoryFd, 0o700);
			fd = openSync(tmp, tempFlags, 0o600);
			ownsTmp = true;
			writeFileSync(fd, content, "utf8");
			fchmodSync(fd, 0o600);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			renameSync(tmp, this.file);
			ownsTmp = false;
			renamed = true;
			fsyncSync(directoryFd);
		} catch (error) {
			if (renamed) {
				const rollback = `${tmp}.rollback`;
				let rollbackFd;
				let ownsRollback = false;
				try {
					rollbackFd = openSync(rollback, tempFlags, 0o600);
					ownsRollback = true;
					writeFileSync(rollbackFd, previousContent, "utf8");
					fchmodSync(rollbackFd, 0o600);
					fsyncSync(rollbackFd);
					closeSync(rollbackFd);
					rollbackFd = undefined;
					renameSync(rollback, this.file);
					ownsRollback = false;
					fsyncSync(directoryFd);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						"host store directory commit failed and rollback was not durable",
					);
				} finally {
					if (rollbackFd !== undefined) {
						try { closeSync(rollbackFd); } catch { /* best-effort close */ }
					}
					if (ownsRollback) {
						try { unlinkSync(rollback); } catch { /* best-effort owned temp cleanup */ }
					}
				}
			}
			throw error;
		} finally {
			if (fd !== undefined) {
				try { closeSync(fd); } catch { /* best-effort close */ }
			}
			if (directoryFd !== undefined) {
				try { closeSync(directoryFd); } catch { /* durability was already decided */ }
			}
			if (ownsTmp) {
				try { unlinkSync(tmp); } catch { /* best-effort owned temp cleanup */ }
			}
			releaseLock();
		}
	}

	list() {
		return this.data.hosts;
	}

	refresh() {
		const current = this.#readCurrent();
		if (serializeHostStore(current) === serializeHostStore(this.data)) return false;
		this.data = current;
		this.externalChangeGeneration += 1;
		return true;
	}

	externalGeneration() {
		return this.externalChangeGeneration;
	}

	revision() {
		return this.data.revision ?? 0;
	}

	find(alias) {
		return this.data.hosts.find((h) => h.alias === alias);
	}

	create(payload) {
		const entry = { ...normalizePayload(payload, true), revision: 1 };
		if (this.find(entry.alias)) {
			throw new Error(`alias '${entry.alias}' already exists`);
		}
		const candidate = { version: 1, revision: this.revision() + 1, hosts: [...this.data.hosts, entry] };
		this.#save(candidate);
		this.data = candidate;
		return entry;
	}

	update(alias, payload, { expectedRevision } = {}) {
		const index = this.data.hosts.findIndex((entry) => entry.alias === alias);
		if (index < 0) throw new Error(`alias '${alias}' not found`);
		const entry = this.data.hosts[index];
		if (expectedRevision !== undefined && entry.revision !== expectedRevision) {
			const error = new Error(`alias '${alias}' changed since it was loaded`);
			error.code = "SSH_HOST_REVISION_CONFLICT";
			throw error;
		}
		const patch = normalizePayload(payload, false);
		const auth = patch.auth === undefined
			? entry.auth
			: mergeAuthPatch(entry.auth, patch.auth);
		const next = {
			...entry,
			...patch,
			auth,
			alias,
			revision: (entry.revision ?? 0) + 1,
			updatedAt: Date.now(),
		};
		const hosts = this.data.hosts.slice();
		hosts[index] = next;
		const candidate = { version: 1, revision: this.revision() + 1, hosts };
		this.#save(candidate);
		this.data = candidate;
		return next;
	}

	updateHostKeys(updates) {
		if (!Array.isArray(updates) || updates.length === 0) return [];
		const aliases = new Set();
		const hosts = this.data.hosts.slice();
		const changed = [];
		const now = Date.now();
		for (const update of updates) {
			const alias = String(update?.alias ?? "").trim();
			if (!alias || aliases.has(alias)) throw new Error("host key updates must contain unique aliases");
			aliases.add(alias);
			const index = hosts.findIndex((entry) => entry.alias === alias);
			if (index < 0) throw new Error(`alias '${alias}' not found`);
			const entry = hosts[index];
			if (update.expectedRevision !== undefined && entry.revision !== update.expectedRevision) {
				const error = new Error(`alias '${alias}' changed since it was loaded`);
				error.code = "SSH_HOST_REVISION_CONFLICT";
				throw error;
			}
			const patch = normalizePayload({ hostKeys: update.hostKeys, hostKey: update.hostKey }, false);
			const next = {
				...entry,
				...patch,
				revision: (entry.revision ?? 0) + 1,
				updatedAt: now,
			};
			hosts[index] = next;
			changed.push(next);
		}
		const candidate = { version: 1, revision: this.revision() + 1, hosts };
		this.#save(candidate);
		this.data = candidate;
		return changed;
	}

	remove(alias, { expectedRevision } = {}) {
		const index = this.data.hosts.findIndex((entry) => entry.alias === alias);
		if (index < 0) return false;
		const entry = this.data.hosts[index];
		if (expectedRevision !== undefined && entry.revision !== expectedRevision) {
			const error = new Error(`alias '${alias}' changed since it was loaded`);
			error.code = "SSH_HOST_REVISION_CONFLICT";
			throw error;
		}
		const candidate = {
			version: 1,
			revision: this.revision() + 1,
			hosts: this.data.hosts.filter((_entry, candidateIndex) => candidateIndex !== index),
		};
		this.#save(candidate);
		this.data = candidate;
		return true;
	}

	summarize(entry) {
		let keyReady = true;
		if (entry.auth.kind === "key") {
			const p = entry.auth.keyPath ? expandHome(entry.auth.keyPath) : undefined;
			keyReady = p !== undefined && existsSync(p);
		}
		const hostKeys = trustedHostKeyRecords(entry);
		const credentialReady = entry.auth.kind === "key"
			? keyReady
			: entry.auth.kind === "agent"
				? resolveAgentPath(entry.auth.agentPath) !== undefined
				: Boolean(entry.auth.password || entry.auth.kbdintPassword);
		let chainReady = false;
		try {
			chainReady = resolveHostRoute(this, entry)
				.slice(0, -1)
				.every((hop) => trustedHostKeyRecords(hop).length > 0);
		} catch { /* invalid routes remain visible but cannot bind or connect */ }
		return {
			alias: entry.alias, host: entry.host, port: entry.port, user: entry.user,
			auth: entry.auth.kind, keyReady, credentialReady, proxyJump: entry.proxyJump ?? [],
			hostKey: entry.hostKey,
			hostKeys,
			hostKeyReady: hostKeys.length > 0,
			chainReady,
			hostKeyAlias: entry.hostKeyAlias,
			description: entry.description, environment: entry.environment,
			tags: entry.tags ?? [], location: entry.location,
			createdAt: entry.createdAt, updatedAt: entry.updatedAt,
			revision: entry.revision ?? 0,
		};
	}

	/**
	 * One-shot parse of a standard ~/.ssh/config (Host/HostName/User/Port/
	 * IdentityFile/IdentityAgent/ProxyJump/HostKeyAlias). Existing aliases are skipped.
	 */
	importSshConfig(configPath = join(homedir(), ".ssh", "config")) {
		if (!existsSync(configPath)) throw new Error("ssh config not found: " + configPath);
		let fd;
		let text;
		try {
			const pathInfo = lstatSync(configPath);
			if (
				!pathInfo.isFile()
				|| pathInfo.isSymbolicLink()
				|| !ownedByCurrentUser(pathInfo)
				|| pathInfo.nlink !== 1
				|| (pathInfo.mode & 0o022) !== 0
				|| pathInfo.size > SSH_CONFIG_MAX_BYTES
			) {
				throw new Error("ssh config must be an owned, singly-linked regular file that is not group/other writable");
			}
			fd = openSync(
				configPath,
				constants.O_RDONLY
					| (constants.O_NOFOLLOW ?? 0)
					| (constants.O_NONBLOCK ?? 0)
					| (constants.O_CLOEXEC ?? 0),
			);
			const info = fstatSync(fd);
			if (
				!info.isFile()
				|| !ownedByCurrentUser(info)
				|| info.nlink !== 1
				|| (info.mode & 0o022) !== 0
				|| info.dev !== pathInfo.dev
				|| info.ino !== pathInfo.ino
				|| info.size > SSH_CONFIG_MAX_BYTES
			) {
				throw new Error("ssh config changed during secure open");
			}
			const bytes = readBoundedFd(fd, SSH_CONFIG_MAX_BYTES, "ssh config");
			text = bytes.toString("utf8");
		} catch (error) {
			throw new Error(`invalid or unsafe SSH config: ${error.message}`, { cause: error });
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
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
		const hosts = this.data.hosts.slice();
		const aliases = new Set(hosts.map((entry) => entry.alias));
		for (const block of blocks) {
			if (block.patterns.some((pat) => pat.includes("*") || pat.includes("?"))) continue;
			const alias = block.patterns[0];
			const hostName = block.opts.hostname;
			if (!hostName) { skipped += 1; skippedNames.push(alias); continue; }
			if (aliases.has(alias)) { skipped += 1; continue; }
			try {
				const entry = {
					...normalizePayload({
					alias,
					host: hostName,
					port: parseInt(block.opts.port || "22", 10) || 22,
					user: block.opts.user || process.env.USER || "root",
					hostKeyAlias: block.opts.hostkeyalias,
					auth: block.opts.identityagent
						? { kind: "agent", agentPath: block.opts.identityagent }
						: { kind: "key", keyPath: block.opts.identityfile ? block.opts.identityfile.split(/\s+/)[0] : "~/.ssh/id_rsa" },
					proxyJump: block.opts.proxyjump && block.opts.proxyjump.toLowerCase() !== "none"
						? block.opts.proxyjump.split(/[,\s]+/).filter(Boolean)
						: [],
					tags: ["imported"],
					}, true),
					revision: 1,
				};
				hosts.push(entry);
				aliases.add(alias);
				added += 1;
			} catch {
				skipped += 1;
				skippedNames.push(alias);
			}
		}
		if (added > 0) {
			const candidate = { version: 1, revision: this.revision() + 1, hosts };
			this.#save(candidate);
			this.data = candidate;
		}
		return { parsed: blocks.length, added, skipped, skippedNames };
	}
}

const AUTH_FIELDS = {
	key: ["keyPath", "passphrase"],
	password: ["password"],
	agent: ["agentPath"],
};

const SHARED_AUTH_FIELDS = ["kbdintPassword"];

function hasOwn(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}

export function mergeAuthPatch(currentAuth, authPatch) {
	if (!authPatch || typeof authPatch !== "object" || Array.isArray(authPatch)) {
		throw new Error("auth patch must be an object");
	}
	const kind = hasOwn(authPatch, "kind") ? authPatch.kind : currentAuth?.kind;
	if (!hasOwn(AUTH_FIELDS, kind)) throw new Error("invalid auth kind");
	const sameKind = currentAuth?.kind === kind;
	const next = { kind };
	const allowedFields = [...AUTH_FIELDS[kind], ...SHARED_AUTH_FIELDS];
	for (const field of allowedFields) {
		if (sameKind && hasOwn(currentAuth, field) && currentAuth[field] !== undefined && currentAuth[field] !== null) {
			next[field] = currentAuth[field];
		} else if (
			SHARED_AUTH_FIELDS.includes(field) &&
			hasOwn(currentAuth ?? {}, field) &&
			currentAuth[field] !== undefined &&
			currentAuth[field] !== null
		) {
			next[field] = currentAuth[field];
		}
		if (!hasOwn(authPatch, field) || authPatch[field] === undefined) continue;
		if (authPatch[field] === null) delete next[field];
		else next[field] = String(authPatch[field]);
	}
	return next;
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
	if (requireAll || payload.hostKey !== undefined || payload.hostKeys !== undefined) {
		const explicitPrimary = normalizeHostKey(payload.hostKey);
		const records = payload.hostKeys === undefined
			? (explicitPrimary ? [{ fingerprint: explicitPrimary, source: "manual", trustedAt: now }] : [])
			: normalizeHostKeys(payload.hostKeys);
		if (explicitPrimary && !records.some((record) => record.fingerprint === explicitPrimary)) {
			throw new Error("hostKey must be present in hostKeys");
		}
		out.hostKeys = records;
		out.hostKey = explicitPrimary ?? records[0]?.fingerprint;
	}
	if (requireAll || payload.hostKeyAlias !== undefined) {
		const hostKeyAlias = pickStr(payload.hostKeyAlias);
		out.hostKeyAlias = hostKeyAlias || undefined;
	}
	if (Array.isArray(payload.proxyJump)) out.proxyJump = payload.proxyJump.map(String);
	if (requireAll || payload.description !== undefined) out.description = payload.description ? String(payload.description) : undefined;
	if (requireAll || payload.environment !== undefined) out.environment = payload.environment ? String(payload.environment) : undefined;
	if (requireAll || payload.location !== undefined) out.location = payload.location ? String(payload.location) : undefined;
	if (Array.isArray(payload.tags) || requireAll) out.tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
	if (requireAll) { out.alias = alias; out.createdAt = now; out.updatedAt = now; }
	const auth = payload.auth;
	if (auth && typeof auth === "object" && !Array.isArray(auth)) {
		const kind = auth.kind;
		if ((requireAll || kind !== undefined) && !hasOwn(AUTH_FIELDS, kind)) {
			throw new Error("invalid auth kind");
		}
		const authPatch = {};
		if (kind !== undefined) authPatch.kind = kind;
		for (const field of [...AUTH_FIELDS.key, ...AUTH_FIELDS.password, ...AUTH_FIELDS.agent, ...SHARED_AUTH_FIELDS]) {
			if (!hasOwn(auth, field) || auth[field] === undefined) continue;
			authPatch[field] = auth[field] === null ? null : String(auth[field]);
		}
		if (requireAll) {
			out.auth = mergeAuthPatch(undefined, authPatch);
			if (kind === "key" && !out.auth.keyPath) throw new Error("keyPath required for key auth");
			if (kind === "password" && !out.auth.password) throw new Error("password required for password auth");
		} else if (Object.keys(authPatch).length > 0) {
			out.auth = authPatch;
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
		this.aliasGeneration = new Map();
		this.acquireActive = new Map();
		this.acquireControllers = new Map();
		this.operationControllers = new Map();
		this.authBlocks = new Map();
		this.storeExternalGeneration = typeof store.externalGeneration === "function"
			? store.externalGeneration()
			: 0;
		this.disposed = false;
		this.sweepTimer = setInterval(() => sweepPool(this), Math.max(10_000, this.opts.idleTimeoutMs / 4));
		this.sweepTimer.unref?.();
		/** Optional host hook: `onAliasDrop(alias)` fires before an alias's
		 * connections are invalidated, so the dashboard can cancel pending
		 * interactive-auth challenges targeting the dropped alias. */
		this.onAliasDrop = null;
	}

	/**
	 * Browser-mediated authentication bridge. The prompter receives the SSH
	 * challenge plus signal/deadlineAt and returns a discriminated broker
	 * outcome. Only { state: "answered", answers } is submitted to ssh2.
	 */
	setInteractivePrompter(fn) {
		this.interactivePrompter = fn;
	}

	/** Only explicit connect/test actions may resume a cancelled authentication. */
	resumeAuthentication(alias) {
		this.authBlocks.delete(alias);
	}

	list(query) {
		refreshEngineStore(this);
		const needle = query?.trim().toLowerCase();
		return this.store.list()
			.filter((e) => !needle
				|| e.alias.toLowerCase().includes(needle)
				|| (e.description ?? "").toLowerCase().includes(needle)
				|| e.host.toLowerCase().includes(needle)
				|| (e.tags ?? []).some((t) => t.toLowerCase().includes(needle)))
			.map((e) => this.store.summarize(e));
	}

	async exec(alias, command, timeoutMs, options = {}) {
		return execCommand(this, alias, command, timeoutMs, undefined, 1, options);
	}

	async execOnce(alias, command, timeoutMs, options = {}) {
		return execCommand(this, alias, command, timeoutMs, undefined, 1, options);
	}

	/** Explicit replay path for callers that have classified the command as idempotent. */
	async execRetryable(alias, command, timeoutMs, options = {}) {
		const attempts = Number.isInteger(options.attempts) && options.attempts > 0
			? options.attempts
			: 3;
		return execCommand(this, alias, command, timeoutMs, undefined, attempts, options);
	}

	/** 带 stdin 载荷的执行（远端临时文件写入等）。 */
	async execStdin(alias, command, stdinData, timeoutMs, options = {}) {
		return execCommand(this, alias, command, timeoutMs, stdinData, 1, options);
	}

	async openShell(alias, size, options = {}) {
		this.resumeAuthentication(alias);
		return openShell(this, alias, size, options);
	}

	async test(alias) {
		this.resumeAuthentication(alias);
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
		const invalidated = sshLifecycleError("SSH_ALIAS_INVALIDATED", `alias '${alias}' was invalidated`);
		abortOperations(this, alias, invalidated);
		// Transport switches (bind/unbind/use-system/delete) land here; a
		// challenge pending for the dropped alias would otherwise linger in the
		// dashboard until its own 180s deadline.
		if (typeof this.onAliasDrop === "function") {
			try { this.onAliasDrop(alias); } catch { /* host hook must not break teardown */ }
		}
		const pendingControllers = this.acquireControllers.get(alias);
		if (
			!this.pool.has(alias) &&
			!this.acquireQueue.has(alias) &&
			(this.acquireActive.get(alias) ?? 0) === 0
			&& (pendingControllers?.size ?? 0) === 0
		) {
			this.aliasGeneration.delete(alias);
			this.acquireControllers.delete(alias);
			return;
		}
		this.aliasGeneration.set(alias, (this.aliasGeneration.get(alias) ?? 0) + 1);
		abortPendingAcquires(this, alias, invalidated);
		disposeRecord(this, alias);
	}

	dispose() {
		this.disposed = true;
		clearInterval(this.sweepTimer);
		const disposed = sshLifecycleError("SSH_ENGINE_DISPOSED", "SSH engine disposed");
		for (const alias of this.operationControllers.keys()) abortOperations(this, alias, disposed);
		const pendingAliases = new Set([
			...this.acquireQueue.keys(),
			...this.acquireControllers.keys(),
		]);
		for (const alias of pendingAliases) {
			this.aliasGeneration.set(alias, (this.aliasGeneration.get(alias) ?? 0) + 1);
			abortPendingAcquires(this, alias, disposed);
		}
		for (const alias of [...this.pool.keys()]) disposeRecord(this, alias, undefined, { force: true });
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

export function formatSshError(error) {
	return msg(error);
}

export function hostKeyFingerprint(rawKey) {
	return `SHA256:${createHash("sha256")
		.update(rawKey)
		.digest("base64")
		.replace(/=+$/, "")}`;
}

export function inspectHostKey(rawKey) {
	let algorithm;
	try {
		const parsed = ssh2Utils.parseKey(rawKey);
		const key = Array.isArray(parsed) ? parsed[0] : parsed;
		if (!(key instanceof Error) && typeof key?.type === "string") algorithm = key.type;
	} catch { /* the fingerprint remains authoritative even if type parsing fails */ }
	return { algorithm, fingerprint: hostKeyFingerprint(rawKey) };
}

export function buildHostProbeConfig(entry, sock, opts, observe) {
	if (!entry.host) throw new Error(`alias '${entry.alias}': host is empty — fix the entry`);
	if (!entry.user) throw new Error(`alias '${entry.alias}': user is empty — fix the entry`);
	if (typeof observe !== "function") throw new Error("host key probe observer is required");
	const config = {
		host: entry.host,
		port: entry.port,
		username: entry.user,
		readyTimeout: opts.connectTimeoutMs,
		keepaliveInterval: 0,
		tryKeyboard: false,
		authHandler: () => false,
		hostVerifier: (rawKey) => {
			observe(inspectHostKey(rawKey));
			return false;
		},
	};
	if (sock !== undefined) config.sock = sock;
	return config;
}

export function buildConnectConfig(entry, sock, opts) {
	if (!entry.host) throw new Error(`alias '${entry.alias}': host is empty — fix the entry`);
	if (!entry.user) throw new Error(`alias '${entry.alias}': user is empty — fix the entry`);
	const expectedHostKeys = new Set(trustedHostKeyRecords(entry).map((record) => record.fingerprint));
	if (expectedHostKeys.size === 0) {
		throw new Error(`alias '${entry.alias}': pinned host key fingerprint is required`);
	}
	const config = {
		host: entry.host,
		port: entry.port,
		username: entry.user,
		readyTimeout: opts.connectTimeoutMs,
		keepaliveInterval: opts.keepaliveIntervalMs,
		keepaliveCountMax: 3,
	};
	config.hostVerifier = (rawKey) => expectedHostKeys.has(hostKeyFingerprint(rawKey));
	if (sock !== undefined) config.sock = sock;
	// 静态 keyboard-interactive 应答仅接受显式 kbdintPassword；
	// password 主认证不能代替可能包含密码+动态码的交互式质询。
	const kbdintAnswer = entry.auth.kbdintPassword;
	if (kbdintAnswer) {
		config.tryKeyboard = true;
		config._kbdintAnswer = kbdintAnswer; // 内部约定字段，connectClient 消费
	}
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

function isPrivateKeyPassphraseError(error) {
	const text = msg(error);
	return /cannot parse privatekey.*(?:passphrase|unsupported state|unable to authenticate data)/i.test(text);
}

function interactiveClock(engine) {
	const configured = engine.opts?.clock;
	return configured
		&& typeof configured.now === "function"
		&& typeof configured.setTimeout === "function"
		&& typeof configured.clearTimeout === "function"
		? configured
		: {
			now: () => Date.now(),
			setTimeout: (callback, delay) => setTimeout(callback, delay),
			clearTimeout: (timer) => clearTimeout(timer),
		};
}

function interactiveAuthError(state, cause) {
	let message;
	let code;
	if (state === "cancelled") {
		message = "SSH interactive authentication was cancelled";
		code = "SSH_INTERACTIVE_AUTH_CANCELLED";
	} else if (state === "expired") {
		message = "SSH interactive authentication deadline expired";
		code = "SSH_INTERACTIVE_AUTH_DEADLINE";
	} else if (state === "rejected") {
		message = "SSH interactive authentication prompt failed";
		code = "SSH_INTERACTIVE_AUTH_REJECTED";
	} else {
		message = "SSH interactive authentication returned an invalid outcome";
		code = "SSH_INTERACTIVE_AUTH_INVALID_OUTCOME";
	}
	if (cause !== undefined) message += `: ${msg(cause)}`;
	const error = new Error(message);
	error.code = code;
	if (cause !== undefined) error.cause = cause;
	return error;
}

function startInteractiveAuthDeadline(auth) {
	if (auth.timer !== undefined || auth.controller.signal.aborted) return;
	const remaining = Math.max(0, auth.deadlineAt - auth.clock.now());
	auth.timer = auth.clock.setTimeout(() => {
		auth.timer = undefined;
		auth.controller.abort(interactiveAuthError("expired"));
	}, remaining);
}

function clearInteractiveAuthDeadline(auth) {
	if (auth.timer === undefined) return;
	auth.clock.clearTimeout(auth.timer);
	auth.timer = undefined;
}

function abortInteractiveAuth(auth, error) {
	clearInteractiveAuthDeadline(auth);
	if (!auth.controller.signal.aborted) auth.controller.abort(error);
}

function abortReason(auth) {
	return auth.controller.signal.reason instanceof Error
		? auth.controller.signal.reason
		: interactiveAuthError("expired");
}

async function requestInteractiveAnswers(prompter, request, count, auth) {
	startInteractiveAuthDeadline(auth);
	const signal = auth.controller.signal;
	if (signal.aborted) throw abortReason(auth);

	let outcome;
	try {
		outcome = await new Promise((resolve, reject) => {
			let settled = false;
			const finish = (callback, value) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				callback(value);
			};
			const onAbort = () => finish(reject, abortReason(auth));
			signal.addEventListener("abort", onAbort, { once: true });
			Promise.resolve()
				.then(() => prompter({ ...request, signal, deadlineAt: auth.deadlineAt }))
				.then(
					(value) => finish(resolve, value),
					(error) => finish(reject, error),
				);
		});
	} catch (cause) {
		const error = signal.aborted
			? abortReason(auth)
			: interactiveAuthError("rejected", cause);
		abortInteractiveAuth(auth, error);
		throw error;
	}

	if (!outcome || outcome.state !== "answered" || !Array.isArray(outcome.answers)) {
		const state = outcome?.state === "cancelled" || outcome?.state === "expired"
			? outcome.state
			: "rejected";
		const error = interactiveAuthError(state);
		abortInteractiveAuth(auth, error);
		throw error;
	}
	return normalizeInteractiveAnswers(outcome.answers, count);
}

async function connectWithInteractiveAuth(engine, config, alias, options = {}) {
	const auth = config._interactiveAuth;
	const signal = options.signal;
	const abortForOpen = () => {
		if (auth !== undefined) {
			abortInteractiveAuth(auth, sshAbortError(signal, alias));
		}
	};
	if (auth !== undefined) {
		signal?.addEventListener?.("abort", abortForOpen, { once: true });
		if (signal?.aborted) abortForOpen();
	}
	try {
		try {
			return await connectClient(config, options);
		} catch (error) {
			if (!isPrivateKeyPassphraseError(error) || auth === undefined) {
				if (auth !== undefined) abortInteractiveAuth(auth, error);
				throw error;
			}
			try {
				const response = await requestInteractiveAnswers(
					auth.prompter,
					{
						alias,
						method: "private-key-passphrase",
						name: "",
						instr: "",
						lang: "",
						prompts: [{ prompt: "Private key passphrase", echo: false }],
					},
					1,
					auth,
				);
				const passphrase = response[0];
				if (!passphrase) {
					abortInteractiveAuth(auth, error);
					throw error;
				}
				return await connectClient({ ...config, passphrase }, options);
			} catch (promptError) {
				abortInteractiveAuth(auth, promptError);
				throw promptError;
			}
		}
	} finally {
		signal?.removeEventListener?.("abort", abortForOpen);
	}
}

function connectClient(config, { signal, deadlineAt, clock = interactiveClock({}) } = {}) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		const auth = config._interactiveAuth;
		let settled = false;
		let deadlineTimer;
		let interactivePending = false;
		const removeAbortListeners = () => {
			auth?.controller.signal.removeEventListener("abort", onAuthAbort);
			signal?.removeEventListener?.("abort", onOpenAbort);
			if (deadlineTimer !== undefined) clock.clearTimeout(deadlineTimer);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			removeAbortListeners();
			try { client.destroy(); } catch { /* already closed */ }
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		const rejectOversizedPrompts = (prompts) => {
			if (
				Array.isArray(prompts)
				&& prompts.length <= KEYBOARD_INTERACTIVE_PROMPT_CAP
			) {
				return false;
			}
			const error = interactiveAuthError(
				"rejected",
				new Error(
					`keyboard-interactive prompt count exceeds the ${KEYBOARD_INTERACTIVE_PROMPT_CAP}-prompt cap`,
				),
			);
			if (auth !== undefined) abortInteractiveAuth(auth, error);
			fail(error);
			return true;
		};
		const onAuthAbort = () => fail(abortReason(auth));
		const onOpenAbort = () => {
			const error = sshAbortError(signal, config.host ?? "connection");
			if (auth !== undefined) abortInteractiveAuth(auth, error);
			fail(error);
		};
		if (auth !== undefined) {
			startInteractiveAuthDeadline(auth);
			auth.controller.signal.addEventListener("abort", onAuthAbort, { once: true });
			if (auth.controller.signal.aborted) {
				onAuthAbort();
				return;
			}
		}
		signal?.addEventListener?.("abort", onOpenAbort, { once: true });
		if (signal?.aborted) {
			onOpenAbort();
			return;
		}
		if (Number.isFinite(deadlineAt)) {
			const remaining = deadlineAt - clock.now();
			if (remaining <= 0) {
				fail(sshDeadlineError(config.host ?? "connection"));
				return;
			}
			deadlineTimer = clock.setTimeout(
				() => fail(sshDeadlineError(config.host ?? "connection")),
				remaining,
			);
		}
		client.once("ready", () => {
			if (settled) {
				try { client.end(); } catch { /* late connection already closed */ }
				return;
			}
			settled = true;
			removeAbortListeners();
			if (auth !== undefined) clearInteractiveAuthDeadline(auth);
			resolve(client);
		});
		if (config._kbdintAnswer !== undefined) {
			client.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
				if (rejectOversizedPrompts(prompts)) return;
				finish(new Array(prompts.length).fill(config._kbdintAnswer));
			});
		} else if (auth !== undefined) {
			client.on("keyboard-interactive", (name, instr, lang, prompts, finish) => {
				if (rejectOversizedPrompts(prompts)) return;
				if (interactivePending) {
					const error = interactiveAuthError(
						"rejected",
						new Error("concurrent keyboard-interactive challenge exceeds the per-connection limit"),
					);
					abortInteractiveAuth(auth, error);
					fail(error);
					return;
				}
				interactivePending = true;
				const normalizedPrompts = normalizeKeyboardInteractivePrompts(prompts);
				requestInteractiveAnswers(
					auth.prompter,
					{
						alias: auth.alias,
						method: "keyboard-interactive",
						name: safePromptText(name),
						instr: safePromptText(instr),
						lang: safePromptText(lang, 80),
						prompts: normalizedPrompts,
					},
					normalizedPrompts.length,
					auth,
				).then(
					(answers) => {
						interactivePending = false;
						if (!settled) finish(answers);
					},
					(error) => {
						interactivePending = false;
						fail(error);
					},
				);
			});
		}
		client.on("error", fail);
		try {
			if (auth !== undefined) {
				config.readyTimeout = Math.max(1, auth.deadlineAt - auth.clock.now());
			}
			client.connect(config);
		} catch (error) {
			fail(error);
		}
	});
}

function sshDeadlineError(label) {
	const error = new Error(`SSH deadline expired while opening ${label}`);
	error.code = "SSH_OPEN_DEADLINE";
	return error;
}

function sshAbortError(signal, label) {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error(`SSH open aborted while opening ${label}`);
	error.name = "AbortError";
	error.code = "SSH_OPEN_ABORTED";
	return error;
}

export function withSshDeadline(promise, {
	alias,
	label = alias,
	clock = {
		now: () => Date.now(),
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: (timer) => clearTimeout(timer),
	},
	deadlineAt,
	signal,
	disposeLate,
}) {
	const remaining = Number.isFinite(deadlineAt) ? deadlineAt - clock.now() : Infinity;
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer;
		const cleanup = () => {
			if (timer !== undefined) clock.clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => fail(sshAbortError(signal, label));
		if (signal?.aborted) {
			fail(sshAbortError(signal, label));
		} else {
			signal?.addEventListener?.("abort", onAbort, { once: true });
			if (remaining <= 0) fail(sshDeadlineError(label));
			else if (Number.isFinite(remaining)) {
				timer = clock.setTimeout(() => fail(sshDeadlineError(label)), remaining);
			}
		}
		Promise.resolve(promise).then(
			(value) => {
				if (settled) {
					disposeLate?.(value);
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error) => fail(error),
		);
	});
}

export function waitForSshOpen(begin, options) {
	const clock = options.clock ?? {
		now: () => Date.now(),
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: (timer) => clearTimeout(timer),
	};
	const label = options.label ?? options.alias;
	const remaining = Number.isFinite(options.deadlineAt)
		? options.deadlineAt - clock.now()
		: Infinity;
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer;
		const cleanup = () => {
			if (timer !== undefined) clock.clearTimeout(timer);
			options.signal?.removeEventListener?.("abort", onAbort);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => fail(sshAbortError(options.signal, label));
		if (options.signal?.aborted) {
			fail(sshAbortError(options.signal, label));
		} else if (remaining <= 0) {
			fail(sshDeadlineError(label));
		} else {
			options.signal?.addEventListener?.("abort", onAbort, { once: true });
			if (Number.isFinite(remaining)) {
				timer = clock.setTimeout(() => fail(sshDeadlineError(label)), remaining);
			}
		}
		if (settled) return;
		try {
			begin((error, value) => {
				if (error) {
					fail(error);
					return;
				}
				if (settled) {
					options.disposeLate?.(value);
					return;
				}
				let prepared;
				try {
					prepared = options.prepare ? options.prepare(value) : value;
				} catch (prepareError) {
					options.disposeLate?.(value);
					fail(prepareError);
					return;
				}
				settled = true;
				cleanup();
				resolve(prepared);
			});
		} catch (error) {
			fail(error);
		}
	});
}

/** Attach browser-mediated keyboard-interactive auth with one absolute transport deadline. */
export function attachInteractiveAuth(engine, config, alias, deadlineAt, options = {}) {
	if (config._kbdintAnswer !== undefined) return config;
	// Callers that must stay invisible (event-tail pollers) opt out: a
	// background reconnect must never surface an auth challenge modal.
	if (options.interactiveAuth === false) return config;
	if (typeof engine.interactivePrompter !== "function") return config;
	const configuredTimeout = engine.opts?.interactiveAuthTimeoutMs;
	const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
		? configuredTimeout
		: INTERACTIVE_AUTH_TIMEOUT_MS;
	const clock = interactiveClock(engine);
	const absoluteDeadline = deadlineAt ?? (clock.now() + timeoutMs);
	config.tryKeyboard = true;
	config.readyTimeout = Math.max(1, absoluteDeadline - clock.now());
	config._interactiveAuth = {
		alias,
		prompter: engine.interactivePrompter,
		clock,
		deadlineAt: absoluteDeadline,
		controller: new AbortController(),
		timer: undefined,
	};
	return config;
}


export function resolveHostRoute(store, entry) {
	const aliases = [...(entry.proxyJump ?? []), entry.alias];
	const seen = new Set();
	return aliases.map((alias, index) => {
		if (seen.has(alias)) {
			const error = new Error(`duplicate or recursive ProxyJump alias '${alias}'`);
			error.code = "SSH_PROXY_JUMP_INVALID";
			throw error;
		}
		seen.add(alias);
		const candidate = store.find(alias);
		if (!candidate) {
			const error = new Error(`proxyJump alias '${alias}' not found — create it first`);
			error.code = "SSH_PROXY_JUMP_MISSING";
			throw error;
		}
		if (index < aliases.length - 1 && (candidate.proxyJump ?? []).length > 0) {
			const error = new Error(
				`nested ProxyJump on '${alias}' is not supported; flatten the complete route on '${entry.alias}'`,
			);
			error.code = "SSH_PROXY_JUMP_NESTED";
			throw error;
		}
		return candidate;
	});
}

function probeClient(config, { signal, deadlineAt, clock, label }) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		let observation;
		let settled = false;
		let deadlineTimer;
		const cleanup = () => {
			signal?.removeEventListener?.("abort", onAbort);
			if (deadlineTimer !== undefined) clock.clearTimeout(deadlineTimer);
		};
		const destroy = () => {
			try { client.destroy(); } catch { /* already closed */ }
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			destroy();
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		const succeed = () => {
			if (settled || observation === undefined) return;
			settled = true;
			cleanup();
			resolve(observation);
		};
		const onAbort = () => fail(sshAbortError(signal, label));
		const remaining = deadlineAt - clock.now();
		if (remaining <= 0) {
			fail(sshDeadlineError(label));
			return;
		}
		deadlineTimer = clock.setTimeout(() => fail(sshDeadlineError(label)), remaining);
		signal?.addEventListener?.("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		const originalVerifier = config.hostVerifier;
		config.hostVerifier = (rawKey) => {
			const accepted = originalVerifier(rawKey);
			observation ??= inspectHostKey(rawKey);
			queueMicrotask(destroy);
			return accepted;
		};
		client.once("ready", () => fail(new Error(`host key probe unexpectedly authenticated to ${label}`)));
		client.on("error", (error) => {
			if (observation === undefined) fail(error);
		});
		client.once("close", () => {
			if (observation !== undefined) succeed();
			else fail(new Error(`SSH connection closed before presenting a host key for ${label}`));
		});
		try { client.connect(config); } catch (error) { fail(error); }
	});
}

/**
 * Observe the first untrusted identity in a target's flat ProxyJump route.
 * Credentials are used only for already-pinned prefix hops. The observed node
 * always receives a config with no password, private key, agent, or kbdint data.
 */
export async function probeHostKey(engine, targetAlias, options = {}) {
	refreshEngineStore(engine);
	const target = engine.store.find(targetAlias);
	if (!target) throw new Error(`alias '${targetAlias}' not found — add it first`);
	const route = resolveHostRoute(engine.store, target);
	let probeIndex;
	if (options.probeAlias !== undefined) {
		probeIndex = route.findIndex((entry) => entry.alias === options.probeAlias);
		if (probeIndex < 0) throw new Error(`alias '${options.probeAlias}' is not in target route '${targetAlias}'`);
	} else {
		probeIndex = route.findIndex((entry) => trustedHostKeyRecords(entry).length === 0);
	}
	if (probeIndex < 0) {
		return { state: "already_trusted", route: route.map((entry) => entry.alias) };
	}
	for (let index = 0; index < probeIndex; index += 1) {
		if (trustedHostKeyRecords(route[index]).length === 0) {
			const error = new Error(`ProxyJump dependency '${route[index].alias}' must be trusted first`);
			error.code = "SSH_TRUST_DEPENDENCY";
			error.alias = route[index].alias;
			throw error;
		}
	}

	const hops = [];
	let sock;
	const clock = options.clock ?? interactiveClock(engine);
	const nonInteractive = options.interactiveAuth === false;
	const configuredTimeout = !nonInteractive && typeof engine.interactivePrompter === "function"
		? engine.opts?.interactiveAuthTimeoutMs
		: engine.opts?.connectTimeoutMs;
	const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
		? configuredTimeout
		: (!nonInteractive && typeof engine.interactivePrompter === "function" ? INTERACTIVE_AUTH_TIMEOUT_MS : 15_000);
	const deadlineAt = options.deadlineAt ?? (clock.now() + timeoutMs);
	const signal = options.signal;
	const closePrefix = () => {
		try { sock?.destroy?.(); } catch { /* already closed */ }
		for (const client of hops.reverse()) { try { client.end(); } catch { /* already closed */ } }
	};
	try {
		for (let index = 0; index < probeIndex; index += 1) {
			const hop = route[index];
			const hopCfg = buildConnectConfig(hop, sock, engine.opts);
			hopCfg.readyTimeout = Math.max(1, deadlineAt - clock.now());
			attachInteractiveAuth(engine, hopCfg, hop.alias, deadlineAt, options);
			const hopClient = await withSshDeadline(
				connectWithInteractiveAuth(engine, hopCfg, hop.alias, { signal, deadlineAt, clock }),
				{
					label: `ProxyJump ${hop.alias}`,
					clock,
					deadlineAt,
					signal,
					disposeLate: (client) => client.end(),
				},
			);
			hops.push(hopClient);
			const next = route[index + 1];
			const forwarded = new Promise((resolve, reject) => {
				hopClient.forwardOut("127.0.0.1", 0, next.host, next.port, (error, stream) => {
					if (error) reject(error); else resolve(stream);
				});
			});
			sock = await withSshDeadline(forwarded, {
				label: `ProxyJump ${hop.alias} forwardOut`,
				clock,
				deadlineAt,
				signal,
				disposeLate: (stream) => stream.destroy?.(),
			});
		}
		const candidate = route[probeIndex];
		let observed;
		const config = buildHostProbeConfig(candidate, sock, engine.opts, (value) => { observed = value; });
		config.readyTimeout = Math.max(1, deadlineAt - clock.now());
		const result = await probeClient(config, {
			signal,
			deadlineAt,
			clock,
			label: candidate.alias,
		});
		return {
			state: "observed",
			alias: candidate.alias,
			host: candidate.host,
			port: candidate.port,
			algorithm: observed?.algorithm ?? result.algorithm,
			fingerprint: observed?.fingerprint ?? result.fingerprint,
			route: route.map((entry) => entry.alias),
		};
	} finally {
		closePrefix();
	}
}



/** Build one full jump chain (ProxyJump): hop clients in order, then target. */
export async function connectChain(engine, entry, options = {}) {
	if (engine.disposed) throw sshLifecycleError("SSH_ENGINE_DISPOSED", "SSH engine disposed");
	if (engine.authBlocks?.has(entry.alias)) {
		const blocked = sshLifecycleError("SSH_AUTH_BLOCKED", `SSH authentication for '${entry.alias}' is paused; reconnect explicitly to resume`);
		blocked.cause = engine.authBlocks.get(entry.alias);
		throw blocked;
	}
	const hops = [];
	let sock;
	const route = resolveHostRoute(engine.store, entry);
	const chain = route.slice(0, -1);
	const clock = options.clock ?? interactiveClock(engine);
	const nonInteractive = options.interactiveAuth === false;
	const configuredTimeout = !nonInteractive && typeof engine.interactivePrompter === "function"
		? engine.opts?.interactiveAuthTimeoutMs
		: engine.opts?.connectTimeoutMs;
	const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
		? configuredTimeout
		: (!nonInteractive && typeof engine.interactivePrompter === "function" ? INTERACTIVE_AUTH_TIMEOUT_MS : 15_000);
	const deadlineAt = options.deadlineAt ?? (clock.now() + timeoutMs);
	const signal = options.signal;
	const closeChain = () => {
		try { sock?.destroy?.(); } catch { /* already closed */ }
		for (const client of hops) { try { client.end(); } catch { /* closed */ } }
	};
	try {
		for (let index = 0; index < chain.length; index += 1) {
			const hop = chain[index];
			const hopAlias = hop.alias;
			const hopCfg = buildConnectConfig(hop, sock, engine.opts);
			hopCfg.readyTimeout = Math.max(1, deadlineAt - clock.now());
			attachInteractiveAuth(engine, hopCfg, hopAlias, deadlineAt, options);
			const hopClient = await withSshDeadline(
				connectWithInteractiveAuth(engine, hopCfg, hopAlias, { signal, deadlineAt, clock }),
				{
					label: `ProxyJump ${hopAlias}`,
					clock,
					deadlineAt,
					signal,
					disposeLate: (client) => {
						try { client.end(); } catch { /* late connection already closed */ }
					},
				},
			);
			hops.push(hopClient);
			const next = index + 1 < chain.length ? chain[index + 1] : undefined;
			const nextHost = next ? next.host : entry.host;
			const nextPort = next ? next.port : entry.port;
			const forwarded = new Promise((resolve, reject) => {
				hopClient.forwardOut("127.0.0.1", 0, nextHost, nextPort, (error, stream) => {
					if (error) reject(error); else resolve(stream);
				});
			});
			sock = await withSshDeadline(forwarded, {
				label: `ProxyJump ${hopAlias} forwardOut`,
				clock,
				deadlineAt,
				signal,
				disposeLate: (stream) => {
					try { stream.destroy?.(); } catch { /* late stream already closed */ }
				},
			});
		}
		const targetCfg = buildConnectConfig(entry, sock, engine.opts);
		targetCfg.readyTimeout = Math.max(1, deadlineAt - clock.now());
		attachInteractiveAuth(engine, targetCfg, entry.alias, deadlineAt, options);
		const target = await withSshDeadline(
			connectWithInteractiveAuth(engine, targetCfg, entry.alias, { signal, deadlineAt, clock }),
			{
				label: entry.alias,
				clock,
				deadlineAt,
				signal,
				disposeLate: (client) => {
					try { client.end(); } catch { /* late connection already closed */ }
				},
			},
		);
		return { client: target, hops };
	} catch (error) {
		closeChain();
		if (isInteractiveAuthTerminal(error)) (engine.authBlocks ??= new Map()).set(entry.alias, error);
		throw error;
	}
}

function sshLifecycleError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function isInteractiveAuthTerminal(error) {
	return typeof error?.code === "string" && error.code.startsWith("SSH_INTERACTIVE_AUTH_");
}

function isNonRetryableSshError(error) {
	return isInteractiveAuthTerminal(error) || [
		"SSH_OPEN_DEADLINE", "SSH_OPEN_ABORTED", "SSH_ALIAS_INVALIDATED",
		"SSH_ENGINE_DISPOSED", "SSH_AUTH_BLOCKED", "SSH_NO_EXISTING_CONNECTION",
	].includes(error?.code) || error?.name === "AbortError";
}

function abortOperations(engine, alias, reason) {
	for (const controller of engine.operationControllers?.get(alias) ?? []) {
		if (!controller.signal.aborted) controller.abort(reason);
	}
}

// The operation's signal persists across every retry even after an idle alias's
// generation is pruned. Dropping an alias can therefore never revive an old
// query through a new connection, and it also stops an already-open channel.
function beginSshOperation(engine, alias, externalSignal) {
	if (engine.disposed) throw sshLifecycleError("SSH_ENGINE_DISPOSED", "SSH engine disposed");
	const controller = new AbortController();
	const operations = engine.operationControllers ??= new Map();
	let controllers = operations.get(alias);
	if (!controllers) operations.set(alias, controllers = new Set());
	controllers.add(controller);
	const onAbort = () => controller.abort(sshAbortError(externalSignal, alias));
	externalSignal?.addEventListener?.("abort", onAbort, { once: true });
	if (externalSignal?.aborted) onAbort();
	return {
		signal: controller.signal,
		release: () => {
			externalSignal?.removeEventListener?.("abort", onAbort);
			controllers.delete(controller);
			if (controllers.size === 0) operations.delete(alias);
		},
	};
}

function abortPendingAcquires(engine, alias, reason) {
	for (const controller of engine.acquireControllers?.get(alias) ?? []) {
		if (!controller.signal.aborted) controller.abort(reason);
	}
}

function pruneAliasGeneration(engine, alias) {
	const controllers = engine.acquireControllers?.get(alias);
	if (controllers?.size === 0) engine.acquireControllers.delete(alias);
	if (
		!engine.pool.has(alias) &&
		!engine.acquireQueue.has(alias) &&
		(engine.acquireActive.get(alias) ?? 0) === 0
		&& (engine.acquireControllers?.get(alias)?.size ?? 0) === 0
	) {
		engine.aliasGeneration.delete(alias);
		engine.acquireActive.delete(alias);
		engine.acquireControllers?.delete(alias);
	}
}

function refreshEngineStore(engine) {
	if (
		typeof engine.store?.refresh !== "function"
		|| typeof engine.store?.externalGeneration !== "function"
	) return;
	const aliases = engine.store.list().map((entry) => entry.alias);
	engine.store.refresh();
	const generation = engine.store.externalGeneration();
	if (generation === engine.storeExternalGeneration) return;
	engine.storeExternalGeneration = generation;
	for (const alias of new Set([...aliases, ...engine.store.list().map((entry) => entry.alias)])) {
		engine.dropAlias(alias);
	}
}

async function acquire(engine, alias, options = {}) {
	if (engine.disposed) throw sshLifecycleError("SSH_ENGINE_DISPOSED", "SSH engine disposed");
	refreshEngineStore(engine);
	const generation = engine.aliasGeneration.get(alias) ?? 0;
	const pending = engine.acquireQueue.get(alias);
	if (pending?.generation === generation) return pending.promise;
	engine.aliasGeneration.set(alias, generation);
	engine.acquireActive.set(alias, (engine.acquireActive.get(alias) ?? 0) + 1);
	const controller = new AbortController();
	const controllers = engine.acquireControllers ??= new Map();
	let aliasControllers = controllers.get(alias);
	if (aliasControllers === undefined) {
		aliasControllers = new Set();
		controllers.set(alias, aliasControllers);
	}
	aliasControllers.add(controller);
	const onExternalAbort = () => {
		if (!controller.signal.aborted) controller.abort(options.signal?.reason);
	};
	options.signal?.addEventListener?.("abort", onExternalAbort, { once: true });
	if (options.signal?.aborted) onExternalAbort();
	const task = doAcquire(engine, alias, generation, {
		...options,
		signal: controller.signal,
	});
	const current = { generation, promise: task, controller };
	engine.acquireQueue.set(alias, current);
	try {
		return await task;
	} finally {
		options.signal?.removeEventListener?.("abort", onExternalAbort);
		aliasControllers.delete(controller);
		if (aliasControllers.size === 0) controllers.delete(alias);
		if (engine.acquireQueue.get(alias) === current) engine.acquireQueue.delete(alias);
		engine.acquireActive.set(alias, Math.max(0, (engine.acquireActive.get(alias) ?? 1) - 1));
		pruneAliasGeneration(engine, alias);
	}
}

async function doAcquire(engine, alias, generation, options = {}) {
	const entry = engine.store.find(alias);
	if (!entry) throw new Error(`alias '${alias}' not found — add it first`);
	const { client, hops } = await connectChain(engine, entry, options);
	if (engine.disposed || (engine.aliasGeneration.get(alias) ?? 0) !== generation) {
		endRecordChain({ client, hops });
		throw sshLifecycleError(engine.disposed ? "SSH_ENGINE_DISPOSED" : "SSH_ALIAS_INVALIDATED",
			engine.disposed ? "SSH engine disposed" : `alias '${alias}' was invalidated while connecting`);
	}
	const record = {
		client, hops, idleAt: Date.now(), pinned: false, broken: false,
		inFlight: 0, disposed: false, closed: false,
	};
	client.on("error", () => { record.broken = true; });
	client.on("close", () => { record.broken = true; });
	engine.pool.set(alias, record);
	return record;
}

export function disposeRecord(engine, alias, record, { force = false } = {}) {
	const current = engine.pool.get(alias);
	if (current === undefined) {
		if (record?.disposed) closeRecord(record, force);
		return;
	}
	if (record !== undefined && current !== record) return; // replaced concurrently
	engine.pool.delete(alias);
	current.disposed = true;
	if (force) closeRecord(current, true); else closeRecordIfIdle(current);
	pruneAliasGeneration(engine, alias);
}

function closeRecordIfIdle(record) {
	if (!record.closed && record.inFlight === 0) closeRecord(record);
}

function closeRecord(record, force = false) {
	if (record.closed || (!force && record.inFlight > 0)) return;
	record.closed = true;
	endRecordChain(record);
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

async function reservePooledRecord(engine, alias, options) {
	if (engine.disposed) throw sshLifecycleError("SSH_ENGINE_DISPOSED", "SSH engine disposed");
	refreshEngineStore(engine);
	if (options.signal?.aborted) throw sshAbortError(options.signal, alias);
	let record = engine.pool.get(alias);
	if (record?.broken || record?.disposed || record?.closed) {
		disposeRecord(engine, alias, record);
		record = undefined;
	}
	if (!record && options.requireExistingConnection) {
		throw sshLifecycleError("SSH_NO_EXISTING_CONNECTION", `No authenticated SSH connection for '${alias}'; connect explicitly first`);
	}
	record = await withSshDeadline(record ? Promise.resolve(record) : acquire(engine, alias, options), {
		...options,
		label: `${alias} pooled connection`,
	});
	if (options.signal?.aborted) throw sshAbortError(options.signal, alias);
	if (record.disposed || record.closed) {
		throw sshLifecycleError("SSH_ALIAS_INVALIDATED", `alias '${alias}' was invalidated while opening a channel`);
	}
	record.idleAt = Date.now();
	record.inFlight += 1;
	return record;
}

function releasePooledRecord(record) {
	record.inFlight -= 1;
	record.idleAt = Date.now();
	if (record.disposed) closeRecordIfIdle(record);
}

/** Replays require an explicit idempotent caller and never replay cancellation. */
async function withClient(engine, alias, fn, attempts = 1, openOptions = {}) {
	if (engine.disposed) throw sshLifecycleError("SSH_ENGINE_DISPOSED", "SSH engine disposed");
	refreshEngineStore(engine);
	const operation = beginSshOperation(engine, alias, openOptions.signal);
	const context = { ...openOptions, signal: operation.signal };
	let lastError;
	try {
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			let record;
			try {
				record = await reservePooledRecord(engine, alias, context);
			} catch (error) {
				lastError = error;
				if (attempt === attempts || operation.signal.aborted || isNonRetryableSshError(error)) throw error;
				continue;
			}
			try {
				return await fn(record.client, context);
			} catch (error) {
				lastError = error;
				if (operation.signal.aborted || isNonRetryableSshError(error)
					|| (!record.broken && error?.retryable !== true)) throw error;
				disposeRecord(engine, alias, record);
			} finally {
				releasePooledRecord(record);
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	} finally {
		operation.release();
	}
}

export async function execCommand(
	engine,
	alias,
	command,
	timeoutMs,
	stdinData,
	attempts = 1,
	options = {},
) {
	const started = Date.now();
	const budget = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : engine.opts.defaultExecTimeoutMs;
	const allowedAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
	const clock = options.clock ?? interactiveClock(engine);
	const configuredOpenTimeout = options.interactiveAuth !== false && typeof engine.interactivePrompter === "function"
		? engine.opts?.interactiveAuthTimeoutMs
		: budget;
	const openTimeout = Number.isFinite(configuredOpenTimeout) && configuredOpenTimeout > 0
		? configuredOpenTimeout
		: budget;
	const openOptions = {
		clock,
		signal: options.signal,
		deadlineAt: options.deadlineAt ?? (clock.now() + openTimeout),
		interactiveAuth: options.interactiveAuth,
		requireExistingConnection: options.requireExistingConnection,
	};
	return withClient(engine, alias, (client, openOptions) => {
		return waitForSshOpen(
			(callback) => client.exec(command, callback),
			{
				...openOptions,
				label: `${alias} exec channel`,
				disposeLate: (lateStream) => {
					try { lateStream.close(); } catch { /* late channel already closed */ }
				},
				prepare: (stream) => {
					const stdout = createLimitedOutput();
					const stderr = createLimitedOutput();
					let timedOut = false;
					let settled = false;
					return new Promise((resolve, reject) => {
						let timer;
						const output = () => {
							finalizeLimitedOutput(stdout);
							finalizeLimitedOutput(stderr);
							return {
								stdout: limitedOutputText(stdout),
								stderr: limitedOutputText(stderr),
							};
						};
						const cleanup = () => {
							if (timer !== undefined) clock.clearTimeout(timer);
							openOptions.signal?.removeEventListener?.("abort", onAbort);
						};
						const finishTimedOut = () => {
							if (settled) return;
							settled = true;
							timedOut = true;
							cleanup();
							try { stream.signal("KILL"); } catch { /* channel gone */ }
							try { stream.close(); } catch { /* channel gone */ }
							resolve({
								success: false,
								exitCode: null,
								timedOut: true,
								...output(),
								durationMs: Date.now() - started,
								error: `command timed out after ${budget} ms`,
							});
						};
						const onAbort = () => {
							if (settled) return;
							settled = true;
							cleanup();
							try { stream.close(); } catch { /* channel gone */ }
							reject(sshAbortError(openOptions.signal, `${alias} exec command`));
						};
						const commandDeadlineAt = options.deadlineAt
							?? (options.interactiveAuth !== false && typeof engine.interactivePrompter === "function"
								? clock.now() + budget
								: openOptions.deadlineAt);
						const remaining = commandDeadlineAt - clock.now();
						if (remaining <= 0) {
							finishTimedOut();
							return;
						}
						timer = clock.setTimeout(finishTimedOut, remaining);
						openOptions.signal?.addEventListener?.("abort", onAbort, { once: true });
						if (openOptions.signal?.aborted) {
							onAbort();
							return;
						}
						stream.on("data", (chunk) => appendLimitedOutput(stdout, chunk, engine.opts.maxOutputBytes));
						stream.stderr.on("data", (chunk) => appendLimitedOutput(stderr, chunk, engine.opts.maxOutputBytes));
						if (stdinData !== undefined) {
							try { stream.end(stdinData); } catch { /* channel gone */ }
						}
						stream.on("close", (code) => {
							if (settled) return;
							settled = true;
							cleanup();
							if (typeof code !== "number" && !timedOut) {
								const ambiguous = new Error(
									"ssh: connection lost mid-flight; command outcome is unknown (channel closed without an exit status)",
								);
								ambiguous.retryable = true;
								reject(ambiguous);
								return;
							}
							resolve({
								success: code === 0,
								exitCode: code,
								timedOut,
								...output(),
								durationMs: Date.now() - started,
							});
						});
						stream.on("error", (streamError) => {
							if (settled) return;
							settled = true;
							cleanup();
							reject(streamError);
						});
					});
				},
			},
		);
	}, allowedAttempts, openOptions);
}

/** Resolve the connection-open deadline independently of stream lifetime. */
function sshOpenContext(engine, options = {}) {
	const clock = options.clock ?? interactiveClock(engine);
	const nonInteractive = options.interactiveAuth === false;
	const configuredTimeout = !nonInteractive && typeof engine.interactivePrompter === "function"
		? engine.opts?.interactiveAuthTimeoutMs
		: engine.opts?.connectTimeoutMs;
	const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
		? configuredTimeout
		: (!nonInteractive && typeof engine.interactivePrompter === "function" ? INTERACTIVE_AUTH_TIMEOUT_MS : 15_000);
	return {
		clock,
		signal: options.signal,
		deadlineAt: options.deadlineAt ?? (clock.now() + timeoutMs),
		// Propagate the opt-out: connectChain/attachInteractiveAuth key off
		// `interactiveAuth === false` to suppress challenge creation, and the
		// context is what actually reaches connectChain.
		interactiveAuth: options.interactiveAuth,
	};
}

function closeStandaloneChain(client, hops) {
	try { client.end(); } catch { /* closed */ }
	for (const hop of hops) { try { hop.end(); } catch { /* closed */ } }
}

const MAX_EARLY_STREAM_BYTES = 64 * 1024;

function attachEarlyStreamReplay({
	stream,
	engine,
	session,
	terminalProperty,
	teardown,
	overflowTerminal,
}) {
	const configuredLimit = Number(engine.opts?.maxOutputBytes);
	const limit = Number.isFinite(configuredLimit) && configuredLimit > 0
		? Math.min(Math.floor(configuredLimit), MAX_EARLY_STREAM_BYTES)
		: MAX_EARLY_STREAM_BYTES;
	let onData;
	let onTerminal;
	let earlyChunks = [];
	let earlyBytes = 0;
	let terminalArgs;
	let terminalSet = false;
	let terminalDelivered = false;

	const replay = () => {
		if (typeof onData === "function" && earlyChunks.length > 0) {
			const chunks = earlyChunks;
			earlyChunks = [];
			earlyBytes = 0;
			for (const chunk of chunks) onData(chunk);
		}
		if (
			terminalSet
			&& !terminalDelivered
			&& earlyChunks.length === 0
			&& typeof onTerminal === "function"
		) {
			terminalDelivered = true;
			onTerminal(...terminalArgs);
		}
	};
	const settle = (args, { closeStream = false } = {}) => {
		if (terminalSet) return;
		terminalSet = true;
		terminalArgs = args;
		teardown();
		if (closeStream) {
			try { stream.close(); } catch { /* channel gone */ }
		}
		replay();
	};

	Object.defineProperty(session, "onData", {
		configurable: true,
		enumerable: true,
		get: () => onData,
		set: (handler) => {
			onData = typeof handler === "function" ? handler : undefined;
			replay();
		},
	});
	Object.defineProperty(session, terminalProperty, {
		configurable: true,
		enumerable: true,
		get: () => onTerminal,
		set: (handler) => {
			onTerminal = typeof handler === "function" ? handler : undefined;
			replay();
		},
	});
	stream.on("data", (chunk) => {
		if (terminalSet) return;
		if (typeof onData === "function") {
			onData(chunk);
			return;
		}
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const remaining = limit - earlyBytes;
		if (bytes.byteLength <= remaining) {
			earlyChunks.push(bytes);
			earlyBytes += bytes.byteLength;
			return;
		}
		if (remaining > 0) {
			earlyChunks.push(Buffer.from(bytes.subarray(0, remaining)));
			earlyBytes += remaining;
		}
		const error = new Error(`SSH stream early-data buffer exceeded the ${limit}-byte cap`);
		settle(overflowTerminal(error), { closeStream: true });
	});
	return settle;
}


export async function openExecStream(engine, alias, command, options = {}) {
	if (engine.disposed) throw sshLifecycleError("SSH_ENGINE_DISPOSED", "SSH engine disposed");
	refreshEngineStore(engine);
	const operation = beginSshOperation(engine, alias, options.signal);
	const context = {
		...sshOpenContext(engine, options),
		signal: operation.signal,
		requireExistingConnection: options.requireExistingConnection,
	};
	let record;
	let client;
	let hops;
	let released = false;
	const releaseTransport = () => {
		if (released) return;
		released = true;
		if (record) releasePooledRecord(record);
		else if (client) closeStandaloneChain(client, hops);
		operation.release();
	};
	try {
		if (context.signal.aborted) throw sshAbortError(context.signal, alias);
		if (options.requireExistingConnection || options.pooled) {
			record = await reservePooledRecord(engine, alias, context);
			client = record.client;
		} else {
			const entry = engine.store.find(alias);
			if (!entry) throw new Error(`alias '${alias}' not found — add it first`);
			({ client, hops } = await connectChain(engine, entry, context));
		}
		return await waitForSshOpen(
			(callback) => client.exec(command, callback),
			{
				...context,
				label: `${alias} exec channel`,
				disposeLate: (lateStream) => {
					try { lateStream.close(); } catch { /* late channel already closed */ }
				},
				prepare: (stream) => {
					let tornDown = false;
					const teardown = () => {
						if (tornDown) return;
						tornDown = true;
						context.signal.removeEventListener("abort", onAbort);
						client.removeListener?.("close", onClientClose);
						client.removeListener?.("error", onClientError);
						releaseTransport();
					};
					let settle;
					const onAbort = () => settle([sshAbortError(context.signal, `${alias} exec stream`)], { closeStream: true });
					const onClientClose = () => settle([new Error("SSH connection closed during exec stream")], { closeStream: true });
					const onClientError = (error) => settle([error], { closeStream: true });
					const session = {
						close: () => settle([undefined], { closeStream: true }),
					};
					settle = attachEarlyStreamReplay({
						stream,
						engine,
						session,
						terminalProperty: "onClose",
						teardown,
						overflowTerminal: (error) => [error],
					});
					stream.on("close", () => settle([undefined]));
					stream.on("error", (streamError) => settle([streamError], { closeStream: true }));
					client.on?.("close", onClientClose);
					client.on?.("error", onClientError);
					context.signal.addEventListener("abort", onAbort, { once: true });
					if (context.signal.aborted) onAbort();
					return session;
				},
			},
		);
	} catch (error) {
		releaseTransport();
		throw error;
	}
}

// ─────────────────────────────────────────────── PTY shell (terminal) ──

/**
 * Open a PTY shell session (standalone connection: closing the shell can
 * never tear down a pooled exec/tunnel sharing the alias).
 */
export async function openShell(engine, alias, size, options = {}) {
	if (engine.disposed) throw new Error("SSH engine disposed");
	refreshEngineStore(engine);
	const entry = engine.store.find(alias);
	if (!entry) throw new Error(`alias '${alias}' not found — add it first`);
	const context = sshOpenContext(engine, options);
	const { client, hops } = await connectChain(engine, entry, context);
	try {
		return await waitForSshOpen(
			(callback) => client.shell(
				{ term: "xterm-256color", cols: size.cols, rows: size.rows },
				callback,
			),
			{
				...context,
				label: `${alias} shell channel`,
				disposeLate: (lateStream) => {
					try { lateStream.close(); } catch { /* late channel already closed */ }
				},
				prepare: (stream) => {
					let tornDown = false;
					const teardown = () => {
						if (tornDown) return;
						tornDown = true;
						closeStandaloneChain(client, hops);
					};
					let settle;
					const session = {
						send: (data) => { try { stream.write(data); } catch { /* channel gone */ } },
						resize: (cols, rows) => { try { stream.setWindow(rows, cols, rows, cols); } catch { /* channel gone */ } },
						close: () => {
							try { stream.close(); } catch { /* channel gone */ }
							settle([null]);
						},
						pause: () => { try { stream.pause(); } catch { /* channel gone */ } },
						resume: () => { try { stream.resume(); } catch { /* channel gone */ } },
					};
					settle = attachEarlyStreamReplay({
						stream,
						engine,
						session,
						terminalProperty: "onExit",
						teardown,
						overflowTerminal: (error) => [null, error.message],
					});
					stream.on("close", (code) => settle([code]));
					stream.on("error", (streamError) => settle([null, msg(streamError)]));
					return session;
				},
			},
		);
	} catch (error) {
		closeStandaloneChain(client, hops);
		throw error;
	}
}
