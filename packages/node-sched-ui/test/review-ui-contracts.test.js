import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const contractsUrl = new URL("../src/ui-contracts.js", import.meta.url);
const loadContracts = () => import(contractsUrl.href);

test("style injection refreshes the existing node during client hot reload", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const start = source.indexOf("function injectStyles()");
	const end = source.indexOf("\n\n\n// ── B23", start);
	const injection = source.slice(start, end);

	assert.ok(start >= 0 && end > start);
	assert.match(injection, /let el = document\.getElementById\("ns-ui-style"\);/);
	assert.match(injection, /if \(!el\) \{/);
	assert.match(injection, /el\.textContent = \[/);
	assert.doesNotMatch(injection, /document\.getElementById\("ns-ui-style"\)\) return/);
});

test("dashboard authentication stays dormant until the panel is visible and authenticated", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const hostStart = source.indexOf("\tfunction DashboardHost({ usePanelInfo })");
	const hostEnd = source.indexOf("\n\t// ── settings card:", hostStart);
	const host = source.slice(hostStart, hostEnd);
	const mountStart = source.indexOf("\tconst disposeMain = cctx.slots.inject(\"main\"");
	const mountEnd = source.indexOf("\n\t// B25c:", mountStart);
	const mount = source.slice(mountStart, mountEnd);
	const telemetryStart = source.indexOf("\t// B25c: 渲染树异常遥测");
	const telemetryEnd = source.indexOf("\n\tconst disposeSettings", telemetryStart);
	const telemetry = source.slice(telemetryStart, telemetryEnd);
	const statusCardStart = source.indexOf("\tfunction StatusCard({ close })");
	const statusCardEnd = source.indexOf("\n\t// DSH 0.1.6:", statusCardStart);
	const statusCard = source.slice(statusCardStart, statusCardEnd);

	assert.ok(hostStart >= 0 && hostEnd > hostStart);
	assert.match(host, /if \(!visible\) return null;/);
	assert.match(host, /auth\.status !== "ready"/);
	assert.match(host, /\? j\(AuthenticationRequiredView,/);
	assert.doesNotMatch(host, /return j\(AuthenticationGate,/);
	assert.match(host, /if \(visible\) void authGate\.restore\(\);/);
	assert.match(host, /visible && auth\.status === "locked" && auth\.hasTrustedDevice/);
	assert.match(host, /authGate\.restore\(\{ force: true \}\)/);
	assert.match(host, /auth\.status !== "ready" \|\| reportedOpen\.current/);
	assert.match(host, /authFetch\("\/sched\/api\/client-log"/);
	assert.doesNotMatch(mount, /authFetch\(/);
	assert.match(telemetry, /if \(!panelVisible\) return;/);
	assert.match(statusCard, /open && auth\.status === "ready"/);
	assert.doesNotMatch(source, /window\.prompt\s*\(/);
	assert.match(source, /authGate\.authorizedFetch\(input, init\)/);
	assert.match(source, /authGate\.webSocketProtocols\(\)/);
});

test("locked dashboard uses a non-blocking banner and opens authentication only on demand", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const start = source.indexOf("\tfunction AuthenticationRequiredView({ auth, onClose })");
	const end = source.indexOf("\n\tfunction Dashboard({ onClose, visible, auth })", start);
	const view = source.slice(start, end);

	assert.ok(start >= 0 && end > start);
	assert.match(view, /const \[dialogOpen, setDialogOpen\] = useState\(false\);/);
	assert.match(view, /"aria-label": "sched 连接状态"/);
	assert.match(view, /验证框不会自动弹出/);
	assert.match(view, /onClick: \(\) => setDialogOpen\(true\)/);
	assert.match(view, /dialogOpen && j\(AuthenticationGate,/);
	assert.match(view, /onCancel: \(\) => setDialogOpen\(false\)/);
	assert.match(view, /尚未连接时不会请求远程调度数据/);
	assert.doesNotMatch(view, /authFetch\(|authGate\.pair\(/);
});

test("snapshot polling isolates disabled and superseded requests", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const start = source.indexOf("\tfunction useSnapshot(path, ms, enabled = true)");
	const end = source.indexOf("\n\tfunction parseProgress", start);
	const hook = source.slice(start, end);
	assert.ok(start >= 0 && end > start);
	assert.match(hook, /new EnabledRequestEpoch\(enabled\)/);
	assert.match(hook, /if \(requestEpochRef\.current\.setEnabled\(enabled\)\)/);
	assert.match(hook, /inFlightRef\.current = null;/);
	assert.match(hook, /if \(isCurrent\(\)\) setData\(gate\.snapshot\(\)\);/);
	assert.match(hook, /requestEpochRef\.current\.invalidate\(\);/);
});

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

test("SSH authentication challenges stay in a banner until the user opens the modal", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const bannerStart = source.indexOf("\tfunction AuthPromptBanner({ req, pendingCount, onOpen })");
	const bannerEnd = source.indexOf("\n\t// B24c: SSH 交互式身份认证弹窗", bannerStart);
	const banner = source.slice(bannerStart, bannerEnd);
	const dashboardStart = source.indexOf("\tfunction Dashboard({ onClose, visible, auth })");
	const dashboardEnd = source.indexOf("\n\tfunction DashboardHost({ usePanelInfo })", dashboardStart);
	const dashboard = source.slice(dashboardStart, dashboardEnd);

	assert.ok(bannerStart >= 0 && bannerEnd > bannerStart);
	assert.ok(dashboardStart >= 0 && dashboardEnd > dashboardStart);
	assert.match(banner, /"aria-label": "SSH 验证请求"/);
	assert.match(banner, /验证请求不会自动弹窗/);
	assert.match(banner, /onClick: onOpen/);
	assert.doesNotMatch(banner, /AuthPromptModal/);
	assert.match(dashboard, /const \[openAuthPromptId, setOpenAuthPromptId\] = useState\(null\);/);
	assert.match(dashboard, /j\(AuthPromptBanner,/);
	assert.match(dashboard, /onOpen: \(\) => setOpenAuthPromptId\(activeAuthPromptId\)/);
	assert.match(dashboard, /openAuthPromptId === activeAuthPromptId && activeAuthPrompt && j\(AuthPromptModal,/);
	assert.doesNotMatch(dashboard, /j\(AuthPromptModal, \{ req: stream\.authQueue/);
});

test("SCHED can reuse an existing terminal OpenSSH ControlMaster without prompting for OTP", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const sshStart = source.indexOf("\tfunction SshTab()");
	const sshEnd = source.indexOf("\n\tfunction SshTerminal", sshStart);
	const sshTab = source.slice(sshStart, sshEnd);
	const daemonStart = source.indexOf("\tfunction DaemonBar({ runOp })");
	const daemonEnd = source.indexOf("\n\n\n\tconst IncidentsTab", daemonStart);
	const daemonBar = source.slice(daemonStart, daemonEnd);
	const terminalStart = source.indexOf("\tfunction SshTerminal(");
	const terminalEnd = source.indexOf("\n\n\tconst GRID", terminalStart);
	const terminal = source.slice(terminalStart, terminalEnd);

	assert.ok(sshStart >= 0 && sshEnd > sshStart);
	assert.ok(daemonStart >= 0 && daemonEnd > daemonStart);
	assert.ok(terminalStart >= 0 && terminalEnd > terminalStart);
	assert.match(sshTab, /binding\?\.mode === "system-openssh"/);
	assert.match(sshTab, /setInterval\(load, 30_000\)/);
	assert.match(sshTab, /authFetch\("\/sched\/ssh\/use-system"/);
	assert.match(sshTab, /body: JSON\.stringify\(\{ sshEntry \}\)/);
	assert.match(sshTab, /result\.code === "no_control_master"/);
	assert.match(sshTab, /binding\?\.master\?\.ready === false/);
	assert.match(sshTab, /"aria-label": "OpenSSH ControlMaster 未就绪"/);
	assert.match(sshTab, /`ssh \$\{activeSystemNotice\.sshEntry\}`/);
	assert.match(sshTab, /dsh 不会弹出 OTP 输入框，也不会读取或保存验证码/);
	assert.match(sshTab, /doUseSystemOpenSsh\(h\.alias\)/);
	assert.match(sshTab, /复用终端登录/);
	assert.match(sshTab, /transport: systemBoundHere \? "system-openssh" : "engine"/);
	assert.match(sshTab, /disabled: systemBoundHere \? !systemMasterReady : !trustReady/);
	assert.match(sshTab, /alias: systemBoundHere \? binding\.sshEntry : h\.alias/);
	assert.match(sshTab, /systemBoundHere \? doUseSystemOpenSsh\(binding\.sshEntry\) : doTest\(h\.alias\)/);
	assert.match(sshTab, /只检测终端 ControlMaster，不发起新的 SSH 身份验证/);
	assert.match(sshTab, /const engineMode = binding\?\.mode === "engine"/);
	assert.match(sshTab, /engineMode && j\("button", \{ onClick: doUnbind/);
	assert.match(sshTab, /const localMode = binding\?\.mode === "local"/);
	assert.doesNotMatch(sshTab, /AuthPromptModal|\/sched\/ssh\/auth-answer/);
	assert.match(terminal, /transport = "engine"/);
	assert.match(terminal, /transport=\$\{encodeURIComponent\(transport\)\}&alias=\$\{encodeURIComponent\(alias\)\}/);
	assert.match(terminal, /\[alias, transport\]/);
	assert.match(terminal, /系统 OpenSSH · 复用终端 ControlMaster/);
	assert.match(daemonBar, /channel\?\.mode === "system-openssh"/);
	assert.match(daemonBar, /master\$\{systemMasterReady \? "✓" : "×"\}/);
});

test("a failed system OpenSSH candidate notice survives polling of the active alias", async () => {
	const { reconcileSystemMasterNotice } = await loadContracts();
	const candidate = {
		source: "candidate",
		sshEntry: "candidate-b",
		error: "No active master for B",
	};

	assert.equal(reconcileSystemMasterNotice(candidate, {
		mode: "system-openssh",
		sshEntry: "active-a",
		master: { ready: true },
	}), candidate);
	assert.deepEqual(reconcileSystemMasterNotice(null, {
		mode: "system-openssh",
		sshEntry: "active-a",
		master: { ready: false },
	}, "No active master for A"), {
		source: "active",
		sshEntry: "active-a",
		error: "No active master for A",
	});
	assert.equal(reconcileSystemMasterNotice(candidate, {
		mode: "system-openssh",
		sshEntry: "candidate-b",
		master: { ready: true },
	}), null);
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
	assert.equal(mutationResultIsDefinitive({ code: 255 }), false);
	assert.equal(mutationResultIsDefinitive({ code: 137 }), false);
	assert.equal(mutationResultIsDefinitive({ ok: true, code: 0 }), true);
	assert.equal(mutationResultIsDefinitive({ ok: false, code: 0 }), false);
	assert.equal(mutationResultIsDefinitive({ code: 64 }), true);
	assert.equal(mutationResultIsDefinitive({ code: 65 }), true);
});

test("operation replay retains its full original binding across reload and state changes", async () => {
	const { DurableRequestStore } = await loadContracts();
	const values = new Map();
	let tail = Promise.resolve();
	const transact = (fn) => {
		const next = tail.then(() => fn({ get: async (key) => values.get(key),
			put: async (key, value) => values.set(key, structuredClone(value)),
			delete: async (key) => values.delete(key) }));
		tail = next.catch(() => {});
		return next;
	};
	const firstTab = new DurableRequestStore(transact);
	const entity = { batch_id: "b", task: "t", status: "failed", version: 1, revision: 2 };
	const request = await firstTab.claimOperation("retry:b:t", "retry", entity, () => "original-id");
	entity.status = "pending";
	entity.revision = 3;
	const replacementTab = new DurableRequestStore(transact);
	const replay = await replacementTab.claimOperation("retry:b:t", "retry", entity, () => "new-id");
	assert.deepEqual(replay, request);
	assert.equal(replay.expectedRevision, 2);
	assert.equal(replay.expectedStatus, "failed");
	await firstTab.claim("legacy:b:t", () => "legacy-id");
	await assert.rejects(replacementTab.claimOperation("legacy:b:t", "retry", entity), /原始前置条件/);
	assert.equal(values.get("legacy:b:t").requestId, "legacy-id");
});

test("page collectors reject truncated responses without a continuation cursor", async () => {
	const { collectStatusPages, collectHistoryPages } = await loadContracts();
	const page = { schema_version: 1, batches: [], jobs: [], gpus: [],
		truncated: { batches: true, jobs: false }, next_cursor: null, next_job_cursor: null };
	await assert.rejects(collectStatusPages(async () => page), /next_cursor/);
	await assert.rejects(collectHistoryPages(async () => ({ schema_version: 1, history: [], truncated: true, next_cursor: null })), /next_cursor/);
	await assert.rejects(collectStatusPages(async () => ({ ...page, truncated: { batches: 0, jobs: false } })), /invalid status page/);
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

test("disabled snapshot epochs reject old completions and re-enable with a fresh generation", async () => {
	const { EnabledRequestEpoch } = await loadContracts();
	const epoch = new EnabledRequestEpoch(true);
	const first = epoch.issue();
	assert.equal(epoch.isCurrent(first), true);
	assert.equal(epoch.setEnabled(false), true);
	assert.equal(epoch.isCurrent(first), false);
	assert.equal(epoch.setEnabled(true), true);
	const second = epoch.issue();
	assert.notEqual(second, first);
	assert.equal(epoch.isCurrent(first), false);
	assert.equal(epoch.isCurrent(second), true);
	assert.equal(epoch.setEnabled(true), false);
	epoch.invalidate();
	assert.equal(epoch.isCurrent(second), false);
});

test("UI validates local bearer tokens and OpenSSH SHA256 host pins", async () => {
	const { validAccessToken, validHostKey } = await loadContracts();
	assert.equal(validAccessToken("a".repeat(43)), true);
	assert.equal(validAccessToken("short"), false);
	assert.equal(validHostKey(`SHA256:${"A".repeat(43)}`), true);
	assert.equal(validHostKey(`SHA256:${"A".repeat(42)}=`), false);
});

test("incident rows preserve complete identity fields without GPU or job overlap", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const start = source.indexOf("\tconst IncidentsTab = memo(function IncidentsTab()");
	const end = source.indexOf("\n\t// B25c: 模块级水合缓存", start);
	const incidents = source.slice(start, end);

	assert.ok(start >= 0 && end > start);
	assert.match(incidents, /display: "grid"/);
	assert.match(incidents, /gridTemplateColumns: "max-content minmax\(0, 1fr\) max-content max-content"/);
	assert.match(incidents, /gridRow: "1 \/ span 2"/);
	assert.match(incidents, /gridColumn: "2 \/ -1"/);
	assert.match(incidents, /whiteSpace: "nowrap"/);
	assert.match(incidents, /wordBreak: "break-word"/);
	assert.doesNotMatch(incidents, /flex: "0 0 30px"|flex: "0 1 130px"|flex: "0 0 70px"|flex: "0 0 36px"/);
});

test("every dashboard multiline text box has a bounded vertical resize grip", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const start = source.indexOf("\tconst resizeHint =");
	const end = source.indexOf("\n\n\n\t\tconst Badge", start);
	const component = source.slice(start, end);

	assert.ok(start >= 0 && end > start);
	assert.match(source, /\.nsResizableTextBox::\-webkit-resizer/);
	assert.match(source, /backgroundSize: "12px 12px"/);
	assert.match(component, /className: \[className, "nsResizableTextBox"\]/);
	assert.match(component, /boxSizing: "border-box"/);
	assert.match(component, /minHeight/);
	assert.match(component, /maxHeight/);
	assert.match(component, /resize: "vertical"/);
	assert.match(component, /overflow: "auto"/);
	assert.equal(source.match(/j\(ResizableTextBox,/g)?.length, 7);
	assert.equal(source.match(/as: "textarea"/g)?.length, 2);
	assert.doesNotMatch(source, /j\("textarea"/);
	assert.doesNotMatch(source, /j\("pre"/);
	assert.match(source, /"aria-label": "批次 JSON"/);
	assert.match(source, /"aria-label": "配置 JSON"/);
});

test("resize grips render at one unified size on every resizable text box", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");

	// 原生 resizer 完全透明化（textarea 上会叠加尺寸不一的原生抓手）
	assert.match(source, /\.nsResizableTextBox::-webkit-resizer \{ -webkit-appearance: none; appearance: none; background: transparent !important; \}/);
	// 抓手统一画在元素自身背景上，唯一尺寸声明（12px）
	assert.equal((source.match(/backgroundSize: "12px 12px"/g) ?? []).length, 1);
	assert.match(source, /backgroundPosition: "right bottom"/);
	assert.match(source, /backgroundRepeat: "no-repeat"/);
	assert.doesNotMatch(source, /right bottom \/ \d+px \d+px no-repeat/);
});

test("in-page buttons expose unified hover feedback aligned with the sidebar entries", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");

	// btn()/ghostBtn 注入 .nsBtn；悬停/按压反馈；禁用态无反馈
	assert.match(source, /\.nsBtn::after \{ content:/);
	assert.match(source, /\.nsBtn:not\(:disabled\):hover::after \{ opacity: 0\.15; \}/);
	assert.match(source, /\.nsBtn:not\(:disabled\):active::after \{ opacity: 0\.3; \}/);
	assert.match(source, /className: "nsBtn", "--ns-btn-hover": color/);
	assert.match(source, /className: "nsBtn", "--ns-btn-hover": "var\(--dsw-alias-label-secondary, #6b7280\)"/);
	// tab：未选中悬停预览选中态（色值/描边切到品牌色）；已选中悬停/按压不再叠加反馈层
	assert.match(source, /\.nsBtn\.nsTab:not\(:disabled\):hover \{ color: var\(--ns-btn-hover, #3b82f6\) !important/);
	assert.match(source, /\.nsBtn\.nsTabOn:not\(:disabled\):hover::after/);
	assert.match(source, /className: selected \? "nsBtn nsTab nsTabOn" : "nsBtn nsTab"/);
	assert.match(source, /const tabBtn = \(color, selected\) =>/);
	assert.match(source, /style: tabBtn\(T\.brand, tab === t\)/);
});

test("history tab renders a sticky column header row with overflow-safe cells", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const start = source.indexOf("\tfunction HistoryTab()");
	const end = source.indexOf("\n\tfunction AuthenticationGate", start);
	const historyTab = source.slice(start, end);

	assert.ok(start >= 0 && end > start);
	assert.match(historyTab, /const HISTORY_GRID = "minmax\(0,2fr\) minmax\(0,1\.4fr\) minmax\(0,1fr\) minmax\(0,\.7fr\)"/);
	assert.match(historyTab, /j\("span", null, "batch"\)/);
	assert.match(historyTab, /j\("span", null, "task"\)/);
	assert.match(historyTab, /j\("span", null, "status"\)/);
	assert.match(historyTab, /j\("span", null, "version"\)/);
	assert.match(historyTab, /position: "sticky"/);
	assert.match(historyTab, /gridTemplateColumns: HISTORY_GRID/);
	assert.equal((historyTab.match(/textOverflow: "ellipsis"/g) ?? []).length, 4);
	assert.equal((historyTab.match(/whiteSpace: "nowrap"/g) ?? []).length, 4);
});

test("SSH host trust UI reuses known_hosts, supports zero-credential confirmation, and truly cancels", async () => {
	const source = await readFile(new URL("../src/client.jsx", import.meta.url), "utf8");
	const start = source.indexOf("\tfunction SshTab()");
	const end = source.indexOf("\n\tfunction SshTerminal", start);
	const sshTab = source.slice(start, end);
	assert.ok(start >= 0 && end > start);
	assert.match(sshTab, /authFetch\("\/sched\/ssh\/host-key"/);
	assert.match(sshTab, /action:\s*"prepare"/);
	assert.match(sshTab, /action:\s*"confirm"/);
	assert.match(sshTab, /action:\s*"cancel"/);
	assert.match(sshTab, /new AbortController\(\)/);
	assert.match(sshTab, /trustAbortRef\.current\?\.abort\(\)/);
	assert.match(sshTab, /trustEpochRef\.current \+= 1/);
	assert.match(sshTab, /trustCommitRef\.current/);
	assert.match(sshTab, /expectedHostRevision:\s*current\.challenge\.targetRevision/);
	assert.match(sshTab, /targetAlias:\s*current\.targetAlias/);
	assert.match(sshTab, /known_hosts/);
	assert.match(sshTab, /未向这台待确认主机发送密码、私钥、ssh-agent 签名或动态验证码/);
	assert.match(sshTab, /确认并信任/);
	assert.match(sshTab, /保存已开始，不能再撤销本次确认/);
	assert.match(sshTab, /服务器身份已信任；但用户认证或连通性测试失败/);
});
