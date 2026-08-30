import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createHash,
	createPublicKey,
	randomBytes,
	timingSafeEqual,
	verify as verifySignature,
} from "node:crypto";

const SCHEMA_VERSION = 1;
const DEFAULT_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CHALLENGE_TTL_MS = 60 * 1000;
const DEFAULT_CHALLENGE_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_CHALLENGE_RATE_MAX = 8;
const DEFAULT_MAX_DEVICES = 16;
const DEFAULT_MAX_CHALLENGES = 64;
const DEFAULT_MAX_SESSIONS = 128;
const MAX_STORE_BYTES = 1024 * 1024;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const LOOPBACK_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1",
	"::ffff:7f00:1",
]);

export class DeviceAuthError extends Error {
	constructor(message, { status = 400, code = "invalid_request" } = {}) {
		super(message);
		this.name = "DeviceAuthError";
		this.status = status;
		this.code = code;
	}
}

function fail(message, status = 400, code = "invalid_request") {
	throw new DeviceAuthError(message, { status, code });
}

function base64url(bytes) {
	return Buffer.from(bytes).toString("base64url");
}

function digest(value) {
	return createHash("sha256").update(value).digest("base64url");
}

function safeEqualText(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return false;
	const supplied = Buffer.from(left, "utf8");
	const expected = Buffer.from(right, "utf8");
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function masterGeneration(masterToken) {
	return digest(`node-sched-device-auth:v1\0${masterToken}`);
}

function canonicalOrigin(value) {
	if (typeof value !== "string" || !value || value.length > 512) {
		fail("a browser origin is required", 403, "forbidden_origin");
	}
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		fail("browser origin is invalid", 403, "forbidden_origin");
	}
	const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (
		parsed.origin !== value
		|| !["http:", "https:"].includes(parsed.protocol)
		|| !LOOPBACK_HOSTS.has(hostname)
	) {
		fail("browser origin must be an exact loopback origin", 403, "forbidden_origin");
	}
	return parsed.origin;
}

function canonicalClientId(value) {
	const clientId = String(value ?? "").trim();
	if (!CLIENT_ID_PATTERN.test(clientId)) {
		fail("clientId must be 16-128 base64url characters");
	}
	return clientId;
}

function canonicalLabel(value) {
	const label = String(value ?? "Trusted browser").trim();
	if (!label || label.length > 80 || /[\0-\x1f\x7f]/.test(label)) {
		fail("label must be 1-80 printable characters");
	}
	return label;
}

function decodeCoordinate(value, name) {
	if (!BASE64URL_256_PATTERN.test(value ?? "")) {
		fail(`publicKeyJwk.${name} must be a canonical 256-bit base64url value`);
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length !== 32 || base64url(decoded) !== value) {
		fail(`publicKeyJwk.${name} must be a canonical 256-bit base64url value`);
	}
	return value;
}

export function canonicalP256Jwk(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("publicKeyJwk must be a P-256 public JWK");
	}
	if (value.kty !== "EC" || value.crv !== "P-256") {
		fail("publicKeyJwk must use EC P-256");
	}
	if (Object.hasOwn(value, "d")) fail("publicKeyJwk must not contain private key material");
	const jwk = {
		kty: "EC",
		crv: "P-256",
		x: decodeCoordinate(value.x, "x"),
		y: decodeCoordinate(value.y, "y"),
	};
	try {
		const key = createPublicKey({ key: jwk, format: "jwk" });
		if (key.asymmetricKeyType !== "ec") fail("publicKeyJwk must be an EC public key");
	} catch (error) {
		if (error instanceof DeviceAuthError) throw error;
		fail("publicKeyJwk is not a valid P-256 public key");
	}
	return jwk;
}

function canonicalTrustDays(value) {
	if (value === undefined || value === null) return DEFAULT_DEVICE_TTL_MS;
	if (!Number.isInteger(value) || value < 1 || value > 90) {
		fail("trustDays must be an integer between 1 and 90");
	}
	return value * 24 * 60 * 60 * 1000;
}

function ensurePrivateDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const info = fs.lstatSync(directory);
	if (
		!info.isDirectory()
		|| info.isSymbolicLink()
		|| (typeof process.getuid === "function" && info.uid !== process.getuid())
	) {
		throw new Error("trusted browser directory must be an owned real directory");
	}
	fs.chmodSync(directory, 0o700);
}

function readPrivateText(file) {
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY
			| (fs.constants.O_CLOEXEC ?? 0)
			| (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		const info = fs.fstatSync(fd);
		if (
			!info.isFile()
			|| info.nlink !== 1
			|| info.size > MAX_STORE_BYTES
			|| (typeof process.getuid === "function" && info.uid !== process.getuid())
			|| (info.mode & 0o777) !== 0o600
		) {
			throw new Error("trusted browser store must be an owned, single-link mode-0600 file");
		}
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function readPrivateJson(file) {
	return JSON.parse(readPrivateText(file));
}

function writePrivateJson(file, value) {
	const directory = path.dirname(file);
	ensurePrivateDirectory(directory);
	let previousContent;
	try {
		previousContent = readPrivateText(file);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
		throw new Error("trusted browser store exceeds its size limit");
	}
	const temporary = path.join(
		directory,
		`.${path.basename(file)}.${process.pid}.${base64url(randomBytes(12))}.tmp`,
	);
	const temporaryFlags = fs.constants.O_WRONLY
		| fs.constants.O_CREAT
		| fs.constants.O_EXCL
		| (fs.constants.O_CLOEXEC ?? 0)
		| (fs.constants.O_NOFOLLOW ?? 0);
	const directoryFlags = fs.constants.O_RDONLY
		| (fs.constants.O_DIRECTORY ?? 0)
		| (fs.constants.O_CLOEXEC ?? 0)
		| (fs.constants.O_NOFOLLOW ?? 0);
	let temporaryFd;
	let directoryFd;
	let ownsTemporary = false;
	let renamed = false;
	try {
		directoryFd = fs.openSync(directory, directoryFlags);
		temporaryFd = fs.openSync(temporary, temporaryFlags, 0o600);
		ownsTemporary = true;
		fs.writeFileSync(temporaryFd, content, "utf8");
		fs.fchmodSync(temporaryFd, 0o600);
		fs.fsyncSync(temporaryFd);
		fs.closeSync(temporaryFd);
		temporaryFd = undefined;
		fs.renameSync(temporary, file);
		ownsTemporary = false;
		renamed = true;
		fs.fsyncSync(directoryFd);
	} catch (error) {
		if (renamed) {
			const rollback = `${temporary}.rollback`;
			let rollbackFd;
			let ownsRollback = false;
			try {
				if (previousContent === undefined) {
					fs.unlinkSync(file);
				} else {
					rollbackFd = fs.openSync(rollback, temporaryFlags, 0o600);
					ownsRollback = true;
					fs.writeFileSync(rollbackFd, previousContent, "utf8");
					fs.fchmodSync(rollbackFd, 0o600);
					fs.fsyncSync(rollbackFd);
					fs.closeSync(rollbackFd);
					rollbackFd = undefined;
					fs.renameSync(rollback, file);
					ownsRollback = false;
				}
				fs.fsyncSync(directoryFd);
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					"trusted browser directory commit failed and rollback was not durable",
				);
			} finally {
				if (rollbackFd !== undefined) {
					try { fs.closeSync(rollbackFd); } catch { /* best-effort close */ }
				}
				if (ownsRollback) {
					try { fs.unlinkSync(rollback); } catch { /* best-effort owned temp cleanup */ }
				}
			}
		}
		throw error;
	} finally {
		if (temporaryFd !== undefined) {
			try { fs.closeSync(temporaryFd); } catch { /* best-effort close */ }
		}
		if (directoryFd !== undefined) {
			try { fs.closeSync(directoryFd); } catch { /* durability was already decided */ }
		}
		if (ownsTemporary) {
			try { fs.unlinkSync(temporary); } catch { /* best-effort owned temp cleanup */ }
		}
	}
}

function persistedRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	try {
		return {
			clientId: canonicalClientId(value.clientId),
			label: canonicalLabel(value.label),
			origin: canonicalOrigin(value.origin),
			publicKeyJwk: canonicalP256Jwk(value.publicKeyJwk),
			createdAt: Number(value.createdAt),
			expiresAt: Number(value.expiresAt),
			instanceId: String(value.instanceId ?? ""),
			tokenGeneration: String(value.tokenGeneration ?? ""),
		};
	} catch {
		return null;
	}
}

