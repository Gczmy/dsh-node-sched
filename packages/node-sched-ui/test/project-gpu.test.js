import test from "node:test";
import assert from "node:assert/strict";
import { projectGpuAccessLabel, projectSettingsPatch, taskWaitLabel, schedulerMutationAvailability, collectStatusPages } from "../src/ui-contracts.js";

test("project GPU settings preserve explicit false and the unlimited zero quota", () => {
    const config = { projects: { disabled: { gpu_enabled: false, gpu_quota: 0, root: "/private" },
        limited: { gpu_enabled: true, gpu_quota: 2 }, legacy: { gpu_quota: 0, colocate: null } } };
    const patch = projectSettingsPatch(config);
    assert.deepEqual(patch.projects.disabled, { gpu_enabled: false, gpu_quota: 0 });
    assert.equal(patch.projects.limited.gpu_enabled, true);
    assert.equal(Object.hasOwn(patch.projects.legacy, "gpu_enabled"), false);
    assert.equal(patch.projects.legacy.colocate, null);
    assert.equal(projectGpuAccessLabel(config.projects.disabled), "GPU 已禁用");
    assert.equal(projectGpuAccessLabel(config.projects.limited), "GPU 配额 2");
    assert.equal(projectGpuAccessLabel(config.projects.legacy), "GPU 无限制");
    assert.equal(projectGpuAccessLabel({}), "GPU 无限制");
});

test("GPU policy waiting remains pending and survives dashboard page collection", async () => {
    const held = { id: "b-t-v1", batch_id: "b", task: "t", status: "pending", wait_reason: "project_gpu_disabled" };
    const page = { schema_version: 1, batches: [{ id: "b" }], jobs: [held], gpus: [],
        truncated: { batches: false, jobs: false }, next_cursor: null, next_job_cursor: null };
    const collected = await collectStatusPages(async () => page);
    assert.equal(collected.jobs[0].wait_reason, "project_gpu_disabled");
    assert.equal(taskWaitLabel(held), "项目 GPU 已禁用，等待启用");
    assert.equal(taskWaitLabel({ ...held, status: "running" }), "");
    assert.equal(taskWaitLabel({ ...held, wait_reason: null }), "");
    assert.equal(schedulerMutationAvailability({ ok: true, fresh: true, raw: collected }).writable, true);
});
