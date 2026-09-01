import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
} from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const KNOWN_HOSTS_MAX_BYTES = 1024 * 1024;
export const KNOWN_HOSTS_MAX_FILES = 32;

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 4096;
const MAX_HOST_CHARS = 1024;
const MAX_KEY_BLOB_BYTES = 64 * 1024;
const KEY_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/;

export class KnownHostsError extends Error {
	constructor(message, { code = "invalid_known_hosts", sourcePath, cause } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "KnownHostsError";
		this.code = code;
		if (sourcePath !== undefined) this.sourcePath = sourcePath;
	}
}

function fail(message, code, sourcePath, cause) {
	throw new KnownHostsError(message, { code, sourcePath, cause });
}

function ownedByCurrentUser(info) {
	return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function validateSafeFile(info) {
	return info.isFile()
		&& !info.isSymbolicLink()
		&& ownedByCurrentUser(info)
		&& info.nlink === 1
		&& (info.mode & 0o022) === 0
		&& info.size <= KNOWN_HOSTS_MAX_BYTES;
}

function expandPath(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS) {
		fail("known_hosts path must be a non-empty bounded string", "invalid_path");
	}
	if (/\0/.test(value)) fail("known_hosts path must not contain NUL", "invalid_path");
	let expanded = value;
	if (value === "~") expanded = homedir();
	else if (value.startsWith("~/")) expanded = join(homedir(), value.slice(2));
	return resolve(expanded);
}

function readBoundedFile(sourcePath) {
	let pathInfo;
	try {
		pathInfo = lstatSync(sourcePath);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		fail(`cannot inspect known_hosts file: ${sourcePath}`, "inspect_failed", sourcePath, error);
	}
	if (!validateSafeFile(pathInfo)) {
		fail(
			"known_hosts must be an owned, singly-linked regular file that is not group/other writable and is within the size limit",
			"unsafe_file",
			sourcePath,
		);
	}

	let fd;
	try {
		fd = openSync(
			sourcePath,
			constants.O_RDONLY
				| (constants.O_NOFOLLOW ?? 0)
				| (constants.O_NONBLOCK ?? 0)
				| (constants.O_CLOEXEC ?? 0),
		);
		const openedInfo = fstatSync(fd);
		if (
			!validateSafeFile(openedInfo)
			|| openedInfo.dev !== pathInfo.dev
			|| openedInfo.ino !== pathInfo.ino
		) {
			fail("known_hosts changed during secure open", "unsafe_file", sourcePath);
		}

		const chunks = [];
		let total = 0;
		while (true) {
			const remaining = KNOWN_HOSTS_MAX_BYTES - total;
			const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining + 1));
			const count = readSync(fd, chunk, 0, chunk.length, null);
			if (count === 0) break;
			total += count;
			if (total > KNOWN_HOSTS_MAX_BYTES) {
				fail("known_hosts exceeds its size limit", "file_too_large", sourcePath);
			}
			chunks.push(chunk.subarray(0, count));
		}

		const finalInfo = fstatSync(fd);
		if (
			!validateSafeFile(finalInfo)
			|| finalInfo.dev !== openedInfo.dev
			|| finalInfo.ino !== openedInfo.ino
			|| finalInfo.size !== openedInfo.size
		) {
			fail("known_hosts changed during secure read", "unsafe_file", sourcePath);
		}
		return Buffer.concat(chunks, total).toString("utf8");
	} catch (error) {
		if (error instanceof KnownHostsError) throw error;
		fail(`cannot securely read known_hosts file: ${sourcePath}`, "read_failed", sourcePath, error);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function canonicalLookupValues(host, port, hostKeyAlias) {
	const selected = hostKeyAlias === undefined ? host : hostKeyAlias;
	if (
		typeof selected !== "string"
		|| selected.length === 0
		|| selected.length > MAX_HOST_CHARS
		|| /[\0-\x20\x7f]/.test(selected)
	) {
		fail(
			hostKeyAlias === undefined
				? "host must be a non-empty bounded value without whitespace"
				: "hostKeyAlias must be a non-empty bounded value without whitespace",
			"invalid_target",
		);
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		fail("port must be an integer between 1 and 65535", "invalid_target");
	}

	const explicitPort = selected.match(/^\[([^\]]+)]:(\d+)$/);
	let values;
	if (explicitPort) {
		values = [selected];
	} else {
		const unwrapped = selected.startsWith("[") && selected.endsWith("]")
			? selected.slice(1, -1)
			: selected;
		values = port === 22
			? [unwrapped, `[${unwrapped}]:22`]
			: [`[${unwrapped}]:${port}`];
	}

	const expanded = [];
	for (const value of values) {
		expanded.push(value);
		const lower = value.toLowerCase();
		if (lower !== value) expanded.push(lower);
	}
	return [...new Set(expanded)];
}