export class TrustedBrowserAuth {
	constructor({
		masterToken,
		file = path.join(os.homedir(), ".dsh", "node-sched-trusted-browsers.json"),
		now = Date.now,
		deviceTtlMs = DEFAULT_DEVICE_TTL_MS,
		sessionTtlMs = DEFAULT_SESSION_TTL_MS,
		challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
		challengeRateWindowMs = DEFAULT_CHALLENGE_RATE_WINDOW_MS,
		challengeRateMax = DEFAULT_CHALLENGE_RATE_MAX,
		maxDevices = DEFAULT_MAX_DEVICES,
		maxChallenges = DEFAULT_MAX_CHALLENGES,
		maxSessions = DEFAULT_MAX_SESSIONS,
	} = {}) {
		if (typeof masterToken !== "string" || !masterToken) {
			throw new Error("trusted browser auth requires the master access token");
		}
		if (typeof now !== "function") throw new Error("trusted browser auth requires a clock");
		this.masterToken = masterToken;
		this.tokenGeneration = masterGeneration(masterToken);
		this.file = file;
		this.now = now;
		this.deviceTtlMs = deviceTtlMs;
		this.sessionTtlMs = sessionTtlMs;
		this.challengeTtlMs = challengeTtlMs;
		this.challengeRateWindowMs = challengeRateWindowMs;
		this.challengeRateMax = challengeRateMax;
		this.maxDevices = maxDevices;
		this.maxChallenges = maxChallenges;
		this.maxSessions = maxSessions;
		this.devices = new Map();
		this.challenges = new Map();
		this.challengeRates = new Map();
		this.sessions = new Map();
		this.connectionsBySession = new Map();
		this.connectionsByClient = new Map();
		this.instanceId = base64url(randomBytes(18));
		this.#load();
	}

