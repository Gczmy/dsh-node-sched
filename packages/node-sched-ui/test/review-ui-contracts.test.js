import test from "node:test";
import assert from "node:assert/strict";

const contractsUrl = new URL("../src/ui-contracts.js", import.meta.url);
const loadContracts = () => import(contractsUrl.href);

test("UI-L01: authentication submission failures produce user-visible server and network error text", async () => {
	const { authAnswerErrorText } = await loadContracts();

	assert.equal(
		authAnswerErrorText({
			status: 400,
			statusText: "Bad Request",
			body: { error: "authentication answer count mismatch" },
		}),
		"authentication answer count mismatch",
	);
	assert.match(
		authAnswerErrorText({ status: 500, statusText: "Internal Server Error", body: {} }),
		/500|Internal Server Error/,
	);
	assert.match(
		authAnswerErrorText({ cause: new Error("connection lost") }),
		/connection lost/,
	);
	assert.equal(
		authAnswerErrorText({ status: 400, body: { error: "x".repeat(1_000) } }).length <= 240,
		true,
	);
});

test("UI-L02: captured sidebar click listener is removed with the identical capture option", async () => {
	const { listenCaptured } = await loadContracts();
	const calls = [];
	const target = {
		addEventListener(...args) { calls.push(["add", ...args]); },
		removeEventListener(...args) { calls.push(["remove", ...args]); },
	};
	const listener = () => {};

	const dispose = listenCaptured(target, "click", listener);
	assert.deepEqual(calls, [["add", "click", listener, true]]);

	dispose();
	assert.deepEqual(calls, [
		["add", "click", listener, true],
		["remove", "click", listener, true],
	]);
});

test("UI-L03: submit placeholder example is valid JSON with the required project contract", async () => {
	const { SUBMIT_EXAMPLE } = await loadContracts();
	const example = JSON.parse(SUBMIT_EXAMPLE);

	assert.equal(typeof example.project, "string");
	assert.notEqual(example.project.trim(), "");
	assert.equal(Object.hasOwn(example, "schema_version"), false);
	assert.equal(typeof example.name, "string");
	assert.ok(Array.isArray(example.tasks));
	assert.ok(example.tasks.length > 0);
});

test("UI-L03: submit example uses a project selected from the loaded sched config", async () => {
	const { configuredProjectNames, submitExampleForProject } = await loadContracts();
	const config = {
		default_project: "research",
		projects: { production: { root: "/prod" }, research: { root: "/research" } },
	};

	assert.deepEqual(configuredProjectNames(config), ["research", "production"]);
	assert.equal(JSON.parse(submitExampleForProject("research")).project, "research");
});

test("D-M08: explicit zero-prompt authentication remains empty and submits zero answers", async () => {
	const { normalizeAuthPrompts, buildAuthAnswer } = await loadContracts();
	const prompts = normalizeAuthPrompts({
		id: "auth-zero",
		method: "keyboard-interactive",
		prompts: [],
	});

	assert.deepEqual(prompts, []);
	assert.deepEqual(buildAuthAnswer(prompts, []), { kind: "answers", answers: [] });
});

test("D-M07: every terminal authentication frame removes only its matching queued challenge", async () => {
	const { reduceAuthQueue } = await loadContracts();
	const queue = [
		{ type: "auth", id: "auth-a", prompts: [{ prompt: "Password" }] },
		{ type: "auth", id: "auth-b", prompts: [{ prompt: "Code" }] },
	];

	for (const state of ["resolved", "expired", "cancelled"]) {
		assert.deepEqual(
			reduceAuthQueue(queue, { type: "auth", id: "auth-a", state }),
			[queue[1]],
			state,
		);
	}
});

test("D-M06: authentication audience frames explicitly report both visible and hidden states", async () => {
	const { authAudienceFrame } = await loadContracts();

	assert.deepEqual(authAudienceFrame(true), { type: "auth-audience", visible: true });
	assert.deepEqual(authAudienceFrame(false), { type: "auth-audience", visible: false });
});

