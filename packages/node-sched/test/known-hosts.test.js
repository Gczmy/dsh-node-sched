import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	KNOWN_HOSTS_MAX_BYTES,
	defaultKnownHostsFiles,
	lookupKnownHostKeys,
} from "../lib/known-hosts.js";

function field(value) {
	const bytes = Buffer.from(value);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
}

function publicKey(keyType, suffix) {
	return Buffer.concat([field(keyType), field(`test-${suffix}`)]);
}

function knownHostsLine(hosts, keyType, blob, marker) {
	return `${marker ? `${marker} ` : ""}${hosts} ${keyType} ${blob.toString("base64")}`;
}

function sha256(blob) {
	return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function withKnownHosts(content, callback, mode = 0o600) {
	const directory = mkdtempSync(join(tmpdir(), "node-sched-known-hosts-"));
	const file = join(directory, "known_hosts");
	try {
		writeFileSync(file, content, { mode });
		return callback(file, directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("defaultKnownHostsFiles returns the conventional per-user files", () => {
	assert.deepEqual(defaultKnownHostsFiles(), [
		join(homedir(), ".ssh", "known_hosts"),
		join(homedir(), ".ssh", "known_hosts2"),
	]);
});

test("lookup supports ordinary and comma-separated hosts with multiple key algorithms", () => {
	const ed25519 = publicKey("ssh-ed25519", "ed25519");
	const ecdsa = publicKey("ecdsa-sha2-nistp256", "ecdsa");
	const unrelated = publicKey("ssh-rsa", "unrelated");
	const content = [
		"# generated for this test",
		knownHostsLine("other.invalid,compute.example", "ssh-ed25519", ed25519),
		knownHostsLine("COMPUTE.EXAMPLE", "ecdsa-sha2-nistp256", ecdsa),
		knownHostsLine("elsewhere.example", "ssh-rsa", unrelated),
	].join("\n");

	withKnownHosts(content, (file) => {
		const result = lookupKnownHostKeys({ host: "compute.example", files: [file] });
		assert.deepEqual(result.revoked, []);
		assert.deepEqual(result.unsupported, []);
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(result.keys.map(({ keyType, fingerprint }) => ({ keyType, fingerprint })), [
			{ keyType: "ssh-ed25519", fingerprint: sha256(ed25519) },
			{ keyType: "ecdsa-sha2-nistp256", fingerprint: sha256(ecdsa) },
		]);
		for (const key of result.keys) {
			assert.equal(key.source, "known_hosts");
			assert.equal(key.sourcePath, file);
			assert.ok(Number.isInteger(key.sourceLine));
		}
	});
});

test("lookup uses bracketed host syntax for non-default ports and honors HostKeyAlias", () => {
	const portKey = publicKey("ssh-ed25519", "port");
	const aliasKey = publicKey("ssh-rsa", "alias");
	const content = [
		knownHostsLine("[compute.example]:2202", "ssh-ed25519", portKey),
		knownHostsLine("key-name", "ssh-rsa", aliasKey),
	].join("\n");

	withKnownHosts(content, (file) => {
		const portResult = lookupKnownHostKeys({
			host: "compute.example",
			port: 2202,
			files: [file],
		});
		assert.deepEqual(portResult.keys.map((entry) => entry.fingerprint), [sha256(portKey)]);

		const aliasResult = lookupKnownHostKeys({
			host: "ignored.example",
			hostKeyAlias: "key-name",
			files: [file],
		});
		assert.deepEqual(aliasResult.keys.map((entry) => entry.fingerprint), [sha256(aliasKey)]);
	});
});

test("lookup verifies OpenSSH |1| hashed host names with HMAC-SHA1", () => {
	const host = "secret.example";
	const salt = Buffer.from("0123456789abcdefghij");
	const digest = createHmac("sha1", salt).update(host).digest();
	const hashedHost = `|1|${salt.toString("base64")}|${digest.toString("base64")}`;
	const blob = publicKey("ssh-ed25519", "hashed");

	withKnownHosts(knownHostsLine(hashedHost, "ssh-ed25519", blob), (file) => {
		assert.deepEqual(
			lookupKnownHostKeys({ host, files: [file] }).keys.map((entry) => entry.fingerprint),
			[sha256(blob)],
		);
		assert.deepEqual(lookupKnownHostKeys({ host: "other.example", files: [file] }).keys, []);
	});
});

test("@revoked is a hard marker and @cert-authority is never auto-trusted", () => {
	const revoked = publicKey("ssh-ed25519", "revoked");
	const trusted = publicKey("ssh-rsa", "trusted");
	const authority = publicKey("ssh-ed25519", "authority");
	const content = [
		knownHostsLine("compute.example", "ssh-ed25519", revoked),
		knownHostsLine("*", "ssh-ed25519", revoked, "@revoked"),
		knownHostsLine("compute.example", "ssh-rsa", trusted),
		knownHostsLine("compute.example", "ssh-ed25519", authority, "@cert-authority"),
	].join("\n");

	withKnownHosts(content, (file) => {
		const result = lookupKnownHostKeys({ host: "compute.example", files: [file] });
		assert.deepEqual(result.keys.map((entry) => entry.fingerprint), [sha256(trusted)]);
		assert.deepEqual(result.revoked.map((entry) => entry.fingerprint), [sha256(revoked)]);
		assert.deepEqual(
			result.unsupported.map(({ reason, fingerprint }) => ({ reason, fingerprint })),
			[{ reason: "cert_authority", fingerprint: sha256(authority) }],
		);
	});
});

test("duplicates are collapsed and missing files are ignored", () => {
	const blob = publicKey("ssh-ed25519", "duplicate");
	const line = knownHostsLine("compute.example", "ssh-ed25519", blob);
	withKnownHosts(`${line}\n${line}\n`, (file, directory) => {
		const result = lookupKnownHostKeys({
			host: "compute.example",
			files: [join(directory, "missing"), file, file],
		});
		assert.equal(result.keys.length, 1);
	});
});

test("malformed key material is diagnosed without becoming trusted", () => {
	const otherType = publicKey("ssh-rsa", "mismatch");
	const content = [
		"compute.example ssh-ed25519 !!!not-base64!!!",
		knownHostsLine("compute.example", "ssh-ed25519", otherType),
	].join("\n");
	withKnownHosts(content, (file) => {
		const result = lookupKnownHostKeys({ host: "compute.example", files: [file] });
		assert.deepEqual(result.keys, []);
		assert.deepEqual(result.warnings.map((entry) => entry.code), [
			"invalid_key",
			"key_type_mismatch",
		]);
	});
});

test("wildcard and certificate-authority entries are reported but not auto-trusted", () => {
	const wildcard = publicKey("ssh-ed25519", "wildcard");
	withKnownHosts(knownHostsLine("*.example", "ssh-ed25519", wildcard), (file) => {
		const result = lookupKnownHostKeys({ host: "compute.example", files: [file] });
		assert.deepEqual(result.keys, []);
		assert.deepEqual(result.unsupported, [{
			source: "known_hosts",
			sourcePath: file,
			sourceLine: 1,
			reason: "wildcard_host_pattern",
		}]);
	});
});

test("unsafe permissions, symlinks, and hard links fail closed", {
	skip: process.platform === "win32",
}, () => {
	const blob = publicKey("ssh-ed25519", "unsafe");
	const content = knownHostsLine("compute.example", "ssh-ed25519", blob);
	const directory = mkdtempSync(join(tmpdir(), "node-sched-known-hosts-unsafe-"));
	const target = join(directory, "target");
	const symbolic = join(directory, "symbolic");
	const hard = join(directory, "hard");
	const nestedDirectory = join(directory, "not-a-file");
	try {
		writeFileSync(target, content, { mode: 0o600 });
		symlinkSync(target, symbolic);
		assert.throws(
			() => lookupKnownHostKeys({ host: "compute.example", files: [symbolic] }),
			/owned|singly-linked|regular|unsafe/i,
		);

		mkdirSync(nestedDirectory);
		assert.throws(
			() => lookupKnownHostKeys({ host: "compute.example", files: [nestedDirectory] }),
			/owned|singly-linked|regular|unsafe/i,
		);

		linkSync(target, hard);
		assert.throws(
			() => lookupKnownHostKeys({ host: "compute.example", files: [hard] }),
			/owned|singly-linked|regular|unsafe/i,
		);

		rmSync(hard);
		chmodSync(target, 0o620);
		assert.throws(
			() => lookupKnownHostKeys({ host: "compute.example", files: [target] }),
			/owned|group\/other writable|unsafe/i,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("known_hosts reads are bounded at an explicit byte cap", () => {
	const directory = mkdtempSync(join(tmpdir(), "node-sched-known-hosts-size-"));
	const file = join(directory, "known_hosts");
	try {
		writeFileSync(file, "#".repeat(KNOWN_HOSTS_MAX_BYTES), { mode: 0o600 });
		assert.deepEqual(lookupKnownHostKeys({ host: "compute.example", files: [file] }), {
			keys: [],
			revoked: [],
			unsupported: [],
			warnings: [],
		});

		writeFileSync(file, "#".repeat(KNOWN_HOSTS_MAX_BYTES + 1), { mode: 0o600 });
		assert.throws(
			() => lookupKnownHostKeys({ host: "compute.example", files: [file] }),
			/size limit|within the size limit/i,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
