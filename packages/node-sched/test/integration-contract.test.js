import test from "node:test";
import assert from "node:assert/strict";
import { canonicalIdentity, canonicalRequestStatus, integrationReadCommand } from "../lib/integration-contract.js";

test("identity distinguishes an old schema and preserves the target/query boundary", () => {
    const raw = { schema_version: 1, query: "identity", contract: "sched-identity-v1",
        available: false, instance_id: null, reason: "migration_required", node: "compute", query_host: "gateway" };
    assert.equal(canonicalIdentity(raw).node, "compute");
    assert.throws(() => canonicalIdentity({ ...raw, available: true }));
});
test("unknown receipts cannot claim a successful mutation and discard raw output", () => {
    const raw = { schema_version: 1, query: "request_status", contract: "sched-request-status-v1",
        request_id: "original", instance_id: "1".repeat(32), found: true, request_kind: "operation",
        phase: "unknown", code: null, output_compacted: false, binding_sha256: "2".repeat(64), result: null,
        stdout: "private output", argv: "private command" };
    assert.equal(canonicalRequestStatus(raw, "original").stdout, undefined);
    assert.throws(() => canonicalRequestStatus({ ...raw, code: 0 }, "original"));
    assert.throws(() => canonicalRequestStatus(raw, "different"));
});
test("compacted receipts preserve exact result references without forwarding private fields", () => {
    const raw = { schema_version: 1, query: "request_status", contract: "sched-request-status-v1",
        request_id: "original", instance_id: "1".repeat(32), found: true, request_kind: "submission",
        phase: "done", code: 0, output_compacted: true, binding_sha256: "2".repeat(64),
        result: { outcome: "accepted", batch_id: "batch-001", persisted: true, project: "p", secret: "omit" } };
    assert.equal(canonicalRequestStatus(raw, "original").result.batch_id, "batch-001");
    assert.equal(canonicalRequestStatus(raw, "original").result.secret, undefined);
});
test("receipt read commands cannot contain shell input", () => {
    assert.equal(integrationReadCommand("sched", "identity"), "sched identity --json");
    assert.equal(integrationReadCommand("sched", "request-status", "original"), "sched request-status 'original' --json");
    assert.throws(() => integrationReadCommand("sched", "request-status", "id; echo bad"));
});

test("missing request IDs never turn into literal null or undefined CLI references", () => {
    for (const value of [null, undefined, 123]) assert.throws(() => integrationReadCommand("sched","request-status",value));
});