test("canonical jobs and task references require batch_id without a legacy batch fallback", async () => {
	const { jobsForBatch, taskReference } = await loadContracts();
	const canonical = {
		batch_id: "batch-20260829-a",
		batch: "batch-20260829-b",
		task: "canonical",
		status: "failed",
	};
	const otherBatch = {
		batch_id: "batch-20260829-b",
		batch: "batch-20260829-a",
		task: "other",
		status: "failed",
	};
	const legacyOnly = {
		batch: "batch-20260829-a",
		task: "legacy",
		status: "failed",
	};

	assert.deepEqual(
		jobsForBatch([canonical, otherBatch, legacyOnly], "batch-20260829-a"),
		[canonical],
	);
	assert.equal(taskReference(canonical), "batch-20260829-a:canonical");
	assert.equal(taskReference(legacyOnly), null);
});

test("selected batch cancellation preserves the exact id when batch names are duplicated", async () => {
	const { batchCancelRequest } = await loadContracts();
	const batches = [
		{ id: "train-20260829T120000", name: "train" },
		{ id: "train-20260829T130000", name: "train" },
	];

	assert.deepEqual(
		batchCancelRequest(batches[1]),
		{ op: "cancel", id: "train-20260829T130000" },
	);
	assert.equal(batchCancelRequest({ name: "train" }), null);
});

test("canonical failure statuses expose terminal presentation and supported controls", async () => {
	const { taskStatusContract } = await loadContracts();
	const retryable = {
		category: "failure",
		terminal: true,
		controls: ["log", "retry", "resubmit"],
	};

	for (const status of ["blocked", "timed_out", "failed", "cancelled"]) {
		assert.deepEqual(taskStatusContract(status), retryable, status);
	}
	assert.deepEqual(
		taskStatusContract("interrupted"),
		{
			category: "failure",
			terminal: true,
			controls: ["log", "resubmit"],
		},
	);
});

