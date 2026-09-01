import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HOST_STORE_MAX_BYTES,
	HostStore,
	SshEngine,
	buildConnectConfig,
	buildHostProbeConfig,
} from "../lib/ssh-engine.js";

function host() {
	return {
		alias: "hpdc",
		host: "example.invalid",
		hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		user: "tester",
		auth: { kind: "key", keyPath: "/tmp/key" },
	};
}

test("HostStore rejects duplicate aliases", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-") );
	try {
		const store = new HostStore(join(dir, "hosts.json"));
		store.create(host());
		assert.throws(() => store.create(host()), /already exists/);
		assert.equal(store.list().length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SSH connection rejects an absent or mismatched pinned host key", () => {
	const key = Buffer.from("server-host-public-key");
	const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
	const entry = {
		...host(),
		auth: { kind: "password", password: "secret" },
		hostKey: fingerprint,
	};
	const config = buildConnectConfig(entry, undefined, {
		connectTimeoutMs: 5_000,
		keepaliveIntervalMs: 10_000,
	});
	assert.equal(config.hostVerifier(key), true);
	assert.equal(config.hostVerifier(Buffer.from("attacker-key")), false);
	assert.throws(
		() => buildConnectConfig({ ...entry, hostKey: undefined }, undefined, {
			connectTimeoutMs: 5_000,
			keepaliveIntervalMs: 10_000,
		}),
		/host key|fingerprint|pin/i,
	);
});

test("SSH connection accepts an exact member of a multi-key trust set", () => {
	const first = Buffer.from("first-server-key");
	const second = Buffer.from("second-server-key");
	const fingerprint = (key) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
	const config = buildConnectConfig({
		...host(),
		auth: { kind: "password", password: "secret" },
		hostKey: fingerprint(first),
		hostKeys: [
			{ fingerprint: fingerprint(first), source: "legacy" },
			{ fingerprint: fingerprint(second), source: "known_hosts" },
		],
	}, undefined, { connectTimeoutMs: 5_000, keepaliveIntervalMs: 10_000 });
	assert.equal(config.hostVerifier(first), true);
	assert.equal(config.hostVerifier(second), true);
	assert.equal(config.hostVerifier(Buffer.from("attacker")), false);
});

test("host-key probe config never contains user authentication credentials", () => {
	let observed;
	const config = buildHostProbeConfig({
		...host(),
		auth: {
			kind: "password",
			password: "must-not-leak",
			kbdintPassword: "must-not-leak-either",
		},
	}, undefined, { connectTimeoutMs: 5_000 }, (value) => { observed = value; });
	for (const field of [
		"password", "privateKey", "passphrase", "agent", "_kbdintAnswer", "_interactiveAuth",
	]) {
		assert.equal(Object.hasOwn(config, field), false, field);
	}
	assert.equal(config.tryKeyboard, false);
	assert.equal(config.authHandler(), false);
	assert.equal(config.hostVerifier(Buffer.from("observed-server-key")), false);
	assert.match(observed.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("HostStore revisions reject stale host trust updates and retain version-1 rollback compatibility", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-revision-"));
	const file = join(dir, "hosts.json");
	try {
		const store = new HostStore(file);
		const created = store.create(host());
		assert.equal(created.revision, 1);
		const changed = store.updateHostKeys([{
			alias: created.alias,
			expectedRevision: created.revision,
			hostKeys: [{
				fingerprint: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
				source: "probe",
			}],
		}])[0];
		assert.equal(changed.revision, 2);
		assert.throws(
			() => store.update(created.alias, { description: "stale" }, { expectedRevision: created.revision }),
			(error) => error.code === "SSH_HOST_REVISION_CONFLICT",
		);
		const persisted = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(persisted.version, 1);
		assert.equal(persisted.hosts[0].hostKey, persisted.hosts[0].hostKeys[0].fingerprint);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore cross-process CAS prevents stale instances from overwriting newer pins", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-cas-"));
	const file = join(dir, "hosts.json");
	try {
		const first = new HostStore(file);
		const stale = new HostStore(file);
		first.create(host());
		assert.throws(
			() => stale.create({ ...host(), alias: "other" }),
			(error) => error.code === "SSH_HOST_STORE_CONFLICT" && error.status === 409,
		);
		assert.equal(stale.find("hpdc").alias, "hpdc");
		stale.create({ ...host(), alias: "other" });
		assert.deepEqual(
			new HostStore(file).list().map((entry) => entry.alias),
			["hpdc", "other"],
		);
		assert.equal(fs.existsSync(`${file}.lock`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SshEngine refreshes external host-store generations before listing or connecting", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-refresh-"));
	const file = join(dir, "hosts.json");
	try {
		const writer = new HostStore(file);
		const reader = new HostStore(file);
		const engine = new SshEngine(reader, { idleTimeoutMs: 60_000 });
		t.after(() => engine.dispose());
		assert.deepEqual(engine.list(), []);
		writer.create(host());
		assert.equal(engine.list()[0].alias, "hpdc");
		assert.equal(reader.revision(), 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore fails closed on corrupt or overly broad credential files", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-hardening-"));
	const file = join(dir, "hosts.json");
	try {
		writeFileSync(file, "{broken", { mode: 0o600 });
		assert.throws(() => new HostStore(file), /invalid|corrupt|JSON/i);
		writeFileSync(file, JSON.stringify({ version: 1, hosts: [] }), { mode: 0o600 });
		chmodSync(file, 0o644);
		assert.throws(() => new HostStore(file), /0600|permission|private/i);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore keeps live state unchanged when an atomic save fails", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-rollback-"));
	const file = join(dir, "hosts.json");
	try {
		const store = new HostStore(file);
		const original = store.create(host());
		rmSync(file);
		mkdirSync(file);

		assert.throws(
			() => store.update(original.alias, { description: "must not publish" }),
			/rename|directory|host store/i,
		);
		assert.throws(() => store.remove(original.alias), /rename|directory|host store/i);
		assert.deepEqual(store.find(original.alias), original);

		const createFile = join(dir, "create.json");
		const emptyStore = new HostStore(createFile);
		mkdirSync(createFile);
		assert.throws(() => emptyStore.create(host()), /rename|directory|host store/i);
		assert.equal(emptyStore.list().length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore preserves legacy absent and empty passwords without blocking startup", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-legacy-password-"));
	const file = join(dir, "hosts.json");
	try {
		const missing = {
			...host(),
			port: 22,
			auth: { kind: "password" },
		};
		const empty = {
			...missing,
			alias: "empty-password",
			auth: { kind: "password", password: "" },
		};
		writeFileSync(file, JSON.stringify({ version: 1, hosts: [missing, empty] }), { mode: 0o600 });

		const store = new HostStore(file);
		assert.equal(store.find(missing.alias).auth.password, undefined);
		assert.equal(store.find(empty.alias).auth.password, "");
		store.update(missing.alias, { description: "legacy entry" });
		const reloaded = new HostStore(file);
		assert.equal(reloaded.find(missing.alias).auth.password, undefined);
		assert.equal(reloaded.find(empty.alias).auth.password, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore accepts exactly the load cap, rejects one byte over, and only writes restart-readable data", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-size-"));
	const file = join(dir, "hosts.json");
	try {
		const document = JSON.stringify({ version: 1, hosts: [] });
		writeFileSync(file, document + " ".repeat(HOST_STORE_MAX_BYTES - Buffer.byteLength(document)), { mode: 0o600 });
		assert.equal(new HostStore(file).list().length, 0);

		writeFileSync(file, document + " ".repeat(HOST_STORE_MAX_BYTES + 1 - Buffer.byteLength(document)), { mode: 0o600 });
		assert.throws(() => new HostStore(file), /host store|0600|unsafe/i);

		rmSync(file);
		const store = new HostStore(file);
		assert.throws(
			() => store.create({ ...host(), description: "x".repeat(HOST_STORE_MAX_BYTES) }),
			/size|large|limit/i,
		);
		assert.equal(store.list().length, 0);
		for (let index = 0; index < 15; index += 1) {
			store.create({
				...host(),
				alias: `host-${index}`,
				auth: { kind: "password", password: "p".repeat(65_536) },
			});
		}
		assert.equal(new HostStore(file).list().length, 15);
		assert.throws(
			() => store.create({
				...host(),
				alias: "host-over-cap",
				auth: { kind: "password", password: "p".repeat(65_536) },
			}),
			/size|large|limit/i,
		);
		assert.equal(store.list().length, 15);
		assert.equal(new HostStore(file).list().length, 15);
		assert.ok(Buffer.byteLength(readFileSync(file)) <= HOST_STORE_MAX_BYTES);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore and SSH config parsing never use an unbounded descriptor read", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-bounded-fd-read-"));
	const storeFile = join(dir, "hosts.json");
	const configFile = join(dir, "config");
	const originalReadFileSync = fs.readFileSync;
	try {
		writeFileSync(storeFile, JSON.stringify({ version: 1, hosts: [] }), { mode: 0o600 });
		writeFileSync(configFile, "Host compute\n  HostName compute.invalid\n", { mode: 0o644 });
		fs.readFileSync = (target, ...args) => {
			if (typeof target === "number") {
				throw new Error("unbounded descriptor read is forbidden");
			}
			return originalReadFileSync(target, ...args);
		};
		syncBuiltinESMExports();

		const store = new HostStore(storeFile);
		assert.deepEqual(store.importSshConfig(configFile), {
			parsed: 1,
			added: 1,
			skipped: 0,
			skippedNames: [],
		});
	} finally {
		fs.readFileSync = originalReadFileSync;
		syncBuiltinESMExports();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SSH config import rejects links and non-regular inputs before reading them", {
	skip: process.platform === "win32",
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-config-kind-"));
	const target = join(dir, "config-target");
	const symlink = join(dir, "config-link");
	const hardlink = join(dir, "config-hardlink");
	const directory = join(dir, "config-directory");
	const fifo = join(dir, "config-fifo");
	const broadFile = join(dir, "config-group-writable");
	const config = "Host compute\n  HostName compute.invalid\n";
	let writer;
	try {
		writeFileSync(target, config, { mode: 0o644 });
		symlinkSync(target, symlink);
		linkSync(target, hardlink);
		mkdirSync(directory);
		execFileSync("mkfifo", [fifo]);
		writeFileSync(broadFile, config, { mode: 0o600 });
		chmodSync(broadFile, 0o666);

		for (const [name, source] of [
			["symlink", symlink],
			["hard link", hardlink],
			["directory", directory],
			["device", "/dev/null"],
			["group/other writable file", broadFile],
		]) {
			const store = new HostStore(join(dir, `${name.replaceAll(" ", "-")}.json`));
			assert.throws(
				() => store.importSshConfig(source),
				/regular|link|unsafe|config/i,
				`${name} must be rejected`,
			);
			assert.equal(store.list().length, 0);
		}

		writer = spawn(
			process.execPath,
			[
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
				fifo,
				config,
			],
			{ stdio: "ignore" },
		);
		const fifoStore = new HostStore(join(dir, "fifo.json"));
		assert.throws(
			() => fifoStore.importSshConfig(fifo),
			/regular|fifo|unsafe|config/i,
		);
		assert.equal(fifoStore.list().length, 0);
	} finally {
		if (writer?.exitCode === null) writer.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SSH config import accepts the exact byte cap and rejects one byte over", async () => {
	const sshEngine = await import("../lib/ssh-engine.js");
	const cap = sshEngine.SSH_CONFIG_MAX_BYTES ?? 1024 * 1024;
	const dir = mkdtempSync(join(tmpdir(), "node-sched-config-size-"));
	const exactFile = join(dir, "config-exact");
	const overFile = join(dir, "config-over");
	const base = "Host within\n  HostName example.invalid\n";
	try {
		const exact = base + `#${"x".repeat(cap - Buffer.byteLength(base) - 1)}`;
		assert.equal(Buffer.byteLength(exact), cap);
		writeFileSync(exactFile, exact, { mode: 0o644 });
		const store = new HostStore(join(dir, "hosts-exact.json"));
		assert.deepEqual(store.importSshConfig(exactFile), {
			parsed: 1,
			added: 1,
			skipped: 0,
			skippedNames: [],
		});
		assert.equal(store.find("within")?.host, "example.invalid");

		writeFileSync(overFile, exact + "x", { mode: 0o644 });
		const overStore = new HostStore(join(dir, "hosts-over.json"));
		assert.throws(
			() => overStore.importSshConfig(overFile),
			/size|large|limit|config/i,
		);
		assert.equal(overStore.list().length, 0);
		assert.equal(sshEngine.SSH_CONFIG_MAX_BYTES, 1024 * 1024);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore fsyncs its parent after rename and publishes only after durability", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-durability-"));
	const originalFsyncSync = fs.fsyncSync;
	const originalRenameSync = fs.renameSync;
	const installFs = (fsyncImplementation, renameImplementation = originalRenameSync) => {
		fs.fsyncSync = fsyncImplementation;
		fs.renameSync = renameImplementation;
		syncBuiltinESMExports();
	};
	try {
		const failedStore = new HostStore(join(dir, "failed.json"));
		installFs((fd) => {
			if (fs.fstatSync(fd).isDirectory()) {
				throw new Error("parent directory fsync failed");
			}
			return originalFsyncSync(fd);
		});
		assert.throws(
			() => failedStore.create(host()),
			/fsync|directory|durab/i,
		);
		assert.equal(failedStore.find("hpdc"), undefined);
		assert.equal(new HostStore(join(dir, "failed.json")).find("hpdc"), undefined);

		installFs(originalFsyncSync);
		const durabilityOrder = [];
		installFs(
			(fd) => {
				if (fs.fstatSync(fd).isDirectory()) durabilityOrder.push("fsync-parent");
				return originalFsyncSync(fd);
			},
			(from, to) => {
				durabilityOrder.push("rename");
				return originalRenameSync(from, to);
			},
		);
		const successfulStore = new HostStore(join(dir, "successful.json"));
		const created = successfulStore.create({ ...host(), alias: "durable" });
		assert.deepEqual(durabilityOrder, ["rename", "fsync-parent"]);
		assert.deepEqual(successfulStore.find("durable"), created);
	} finally {
		installFs(originalFsyncSync, originalRenameSync);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore opens its durability directory without following links", {
	skip: process.platform === "win32" || !fs.constants.O_NOFOLLOW,
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-parent-open-"));
	const originalOpenSync = fs.openSync;
	const originalRenameSync = fs.renameSync;
	const events = [];
	let directoryFlags;
	try {
		fs.openSync = (target, flags, ...args) => {
			if (target === dir) {
				directoryFlags = flags;
				events.push("open-directory");
			}
			return originalOpenSync(target, flags, ...args);
		};
		fs.renameSync = (from, to) => {
			events.push("rename");
			return originalRenameSync(from, to);
		};
		syncBuiltinESMExports();
		const store = new HostStore(join(dir, "hosts.json"));
		store.create(host());
		assert.equal(
			(directoryFlags & fs.constants.O_NOFOLLOW) !== 0,
			true,
		);
		assert.ok(events.indexOf("open-directory") < events.indexOf("rename"));
	} finally {
		fs.openSync = originalOpenSync;
		fs.renameSync = originalRenameSync;
		syncBuiltinESMExports();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HostStore never unlinks a temp path it did not create", () => {
	const dir = mkdtempSync(join(tmpdir(), "node-sched-host-temp-owner-"));
	const originalOpenSync = fs.openSync;
	const originalUnlinkSync = fs.unlinkSync;
	const unlinked = [];
	let foreignTemp;
	try {
		fs.openSync = (target, flags, ...args) => {
			if (
				typeof target === "string"
				&& target.startsWith(join(dir, "hosts.json."))
				&& target.endsWith(".tmp")
			) {
				foreignTemp = target;
				throw new Error("temp already exists");
			}
			return originalOpenSync(target, flags, ...args);
		};
		fs.unlinkSync = (target, ...args) => {
			if (target === foreignTemp) {
				unlinked.push(target);
				return;
			}
			return originalUnlinkSync(target, ...args);
		};
		syncBuiltinESMExports();

		const store = new HostStore(join(dir, "hosts.json"));
		assert.throws(() => store.create(host()), /temp already exists/);
		assert.deepEqual(unlinked, []);
	} finally {
		fs.openSync = originalOpenSync;
		fs.unlinkSync = originalUnlinkSync;
		syncBuiltinESMExports();
		rmSync(dir, { recursive: true, force: true });
	}
});