	#load() {
		ensurePrivateDirectory(path.dirname(this.file));
		let stored;
		try {
			stored = readPrivateJson(this.file);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			this.#persist();
			return;
		}
		let changed = false;
		if (
			stored?.schemaVersion !== SCHEMA_VERSION
			|| typeof stored.instanceId !== "string"
			|| !CLIENT_ID_PATTERN.test(stored.instanceId)
			|| stored.tokenGeneration !== this.tokenGeneration
		) {
			this.instanceId = base64url(randomBytes(18));
			this.devices.clear();
			this.#persist();
			return;
		}
		this.instanceId = stored.instanceId;
		const now = this.now();
		for (const candidate of Array.isArray(stored.devices) ? stored.devices : []) {
			const record = persistedRecord(candidate);
			if (
				!record
				|| !Number.isFinite(record.createdAt)
				|| !Number.isFinite(record.expiresAt)
				|| record.createdAt > record.expiresAt
				|| record.expiresAt <= now
				|| record.instanceId !== this.instanceId
				|| record.tokenGeneration !== this.tokenGeneration
				|| this.devices.has(record.clientId)
			) {
				changed = true;
				continue;
			}
			this.devices.set(record.clientId, record);
		}
		if (!Array.isArray(stored.devices) || this.devices.size > this.maxDevices) {
			changed = true;
			const newest = [...this.devices.values()]
				.sort((left, right) => right.createdAt - left.createdAt)
				.slice(0, this.maxDevices);
			this.devices = new Map(newest.map((record) => [record.clientId, record]));
		}
		if (changed) this.#persist();
	}

	#persist(devices = this.devices) {
		writePrivateJson(this.file, {
			schemaVersion: SCHEMA_VERSION,
			instanceId: this.instanceId,
			tokenGeneration: this.tokenGeneration,
			devices: [...devices.values()].sort((left, right) => left.createdAt - right.createdAt),
		});
	}

	#pruneExpiredDevices(now = this.now()) {
		const expired = [];
		const candidate = new Map();
		for (const [clientId, record] of this.devices) {
			if (record.expiresAt <= now) expired.push(clientId);
			else candidate.set(clientId, record);
		}
		if (expired.length === 0) return;
		this.#persist(candidate);
		this.devices = candidate;
		for (const clientId of expired) {
			this.#revokeEphemeral(clientId, "authentication expired");
		}
	}

	#pruneEphemeral() {
		const now = this.now();
		for (const [id, challenge] of this.challenges) {
			if (challenge.expiresAt <= now) this.challenges.delete(id);
		}
		for (const [hash, session] of this.sessions) {
			if (session.expiresAt <= now) this.#dropSession(hash, "authentication expired");
		}
		for (const [key, values] of this.challengeRates) {
			const recent = values.filter((timestamp) => now - timestamp < this.challengeRateWindowMs);
			if (recent.length > 0) this.challengeRates.set(key, recent);
			else this.challengeRates.delete(key);
		}
	}

	#device(clientId, origin) {
		const record = this.devices.get(canonicalClientId(clientId));
		if (
			!record
			|| record.expiresAt <= this.now()
			|| record.origin !== canonicalOrigin(origin)
			|| record.instanceId !== this.instanceId
			|| record.tokenGeneration !== this.tokenGeneration
		) {
			fail("trusted browser is unknown or expired", 404, "unknown_client");
		}
		return record;
	}

	isMasterToken(token) {
		return safeEqualText(token, this.masterToken);
	}

	authenticateBearer(token, origin) {
		if (this.isMasterToken(token)) {
			return { kind: "master", clientId: null, expiresAt: null };
		}
		if (typeof token !== "string" || !BASE64URL_256_PATTERN.test(token)) return null;
		this.#pruneEphemeral();
		const hash = digest(`node-sched-session:v1\0${token}`);
		const session = this.sessions.get(hash);
		if (!session || session.origin !== origin || session.expiresAt <= this.now()) return null;
		if (session.clientId !== null) {
			const device = this.devices.get(session.clientId);
			if (
				!device
				|| device.expiresAt <= this.now()
				|| device.origin !== origin
				|| device.instanceId !== this.instanceId
				|| device.tokenGeneration !== this.tokenGeneration
			) {
				this.#dropSession(hash, "trusted browser revoked");
				return null;
			}
		}
		return { ...session, kind: "session", sessionKey: hash };
	}

	#closeConnections(connections, reason) {
		for (const connection of [...(connections ?? [])]) {
			try { connection.close?.(1008, reason); } catch { /* already closed */ }
		}
	}

	#dropSession(hash, reason) {
		const session = this.sessions.get(hash);
		this.sessions.delete(hash);
		const connections = this.connectionsBySession.get(hash);
		this.connectionsBySession.delete(hash);
		this.#closeConnections(connections, reason);
		if (session?.clientId !== null && session?.clientId !== undefined) {
			const byClient = this.connectionsByClient.get(session.clientId);
			if (byClient && connections) {
				for (const connection of connections) byClient.delete(connection);
				if (byClient.size === 0) this.connectionsByClient.delete(session.clientId);
			}
		}
	}

	#issueSession(origin, clientId = null) {
		this.#pruneEphemeral();
		if (this.sessions.size >= this.maxSessions) {
			const oldest = [...this.sessions.entries()]
				.sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
			if (oldest) this.#dropSession(oldest[0], "authentication session evicted");
		}
		const accessToken = base64url(randomBytes(32));
		const now = this.now();
		const normalizedOrigin = canonicalOrigin(origin);
		const deviceExpiry = clientId === null
			? Number.POSITIVE_INFINITY
			: this.#device(clientId, normalizedOrigin).expiresAt;
		const session = {
			clientId,
			origin: normalizedOrigin,
			createdAt: now,
			expiresAt: Math.min(now + this.sessionTtlMs, deviceExpiry),
		};
		this.sessions.set(digest(`node-sched-session:v1\0${accessToken}`), session);
		return { accessToken, expiresAt: session.expiresAt, clientId };
	}

	createMasterSession(origin) {
		return this.#issueSession(origin, null);
	}

	pair({ clientId, publicKeyJwk, label, trustDays }, origin) {
		const id = canonicalClientId(clientId);
		const canonical = canonicalP256Jwk(publicKeyJwk);
		const normalizedOrigin = canonicalOrigin(origin);
		const normalizedLabel = canonicalLabel(label);
		const trustTtlMs = trustDays == null ? this.deviceTtlMs : canonicalTrustDays(trustDays);
		const now = this.now();
		this.#pruneExpiredDevices(now);
		if (!this.devices.has(id) && this.devices.size >= this.maxDevices) {
			fail("trusted browser limit reached", 409, "device_limit");
		}
		const record = {
			clientId: id,
			label: normalizedLabel,
			origin: normalizedOrigin,
			publicKeyJwk: canonical,
			createdAt: now,
			expiresAt: now + trustTtlMs,
			instanceId: this.instanceId,
			tokenGeneration: this.tokenGeneration,
		};
		const candidate = new Map(this.devices);
		candidate.set(id, record);
		this.#persist(candidate);
		this.devices = candidate;
		this.#revokeEphemeral(id);
		return { ...this.#issueSession(normalizedOrigin, id), deviceExpiresAt: record.expiresAt };
	}

	createChallenge(clientId, origin) {
		const normalizedOrigin = canonicalOrigin(origin);
		const record = this.#device(clientId, normalizedOrigin);
		this.#pruneEphemeral();
		const rateKey = `${normalizedOrigin}\0${record.clientId}`;
		const recent = this.challengeRates.get(rateKey) ?? [];
		if (recent.length >= this.challengeRateMax) {
			fail("challenge rate limit exceeded", 429, "rate_limited");
		}
		if (this.challenges.size >= this.maxChallenges) {
			fail("too many pending challenges", 429, "challenge_limit");
		}
		const now = this.now();
		const challengeId = base64url(randomBytes(18));
		const challenge = base64url(randomBytes(32));
		const expiresAt = now + this.challengeTtlMs;
		this.challenges.set(challengeId, {
			challengeId,
			challenge,
			clientId: record.clientId,
			origin: normalizedOrigin,
			expiresAt,
		});
		this.challengeRates.set(rateKey, [...recent, now]);
		return { challengeId, challenge, expiresAt };
	}

	verifyChallenge({ clientId, challengeId, signature }, origin) {
		const id = canonicalClientId(clientId);
		const normalizedOrigin = canonicalOrigin(origin);
		if (!CLIENT_ID_PATTERN.test(challengeId ?? "")) {
			fail("challengeId is invalid");
		}
		this.#pruneEphemeral();
		const pending = this.challenges.get(challengeId);
		this.challenges.delete(challengeId);
		if (
			!pending
			|| pending.expiresAt <= this.now()
			|| pending.clientId !== id
			|| pending.origin !== normalizedOrigin
		) {
			fail("challenge is unknown, expired, or already used", 401, "invalid_challenge");
		}
		if (!SIGNATURE_PATTERN.test(signature ?? "")) {
			fail("signature must be a canonical 64-byte base64url value");
		}
		const signatureBytes = Buffer.from(signature, "base64url");
		if (signatureBytes.length !== 64 || base64url(signatureBytes) !== signature) {
			fail("signature must be a canonical 64-byte base64url value");
		}
		const record = this.#device(id, normalizedOrigin);
		let verified = false;
		try {
			const key = createPublicKey({ key: record.publicKeyJwk, format: "jwk" });
			verified = verifySignature(
				"sha256",
				Buffer.from(pending.challenge, "base64url"),
				{ key, dsaEncoding: "ieee-p1363" },
				signatureBytes,
			);
		} catch {
			verified = false;
		}
		if (!verified) fail("challenge signature is invalid", 401, "invalid_signature");
		return this.#issueSession(normalizedOrigin, id);
	}

	#revokeEphemeral(id, reason = "trusted browser revoked") {
		for (const [hash, session] of [...this.sessions]) {
			if (session.clientId === id) this.#dropSession(hash, reason);
		}
		for (const [challengeId, challenge] of this.challenges) {
			if (challenge.clientId === id) this.challenges.delete(challengeId);
		}
		for (const key of this.challengeRates.keys()) {
			if (key.endsWith(`\0${id}`)) this.challengeRates.delete(key);
		}
	}

	revoke(clientId) {
		const id = canonicalClientId(clientId);
		if (!this.devices.has(id)) return false;
		const candidate = new Map(this.devices);
		candidate.delete(id);
		this.#persist(candidate);
		this.devices = candidate;
		this.#revokeEphemeral(id);
		return true;
	}

	trackConnection(connection, principal) {
		if (!connection || principal?.kind !== "session" || !principal.sessionKey) return () => {};
		const sessionKey = principal.sessionKey;
		const clientId = principal.clientId;
		const sessionSet = this.connectionsBySession.get(sessionKey) ?? new Set();
		sessionSet.add(connection);
		this.connectionsBySession.set(sessionKey, sessionSet);
		if (clientId !== null) {
			const clientSet = this.connectionsByClient.get(clientId) ?? new Set();
			clientSet.add(connection);
			this.connectionsByClient.set(clientId, clientSet);
		}
		let active = true;
		const cleanup = () => {
			if (!active) return;
			active = false;
			clearTimeout(timer);
			const bySession = this.connectionsBySession.get(sessionKey);
			bySession?.delete(connection);
			if (bySession?.size === 0) this.connectionsBySession.delete(sessionKey);
			if (clientId !== null) {
				const byClient = this.connectionsByClient.get(clientId);
				byClient?.delete(connection);
				if (byClient?.size === 0) this.connectionsByClient.delete(clientId);
			}
		};
		const remaining = Math.max(0, principal.expiresAt - this.now());
		const timer = setTimeout(() => {
			try { connection.close?.(1008, "authentication expired"); } finally { cleanup(); }
		}, remaining);
		timer.unref?.();
		connection.once?.("close", cleanup);
		connection.once?.("error", cleanup);
		return cleanup;
	}

	list() {
		this.#pruneExpiredDevices();
		return [...this.devices.values()]
			.sort((left, right) => left.createdAt - right.createdAt)
			.map(({ publicKeyJwk, instanceId, tokenGeneration, ...record }) => ({ ...record }));
	}

	close() {
		this.challenges.clear();
		this.challengeRates.clear();
		for (const hash of [...this.sessions.keys()]) this.#dropSession(hash, "authentication disposed");
		this.connectionsBySession.clear();
		this.connectionsByClient.clear();
	}
}

export const DEVICE_AUTH_DEFAULTS = Object.freeze({
	challengeTtlMs: DEFAULT_CHALLENGE_TTL_MS,
	sessionTtlMs: DEFAULT_SESSION_TTL_MS,
	deviceTtlMs: DEFAULT_DEVICE_TTL_MS,
});