test("submit examples contain a schema-valid command that needs no profile placeholders", async () => {
	const { SUBMIT_EXAMPLE, submitExampleForProject } = await loadContracts();
	const examples = [
		JSON.parse(SUBMIT_EXAMPLE),
		JSON.parse(submitExampleForProject("research")),
	];

	for (const example of examples) {
		assert.equal(typeof example.project, "string");
		assert.notEqual(example.project.trim(), "");
		assert.ok(Array.isArray(example.tasks));
		assert.ok(example.tasks.length > 0);
		for (const task of example.tasks) {
			assert.equal(typeof task.id, "string");
			assert.notEqual(task.id.trim(), "");
			assert.deepEqual(task.cmd, ["echo", "hello from sched"]);
			assert.equal(task.cmd.some((token) => /\{(?:VENV|ROOT|stage\d+_)/.test(token)), false);
		}
	}
});

test("scheduler mutations are read-only for stale or truncated snapshots", async () => {
	const { schedulerMutationAvailability } = await loadContracts();
	const ready = {
		ok: true,
		fresh: true,
		raw: {
			schema_version: 1,
			truncated: { batches: false, jobs: false },
		},
	};
	assert.deepEqual(schedulerMutationAvailability(ready), { writable: true, reason: "" });
	assert.equal(schedulerMutationAvailability({ ...ready, fresh: false }).writable, false);
	assert.match(schedulerMutationAvailability({
		...ready,
		raw: { ...ready.raw, truncated: { batches: true, jobs: false } },
	}).reason, /truncated|分页|截断/i);
});

test("UI mutation request ids survive tab replacement and are claimed atomically across tabs", async () => {
	const {
		DurableRequestStore,
		buildOperationRequest,
	} = await loadContracts();
	const values = new Map();
	let tail = Promise.resolve();
	const transact = (operation) => {
		const current = tail.then(() => operation({
			get: async (key) => values.get(key),
			put: async (key, value) => values.set(key, value),
			delete: async (key) => values.delete(key),
		}));
		tail = current.catch(() => {});
		return current;
	};
	const firstTab = new DurableRequestStore(transact);
	const replacementTab = new DurableRequestStore(transact);
	const [first, concurrent] = await Promise.all([
		firstTab.claim("retry:batch-a:fit", () => "uuid-1"),
		replacementTab.claim("retry:batch-a:fit", () => "uuid-2"),
	]);
	assert.equal(first, "uuid-1");
	assert.equal(concurrent, first);
	assert.equal(await replacementTab.claim("retry:batch-a:fit", () => "uuid-3"), first);
	assert.deepEqual(buildOperationRequest(
		"retry",
		{ batch_id: "batch-a", task: "fit", status: "failed", version: 2, revision: 9 },
		first,
	), {
		op: "retry",
		id: "batch-a:fit",
		requestId: "uuid-1",
		expectedStatus: "failed",
		expectedVersion: 2,
		expectedRevision: 9,
	});
	assert.equal(await firstTab.complete("retry:batch-a:fit", "another-request"), false);
	assert.equal(await replacementTab.complete("retry:batch-a:fit", first), true);
	assert.equal(await firstTab.claim("retry:batch-a:fit", () => "uuid-4"), "uuid-4");
});

test("UI operation bindings consume batch/GPU revision and exact assignments", async () => {
	const { buildOperationRequest } = await loadContracts();
	assert.deepEqual(
		buildOperationRequest("cancel", { id: "batch-a", status: "active", revision: 4 }, "cancel-1"),
		{
			op: "cancel",
			id: "batch-a",
			requestId: "cancel-1",
			expectedStatus: "active",
			expectedRevision: 4,
		},
	);
	assert.deepEqual(
		buildOperationRequest("gpu-free", {
			idx: 0,
			status: "assigned",
			quarantined: 0,
			revision: 7,
			assignments: [
				{ job_id: "batch-a:fit", vram_gib: 8 },
				{ job_id: "batch-a:validate", vram_gib: 4 },
			],
		}, "gpu-1"),
		{
			op: "gpu-free",
			id: "0",
			requestId: "gpu-1",
			expectedStatus: "assigned",
			expectedQuarantined: 0,
			expectedRevision: 7,
			expectedAssignments: [
				{ job_id: "batch-a:fit", vram_gib: 8 },
				{ job_id: "batch-a:validate", vram_gib: 4 },
			],
		},
	);
});

test("unknown transport and sched outcomes retain request ids; definitive outcomes remove only matching ids", async () => {
	const { mutationResultIsDefinitive } = await loadContracts();
	assert.equal(mutationResultIsDefinitive({ code: -1 }), false);
	assert.equal(mutationResultIsDefinitive({ code: 75 }), false);
	assert.equal(mutationResultIsDefinitive({ code: 0 }), true);
	assert.equal(mutationResultIsDefinitive({ code: 64 }), true);
	assert.equal(mutationResultIsDefinitive({ code: 65 }), true);
});

test("status paging follows independent batch and job cursors without exposing page lengths as totals", async () => {
	const { collectStatusPages } = await loadContracts();
	const calls = [];
	const page = (batches, jobs, truncated, nextCursor, nextJobCursor) => ({
		schema_version: 1,
		limit: 1,
		truncated,
		next_cursor: nextCursor,
		next_job_cursor: nextJobCursor,
		daemon_health: {},
		cpu: { used: 0, total: 0 },
		gpus: [],
		batches,
		jobs,
	});
	const pages = new Map([
		["|", page(
			[{ id: "batch-a", revision: 1 }],
			[{ id: "job-a" }],
			{ batches: true, jobs: true },
			"batch-next",
			"job-next-a",
		)],
		["|job-next-a", page(
			[{ id: "batch-a", revision: 1 }],
			[{ id: "job-b" }],
			{ batches: true, jobs: false },
			"batch-next",
			null,
		)],
		["batch-next|", page(
			[{ id: "batch-b", revision: 1 }],
			[{ id: "job-c" }],
			{ batches: false, jobs: false },
			null,
			null,
		)],
	]);
	const result = await collectStatusPages(async ({ cursor, jobCursor }) => {
		calls.push([cursor ?? null, jobCursor ?? null]);
		return pages.get(`${cursor ?? ""}|${jobCursor ?? ""}`);
	});
	assert.deepEqual(calls, [
		[null, null],
		[null, "job-next-a"],
		["batch-next", null],
	]);
	assert.deepEqual(result.batches.map(({ id }) => id), ["batch-a", "batch-b"]);
	assert.deepEqual(result.jobs.map(({ id }) => id), ["job-a", "job-b", "job-c"]);
	assert.deepEqual(result.truncated, { batches: false, jobs: false });
	assert.equal(result.loaded.batches, 2);
	assert.equal(Object.hasOwn(result.loaded, "totalBatches"), false);
});

test("history paging appends stable pages, preserves truncation, and rejects cursor loops", async () => {
	const { collectHistoryPages } = await loadContracts();
	const pages = new Map([
		["", {
			schema_version: 1,
			limit: 1,
			history: [{ batch_id: "batch-a", task: "fit", version: 1 }],
			truncated: true,
			next_cursor: "next",
		}],
		["next", {
			schema_version: 1,
			limit: 1,
			history: [{ batch_id: "batch-b", task: "fit", version: 1 }],
			truncated: false,
			next_cursor: null,
		}],
	]);
	const result = await collectHistoryPages(({ cursor }) => pages.get(cursor ?? ""));
	assert.deepEqual(result.history.map(({ batch_id }) => batch_id), ["batch-a", "batch-b"]);
	assert.equal(result.truncated, false);
	assert.equal(result.loaded, 2);
	await assert.rejects(
		collectHistoryPages(async () => ({
			schema_version: 1,
			limit: 1,
			history: [],
			truncated: true,
			next_cursor: "same",
		})),
		/cursor loop/i,
	);
});

test("poll gate ignores out-of-order responses and locally expires apparently fresh data", async () => {
	const { PollGate } = await loadContracts();
	let now = 1_000;
	const gate = new PollGate({ ttlMs: 100, now: () => now });
	const first = gate.issue();
	const second = gate.issue();
	assert.equal(gate.succeed(second, { ok: true, fresh: true, raw: { revision: 2 } }), true);
	assert.equal(gate.succeed(first, { ok: true, fresh: true, raw: { revision: 1 } }), false);
	assert.equal(gate.snapshot().raw.revision, 2);
	gate.fail(first, new Error("old failure"));
	assert.equal(gate.snapshot().ok, true);
	const third = gate.issue();
	assert.equal(gate.fail(third, new Error("poll transport failed")), true);
	const failed = gate.snapshot();
	assert.equal(failed.fresh, false);
	assert.equal(failed.stale, true);
	assert.match(failed.lastError, /poll transport failed/);
	now += 100;
	const stale = gate.snapshot();
	assert.equal(stale.fresh, false);
	assert.equal(stale.stale, true);
	assert.equal(stale.ok, false);
	assert.match(stale.lastError, /local snapshot TTL/i);
});

test("UI validates local bearer tokens and OpenSSH SHA256 host pins", async () => {
	const { validAccessToken, validHostKey } = await loadContracts();
	assert.equal(validAccessToken("a".repeat(43)), true);
	assert.equal(validAccessToken("short"), false);
	assert.equal(validHostKey(`SHA256:${"A".repeat(43)}`), true);
	assert.equal(validHostKey(`SHA256:${"A".repeat(42)}=`), false);
});
