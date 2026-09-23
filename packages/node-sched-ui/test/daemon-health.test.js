import test from "node:test";
import assert from "node:assert/strict";
import { daemonHealthView, PollGate } from "../src/ui-contracts.js";
import { canonicalDaemonHealth } from "../../node-sched/lib/daemon-health.js";

const healthy = () => ({
	schema_version: 1, node: "compute", query_host: "gateway", pid: 123,
	observed_at: 1_900_000_000, process_state: "unknown", health_state: "healthy",
	heartbeat_age_s: 1, tick_ok_age_s: 2, frozen: false, draining: false, read_error: null,
});
const envelope = (raw = healthy()) => ({ ok: true, fresh: true, stale: false, raw, ttlMs: 30_000, ageMs: 0 });

test("healthy, drain, stalled and confirmed stopped have distinct lights and controls", () => {
	const raw = healthy();
	let view = daemonHealthView(envelope(raw));
	assert.equal(view.tone, "ok");
	assert.equal(view.canStart, false);
	assert.equal(view.canStop, true);
	view = daemonHealthView(envelope({ ...raw, draining: true }));
	assert.equal(view.tone, "brand");
	view = daemonHealthView(envelope({ ...raw, health_state: "stalled", heartbeat_age_s: 209, tick_ok_age_s: 225, frozen: true, draining: true }));
	assert.equal(view.tone, "err");
	assert.equal(view.label, "调度停滞");
	assert.equal(view.canStart, false);
	assert.equal(view.canStop, false);
	assert.match(view.title, /进程 未知/);
	view = daemonHealthView(envelope({ ...raw, health_state: "stopped", process_state: "stopped" }));
	assert.equal(view.tone, "label2");
	assert.equal(view.canStart, true);
	assert.equal(view.canStop, false);
});

test("heartbeat without tick completion cannot show green", () => {
	const view = daemonHealthView(envelope({ ...healthy(), health_state: "delayed", tick_ok_age_s: null }));
	assert.equal(view.tone, "warn");
	assert.equal(view.canStart, false);
});

test("query failure, unsupported CLI and cache age never preserve green or enable actions", () => {
	for (const value of [null, { ok: true, text: "运行中" },
		{ ...envelope(), ok: false }, { ...envelope(), fresh: false },
		{ ...envelope(), stale: true }, { ...envelope(), lastError: "SSH timeout" },
		{ ...envelope(), ageMs: 15_000, localAgeMs: 15_000 },
		{ ...envelope(), sampleAgeMs: 30_000 },
		{ ...envelope(), ttlMs: undefined }]) {
		const view = daemonHealthView(value);
		assert.equal(view.tone, "label2");
		assert.equal(view.canStart, false);
		assert.equal(view.canStop, false);
	}
});

test("sample health expiry wins over a still-fresh transport cache", () => {
	const value = envelope({ ...healthy(), heartbeat_age_s: 59 });
	assert.equal(daemonHealthView(value).tone, "ok");
	assert.equal(daemonHealthView({ ...value, localAgeMs: 1_000 }).tone, "label2");
});

test("a hung refresh expires locally, late responses cannot overwrite recovery", () => {
	let now = 0;
	const gate = new PollGate({ ttlMs: 30_000, now: () => now });
	gate.succeed(gate.issue(), envelope());
	const hung = gate.issue();
	now = 30_000;
	assert.equal(daemonHealthView(gate.snapshot()).tone, "label2");
	gate.succeed(gate.issue(), envelope());
	assert.equal(daemonHealthView(gate.snapshot()).tone, "ok");
	assert.equal(gate.succeed(hung, envelope({ ...healthy(), health_state: "delayed" })), false);
	assert.equal(daemonHealthView(gate.snapshot()).tone, "ok");
	gate.fail(gate.issue(), new Error("connection lost"));
	assert.equal(daemonHealthView(gate.snapshot()).tone, "label2");
	assert.match(daemonHealthView(gate.snapshot()).title, /connection lost.*上次数据/);
});

test("malformed and contradictory daemon documents fail closed", () => {
	for (const patch of [{ schema_version: 2 }, { heartbeat_age_s: "1" },
		{ tick_ok_age_s: NaN }, { heartbeat_age_s: -1 }, { process_state: "dead" },
		{ pid: true }, { observed_at: Infinity }, { query_host: "" },
		{ health_state: "healthy", frozen: true, tick_ok_age_s: 200 },
		{ health_state: "stopped", process_state: "unknown" }]) {
		assert.throws(() => canonicalDaemonHealth({ ...healthy(), ...patch }));
		assert.equal(daemonHealthView(envelope({ ...healthy(), ...patch })).tone, "label2");
	}
});
