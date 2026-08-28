import test from "node:test";
import assert from "node:assert/strict";
import { LocalTransport } from "../lib/transport.js";

test("LocalTransport executes commands and stdin locally", async () => {
	const transport = new LocalTransport({ maxOutputBytes: 1024 });
	try {
		const result = await transport.exec("printf 'local-ok'");
		assert.equal(result.ok, true);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "local-ok");

		const withStdin = await transport.execStdin("cat", "stdin-ok");
		assert.equal(withStdin.ok, true);
		assert.equal(withStdin.stdout, "stdin-ok");
		const binary = await transport.execStdin("od -An -t x1", Buffer.from([0, 255, 1]));
		assert.equal(binary.stdout.trim().replace(/\s+/g, " "), "00 ff 01");

		const splitUtf8 = await transport.exec("printf '\\344\\275'; sleep 0.02; printf '\\240'");
		assert.equal(splitUtf8.stdout, "你");
	} finally {
		transport.dispose();
	}
});

test("LocalTransport streams output and closes cleanly", async () => {
	const transport = new LocalTransport();
	try {
		const stream = await transport.openStream("printf 'stream-ok\\n'");
		let output = "";
		await new Promise((resolve, reject) => {
			stream.onData = (chunk) => { output += chunk.toString("utf8"); };
			stream.onClose = resolve;
			setTimeout(() => reject(new Error("local stream did not close")), 2_000);
		});
		assert.equal(output, "stream-ok" + String.fromCharCode(10));
	} finally {
		transport.dispose();
	}
});

test("LocalTransport ignores broken stdin pipes and disposes exec children", async () => {
	const transport = new LocalTransport();
	try {
		const stdinResult = await transport.execStdin("exit 0", "x".repeat(1_000_000));
		assert.equal(stdinResult.code, 0);

		const pending = transport.exec("sleep 5");
		await new Promise((resolve) => setTimeout(resolve, 20));
		transport.dispose();
		const disposed = await pending;
		assert.notEqual(disposed.code, 0);
		assert.equal(transport.children.size, 0);
	} finally {
		transport.dispose();
	}
});