function decodeBase64(value, { expectedBytes, maxBytes = MAX_KEY_BLOB_BYTES } = {}) {
	if (
		typeof value !== "string"
		|| value.length === 0
		|| value.length > Math.ceil(maxBytes / 3) * 4 + 4
		|| !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
		|| value.length % 4 === 1
	) return undefined;
	const decoded = Buffer.from(value, "base64");
	if (decoded.length === 0 || decoded.length > maxBytes) return undefined;
	if (expectedBytes !== undefined && decoded.length !== expectedBytes) return undefined;
	const supplied = value.replace(/=+$/, "");
	const canonical = decoded.toString("base64").replace(/=+$/, "");
	return supplied === canonical ? decoded : undefined;
}

function embeddedKeyType(blob) {
	if (blob.length < 4) return undefined;
	const length = blob.readUInt32BE(0);
	if (length === 0 || length > 128 || length + 4 > blob.length) return undefined;
	const keyType = blob.subarray(4, 4 + length).toString("ascii");
	return KEY_TYPE_PATTERN.test(keyType) ? keyType : undefined;
}

function fingerprint(blob) {
	return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function matchHashedHost(pattern, lookupValues) {
	const parts = pattern.split("|");
	if (parts.length !== 4 || parts[0] !== "") {
		return { supported: false, reason: "malformed_hashed_host" };
	}
	if (parts[1] !== "1") {
		return { supported: false, reason: "unsupported_hash_version" };
	}
	const salt = decodeBase64(parts[2], { expectedBytes: 20, maxBytes: 20 });
	const expected = decodeBase64(parts[3], { expectedBytes: 20, maxBytes: 20 });
	if (!salt || !expected) {
		return { supported: false, reason: "malformed_hashed_host" };
	}
	for (const value of lookupValues) {
		const actual = createHmac("sha1", salt).update(value, "utf8").digest();
		if (timingSafeEqual(actual, expected)) return { supported: true, matched: true };
	}
	return { supported: true, matched: false };
}

function wildcardMatches(pattern, lookupValues) {
	let expression = "^";
	for (const character of pattern) {
		if (character === "*") expression += ".*";
		else if (character === "?") expression += ".";
		else expression += character.replace(/[|\\{}()[\]^$+*.?-]/g, "\\$&");
	}
	expression += "$";
	const matcher = new RegExp(expression, "i");
	return lookupValues.some((value) => matcher.test(value));
}

function matchHostField(field, lookupValues, { allowWildcard = false } = {}) {
	const patterns = field.split(",");
	if (patterns.length === 0 || patterns.some((pattern) => pattern.length === 0)) {
		return { matched: false, warning: "host list contains an empty pattern" };
	}
	let matched = false;
	let unsupportedMatch;
	let unsupportedGlobal;
	for (const rawPattern of patterns) {
		const negated = rawPattern.startsWith("!");
		const pattern = negated ? rawPattern.slice(1) : rawPattern;
		if (!pattern) return { matched: false, warning: "host list contains an empty negated pattern" };

		let result;
		if (pattern.startsWith("|")) {
			result = matchHashedHost(pattern, lookupValues);
			if (!result.supported) {
				if (result.reason === "unsupported_hash_version") unsupportedGlobal = result.reason;
				else return { matched: false, warning: "host list contains a malformed hashed host" };
				continue;
			}
		} else if (pattern.includes("*") || pattern.includes("?")) {
			const wildcardMatched = wildcardMatches(pattern, lookupValues);
			if (wildcardMatched && negated) return { matched: false, excluded: true };
			if (wildcardMatched && allowWildcard) matched = true;
			else if (wildcardMatched) unsupportedMatch = "wildcard_host_pattern";
			continue;
		} else {
			result = {
				supported: true,
				matched: lookupValues.some((value) => value.toLowerCase() === pattern.toLowerCase()),
			};
		}

		if (result.matched && negated) return { matched: false, excluded: true };
		if (result.matched) matched = true;
	}
	if (matched) return { matched: true };
	if (unsupportedMatch) return { matched: false, unsupported: unsupportedMatch };
	if (unsupportedGlobal) return { matched: false, unsupported: unsupportedGlobal };
	return { matched: false };
}

function sourceFields(sourcePath, sourceLine) {
	return {
		source: "known_hosts",
		sourcePath,
		sourceLine,
	};
}

function warning(sourcePath, sourceLine, code, message) {
	return { ...sourceFields(sourcePath, sourceLine), code, message };
}

function parseKnownHostsText(text, sourcePath, lookupValues, result) {
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const sourceLine = index + 1;
		const line = lines[index].trim();
		if (!line || line.startsWith("#")) continue;
		if (line.includes("\0")) {
			result.warnings.push(warning(sourcePath, sourceLine, "malformed_line", "line contains NUL"));
			continue;
		}

		const fields = line.split(/\s+/);
		let marker;
		if (fields[0]?.startsWith("@")) marker = fields.shift();
		if (fields.length < 3) {
			result.warnings.push(warning(sourcePath, sourceLine, "malformed_line", "line has too few fields"));
			continue;
		}
		const [hostField, keyType, encodedKey] = fields;
		const hostMatch = matchHostField(hostField, lookupValues, {
			// Marker entries never become ordinary trust. Wildcards are accepted
			// here so a global `@revoked *` remains a hard revocation and CA or
			// unknown marker entries can be diagnosed accurately.
			allowWildcard: marker !== undefined,
		});
		if (hostMatch.warning) {
			result.warnings.push(warning(sourcePath, sourceLine, "malformed_host", hostMatch.warning));
			continue;
		}
		if (hostMatch.unsupported) {
			result.unsupported.push({
				...sourceFields(sourcePath, sourceLine),
				reason: hostMatch.unsupported,
			});
			continue;
		}
		if (!hostMatch.matched) continue;

		if (!KEY_TYPE_PATTERN.test(keyType)) {
			result.warnings.push(warning(sourcePath, sourceLine, "invalid_key_type", "key type is invalid"));
			continue;
		}
		const blob = decodeBase64(encodedKey);
		if (!blob) {
			result.warnings.push(warning(sourcePath, sourceLine, "invalid_key", "public key is not canonical bounded base64"));
			continue;
		}
		if (embeddedKeyType(blob) !== keyType) {
			result.warnings.push(warning(sourcePath, sourceLine, "key_type_mismatch", "public key blob type does not match its declared type"));
			continue;
		}
		const entry = {
			fingerprint: fingerprint(blob),
			keyType,
			...sourceFields(sourcePath, sourceLine),
		};

		if (marker === undefined) result.keys.push(entry);
		else if (marker === "@revoked") result.revoked.push(entry);
		else if (marker === "@cert-authority") {
			result.unsupported.push({ ...entry, reason: "cert_authority" });
		} else {
			result.unsupported.push({ ...entry, reason: "unknown_marker", marker });
		}
	}
}

