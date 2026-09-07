import test from "node:test";
import assert from "node:assert/strict";
import { canonicalStatusDocument, summarizeStatus } from "../lib/index.js";

test("canonical status accepts project GPU waiting and still rejects unknown reasons", () => {
    const document = { schema_version: 1, limit: 200, truncated: { batches: false, jobs: false },
        next_cursor: null, next_job_cursor: null, daemon_health: {}, cpu: { used: 0, total: 0 },
        batches: [{ id: "b", name: "b", batch_id: "b", batch_name: "b", status: "active", progress: "0/1", depends_on: [], revision: 1 }],
        jobs: [{ id: "b-t-v1", batch_id: "b", batch_name: "b", task: "t", version: 1, status: "pending", wait_reason: "project_gpu_disabled" }],
        gpus: [] };
    assert.equal(canonicalStatusDocument(document), document);
    assert.match(summarizeStatus(document), /project_gpu_disabled/);
    document.jobs[0].wait_reason = "unknown_policy";
    assert.throws(() => canonicalStatusDocument(document), /wait_reason/);
});
