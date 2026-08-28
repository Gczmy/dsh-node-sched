import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../lib/ssh-engine.js";

function host() {
	return { alias: "hpdc", host: "example.invalid", user: "tester", auth: { kind: "key", keyPath: "/tmp/key" } };
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