function deduplicate(entries, identityOf = (entry) => `${entry.keyType}\0${entry.fingerprint}`) {
	const seen = new Set();
	return entries.filter((entry) => {
		const identity = identityOf(entry);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

/** Return OpenSSH's conventional per-user known-hosts files in lookup order. */
export function defaultKnownHostsFiles() {
	return [
		join(homedir(), ".ssh", "known_hosts"),
		join(homedir(), ".ssh", "known_hosts2"),
	];
}

/**
 * Look up trusted host keys without invoking ssh or modifying any file.
 *
 * `keys` contains only directly pinned keys. `revoked` contains matching
 * @revoked keys and wins over an otherwise trusted duplicate. CA entries and
 * host patterns that this parser deliberately does not auto-trust are returned
 * in `unsupported` for an explicit caller decision.
 */
export function lookupKnownHostKeys({
	host,
	port = 22,
	hostKeyAlias,
	files = defaultKnownHostsFiles(),
} = {}) {
	const lookupValues = canonicalLookupValues(host, port, hostKeyAlias);
	if (!Array.isArray(files) || files.length > KNOWN_HOSTS_MAX_FILES) {
		fail(
			`files must be an array containing at most ${KNOWN_HOSTS_MAX_FILES} paths`,
			"invalid_files",
		);
	}

	const result = { keys: [], revoked: [], unsupported: [], warnings: [] };
	const visited = new Set();
	for (const file of files) {
		const sourcePath = expandPath(file);
		if (visited.has(sourcePath)) continue;
		visited.add(sourcePath);
		const text = readBoundedFile(sourcePath);
		if (text === undefined) continue;
		parseKnownHostsText(text, sourcePath, lookupValues, result);
	}

	result.revoked = deduplicate(result.revoked);
	const revokedFingerprints = new Set(result.revoked.map((entry) => entry.fingerprint));
	result.keys = deduplicate(result.keys).filter(
		(entry) => !revokedFingerprints.has(entry.fingerprint),
	);
	result.unsupported = deduplicate(result.unsupported, (entry) => JSON.stringify([
		entry.reason,
		entry.marker,
		entry.keyType,
		entry.fingerprint,
		entry.sourcePath,
		entry.sourceLine,
	]));
	return result;
}
