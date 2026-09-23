const TERMINAL_AUTH_STATES = new Set(["resolved", "expired", "cancelled"]);

const MAX_AUTH_ERROR_CHARS = 240;

function boundedAuthError(text) {
	const value = String(text);
	return value.length <= MAX_AUTH_ERROR_CHARS
		? value
		: `${value.slice(0, MAX_AUTH_ERROR_CHARS - 1)}…`;
}

export function submitExampleForProject(project) {
	const selectedProject = typeof project === "string" && project.trim()
		? project.trim()
		: "default";
	return JSON.stringify({
		project: selectedProject,
		name: "my_batch",
		tasks: [
			{ id: "t1", cmd: ["echo", "hello from sched"], duration_min: 5 },
		],
	});
}

export function configuredProjectNames(config) {
	const projects = config?.projects;
	if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];
	const names = Object.keys(projects).filter((name) => name.trim()).sort();
	const preferred = typeof config.default_project === "string"
		? config.default_project.trim()
		: "";
	if (!preferred || !names.includes(preferred)) return names;
	return [preferred, ...names.filter((name) => name !== preferred)];
}

export function projectGpuAccessLabel(project = {}) {
	if (project.gpu_enabled === false) return "GPU 已禁用";
	const quota = Number(project.gpu_quota || 0);
	return quota > 0 ? `GPU 配额 ${quota}` : "GPU 无限制";
}

export function projectSettingsPatch(config) {
	const projects = {};
	for (const [name, project] of Object.entries(config.projects || {})) {
		projects[name] = {};
		for (const key of ["gpu_enabled", "gpu_quota", "priority", "max_jobs"]) {
			if (project[key] !== undefined && project[key] !== null) projects[name][key] = project[key];
		}
		// Keep the existing nullable colocate patch contract.
		if (project.colocate !== undefined) projects[name].colocate = project.colocate;
	}
	return { projects };
}

export function taskWaitLabel(task) {
	if (task?.status !== "pending") return "";
	return {
		project_gpu_disabled: "项目 GPU 已禁用，等待启用",
		quota: "等待 GPU 配额",
		dependency: "等待依赖",
		cpu: "等待 CPU 预留额度",
		host_memory: "等待主机内存",
		gpu: "等待可用 GPU",
		parallel: "等待批次并发名额",
		draining: "调度器排空中，暂停派发",
		batch_blocked: "批次尚未激活",
	}[task.wait_reason] || "";
}

export const SUBMIT_EXAMPLE = submitExampleForProject("default");

const TASK_STATUS_CONTRACTS = Object.freeze({
	pending: Object.freeze({
		category: "pending",
		terminal: false,
		controls: Object.freeze([]),
	}),
	running: Object.freeze({
		category: "running",
		terminal: false,
		controls: Object.freeze(["log"]),
	}),
	done: Object.freeze({
		category: "success",
		terminal: true,
		controls: Object.freeze(["log"]),
	}),
	skip: Object.freeze({
		category: "success",
		terminal: true,
		controls: Object.freeze(["log"]),
	}),
	blocked: Object.freeze({
		category: "failure",
		terminal: true,
		controls: Object.freeze(["log", "retry", "resubmit"]),
	}),
	timed_out: Object.freeze({
		category: "failure",
		terminal: true,
		controls: Object.freeze(["log", "retry", "resubmit"]),
	}),
	failed: Object.freeze({
		category: "failure",
		terminal: true,
		controls: Object.freeze(["log", "retry", "resubmit"]),
	}),
	cancelled: Object.freeze({
		category: "failure",
		terminal: true,
		controls: Object.freeze(["log", "retry", "resubmit"]),
	}),
	interrupted: Object.freeze({
		category: "failure",
		terminal: true,
		controls: Object.freeze(["log", "resubmit"]),
	}),
});

const UNKNOWN_TASK_STATUS_CONTRACT = Object.freeze({
	category: "pending",
	terminal: false,
	controls: Object.freeze([]),
});

export function jobsForBatch(jobs, batchId) {
	if (!Array.isArray(jobs) || typeof batchId !== "string" || !batchId) return [];
	return jobs.filter((job) => job?.batch_id === batchId);
}

export function taskReference(task) {
	if (
		typeof task?.batch_id !== "string"
		|| !task.batch_id
		|| typeof task.task !== "string"
		|| !task.task
	) return null;
	return `${task.batch_id}:${task.task}`;
}

export function batchCancelRequest(batch) {
	if (typeof batch?.id !== "string" || !batch.id) return null;
	return { op: "cancel", id: batch.id };
}

export function taskStatusContract(status) {
	return Object.hasOwn(TASK_STATUS_CONTRACTS, status)
		? TASK_STATUS_CONTRACTS[status]
		: UNKNOWN_TASK_STATUS_CONTRACT;
}

export function authAnswerErrorText({ status, statusText, body, cause } = {}) {
	const serverMessage = typeof body === "string"
		? body.trim()
		: typeof body?.error === "string"
			? body.error.trim()
			: typeof body?.message === "string" ? body.message.trim() : "";
	if (serverMessage) return boundedAuthError(serverMessage);

	const causeMessage = cause instanceof Error
		? cause.message
		: cause == null ? "" : String(cause);
	if (causeMessage) return boundedAuthError(causeMessage);

	const responseDetails = [status, statusText]
		.filter((part) => part != null && String(part).trim())
		.join(" ");
	return boundedAuthError(
		responseDetails ? `Authentication answer failed: ${responseDetails}` : "Authentication answer failed",
	);
}

export function listenCaptured(target, type, listener) {
	target.addEventListener(type, listener, true);
	return () => target.removeEventListener(type, listener, true);
}

export function normalizeAuthPrompts(request) {
	if (Array.isArray(request?.prompts)) return request.prompts;
	if (!request) return [];
	return [{ id: "0", prompt: request.prompt || "Authentication response", echo: false }];
}

export function buildAuthAnswer(prompts, answers) {
	const values = Array.isArray(answers) ? answers : [];
	return {
		kind: "answers",
		answers: prompts.map((_, index) => values[index] ?? ""),
	};
}

export function reduceAuthQueue(queue, frame) {
	const current = Array.isArray(queue) ? queue : [];
	if (!frame || typeof frame !== "object") return current;
	if (frame.type === "auth-snapshot") {
		if (!Array.isArray(frame.requests)) return current;
		const requestsById = new Map();
		for (const request of frame.requests) {
			if (request?.id != null) requestsById.set(request.id, request);
		}
		return [...requestsById.values()];
	}
	if (frame.type !== "auth" || frame.id == null) return current;
	if (TERMINAL_AUTH_STATES.has(frame.state)) {
		return current.filter((request) => request.id !== frame.id);
	}
	return [...current.filter((request) => request.id !== frame.id), frame];
}

export function authAudienceFrame(visible) {
	return { type: "auth-audience", visible: Boolean(visible) };
}

export function validAccessToken(token) {
	return typeof token === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(token);
}

export function validHostKey(hostKey) {
	return typeof hostKey === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey);
}

export function reconcileSystemMasterNotice(current, binding, error = "") {
	const systemMode = binding?.mode === "system-openssh";
	const activeEntry = systemMode && typeof binding.sshEntry === "string"
		? binding.sshEntry
		: "";
	// A failed attempt to select another alias is actionable on its own. Do not
	// let polling of the still-active alias erase that candidate's instructions.
	if (current?.source === "candidate" && current.sshEntry !== activeEntry) return current;
	if (!systemMode || binding?.master?.ready === true) return null;
	if (binding?.master?.ready === false) {
		return { source: "active", sshEntry: activeEntry, error: String(error || "") };
	}
	return null;
}

export function schedulerMutationAvailability(snapshot) {
	if (!snapshot || snapshot.ok !== true || snapshot.fresh !== true) {
		return { writable: false, reason: "调度器状态不是最新快照，操作已切换为只读。" };
	}
	const raw = snapshot.raw;
	if (
		!raw
		|| raw.schema_version !== 1
		|| !raw.truncated
		|| typeof raw.truncated.batches !== "boolean"
		|| typeof raw.truncated.jobs !== "boolean"
	) {
		return { writable: false, reason: "调度器状态协议无效，操作已切换为只读。" };
	}
	if (raw.truncated.batches || raw.truncated.jobs) {
		return { writable: false, reason: "调度器状态已截断（需要分页），操作已切换为只读。" };
	}
	return { writable: true, reason: "" };
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REQUEST_DATABASE_NAME = "node-sched-mutations";
const REQUEST_OBJECT_STORE = "requests";

export class DurableRequestStore {
	constructor(transact) {
		if (typeof transact !== "function") throw new Error("durable request transaction is required");
		this.transact = transact;
	}

	claim(key, create = () => crypto.randomUUID()) {
		if (typeof key !== "string" || !key) throw new Error("durable request key is required");
		return this.transact(async (store) => {
			const existing = await store.get(key);
			if (REQUEST_ID_PATTERN.test(existing?.requestId ?? "")) return existing.requestId;
			const requestId = String(create());
			if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("generated mutation request id is invalid");
			await store.put(key, { requestId, createdAt: Date.now() });
			return requestId;
		});
	}

	complete(key, requestId) {
		if (typeof key !== "string" || !key || !REQUEST_ID_PATTERN.test(requestId ?? "")) {
			throw new Error("durable request key and id are required");
		}
		return this.transact(async (store) => {
			const existing = await store.get(key);
			if (existing?.requestId !== requestId) return false;
			await store.delete(key);
			return true;
		});
	}

	claimOperation(key, op, entity, create = () => crypto.randomUUID()) {
		if (typeof key !== "string" || !key) throw new Error("durable request key is required");
		return this.transact(async (store) => {
			const existing = await store.get(key);
			if (existing) {
				if (!existing.request || existing.request.requestId !== existing.requestId) {
					throw new Error("旧操作缺少原始前置条件，请先通过 sched CLI 确认结果；不能自动重发。");
				}
				return structuredClone(existing.request);
			}
			const request = buildOperationRequest(op, entity, String(create()));
			await store.put(key, { requestId: request.requestId, request, createdAt: Date.now() });
			return structuredClone(request);
		});
	}
}

function requestPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

export function createIndexedDbRequestStore(
	indexedDb = globalThis.indexedDB,
	databaseName = REQUEST_DATABASE_NAME,
) {
	if (!indexedDb || typeof indexedDb.open !== "function") {
		throw new Error("IndexedDB is required for durable scheduler mutations");
	}
	const database = new Promise((resolve, reject) => {
		const request = indexedDb.open(databaseName, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(REQUEST_OBJECT_STORE)) {
				request.result.createObjectStore(REQUEST_OBJECT_STORE);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("cannot open scheduler mutation database"));
		request.onblocked = () => reject(new Error("scheduler mutation database upgrade is blocked"));
	});
	const transact = async (operation) => {
		const db = await database;
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(REQUEST_OBJECT_STORE, "readwrite");
			const objectStore = transaction.objectStore(REQUEST_OBJECT_STORE);
			let result;
			let operationError;
			transaction.oncomplete = () => resolve(result);
			transaction.onabort = () => reject(operationError ?? transaction.error ?? new Error("mutation transaction aborted"));
			transaction.onerror = () => {
				// onabort is the terminal notification and preserves operationError.
			};
			Promise.resolve(operation({
				get: (key) => requestPromise(objectStore.get(key)),
				put: (key, value) => requestPromise(objectStore.put(value, key)),
				delete: (key) => requestPromise(objectStore.delete(key)),
			})).then(
				(value) => { result = value; },
				(error) => {
					operationError = error;
					try { transaction.abort(); } catch { reject(error); }
				},
			);
		});
	};
	return new DurableRequestStore(transact);
}

function canonicalAssignments(assignments) {
	if (!Array.isArray(assignments)) throw new Error("GPU operation requires exact assignments");
	const result = assignments.map((assignment, index) => {
		if (
			!assignment
			|| typeof assignment !== "object"
			|| Array.isArray(assignment)
			|| Object.keys(assignment).some((key) => key !== "job_id" && key !== "vram_gib")
			|| typeof assignment.job_id !== "string"
			|| !assignment.job_id
			|| (
				assignment.vram_gib !== null
				&& (!Number.isFinite(assignment.vram_gib) || assignment.vram_gib < 0)
			)
		) {
			throw new Error(`GPU assignment ${index} is invalid`);
		}
		return { job_id: assignment.job_id, vram_gib: assignment.vram_gib };
	});
	for (let index = 1; index < result.length; index += 1) {
		if (result[index - 1].job_id >= result[index].job_id) {
			throw new Error("GPU assignments must be uniquely sorted by job_id");
		}
	}
	return result;
}

export function mutationResultIsDefinitive(result) {
	// SSH 255 and signal exits cannot prove that the remote receipt was received.
	return Number.isInteger(result?.code) && result.code >= 0 && result.code < 128
		&& result.code !== 75 && (result.code !== 0 || result.ok === true);
}

export function buildOperationRequest(op, entity, requestId) {
	if (typeof op !== "string" || !op || !REQUEST_ID_PATTERN.test(requestId ?? "")) {
		throw new Error("operation and durable request id are required");
	}
	if (entity?.batch_id && entity?.task) {
		if (
			typeof entity.status !== "string"
			|| !Number.isInteger(entity.version)
			|| entity.version < 1
			|| !Number.isInteger(entity.revision)
			|| entity.revision < 0
		) {
			throw new Error("task operation requires exact status, version, and batch revision");
		}
		return {
			op,
			id: `${entity.batch_id}:${entity.task}`,
			requestId,
			expectedStatus: entity.status,
			expectedVersion: entity.version,
			expectedRevision: entity.revision,
		};
	}
	if (Number.isInteger(entity?.idx) && entity.idx >= 0) {
		if (
			typeof entity.status !== "string"
			|| ![0, 1].includes(entity.quarantined)
			|| !Number.isInteger(entity.revision)
			|| entity.revision < 0
		) {
			throw new Error("GPU operation requires exact status, quarantine state, and revision");
		}
		return {
			op,
			id: String(entity.idx),
			requestId,
			expectedStatus: entity.status,
			expectedQuarantined: entity.quarantined,
			expectedRevision: entity.revision,
			expectedAssignments: canonicalAssignments(entity.assignments),
		};
	}
	if (
		typeof entity?.id === "string"
		&& entity.id
		&& typeof entity.status === "string"
		&& Number.isInteger(entity.revision)
		&& entity.revision >= 0
	) {
		return {
			op,
			id: entity.id,
			requestId,
			expectedStatus: entity.status,
			expectedRevision: entity.revision,
		};
	}
	if (entity == null) return { op, id: "", requestId };
	throw new Error("operation entity is not canonical");
}

function pageCursor(value, label) {
	if (typeof value !== "string" || !value || value.length > 1024) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function stableJson(value) {
	return JSON.stringify(value);
}

export async function collectStatusPages(fetchPage, { maxPages = 100 } = {}) {
	if (typeof fetchPage !== "function") throw new Error("status page loader is required");
	const batches = new Map();
	const jobs = new Map();
	const seenBatchCursors = new Set();
	let first;
	let batchCursor = null;
	let calls = 0;
	do {
		const batchCursorKey = batchCursor ?? "";
		if (seenBatchCursors.has(batchCursorKey)) throw new Error("status batch cursor loop");
		seenBatchCursors.add(batchCursorKey);
		let jobCursor = null;
		const seenJobCursors = new Set();
		let batchPage;
		do {
			const jobCursorKey = jobCursor ?? "";
			if (seenJobCursors.has(jobCursorKey)) throw new Error("status job cursor loop");
			seenJobCursors.add(jobCursorKey);
			if (++calls > maxPages) throw new Error("status paging limit exceeded");
			const page = await fetchPage({ cursor: batchCursor, jobCursor });
			if (!page || page.schema_version !== 1
				|| typeof page.truncated?.batches !== "boolean"
				|| typeof page.truncated?.jobs !== "boolean"
				|| !Array.isArray(page.batches) || !Array.isArray(page.jobs) || !Array.isArray(page.gpus)) {
				throw new Error("invalid status page");
			}
			first ??= page;
			batchPage ??= page;
			if (
				stableJson(page.batches) !== stableJson(batchPage.batches)
				|| stableJson(page.gpus) !== stableJson(first.gpus)
			) {
				throw new Error("status changed during paging");
			}
			for (const batch of page.batches ?? []) {
				const previous = batches.get(batch.id);
				if (previous && stableJson(previous) !== stableJson(batch)) {
					throw new Error(`batch ${batch.id} changed during paging`);
				}
				batches.set(batch.id, batch);
			}
			for (const job of page.jobs ?? []) {
				const previous = jobs.get(job.id);
				if (previous && stableJson(previous) !== stableJson(job)) {
					throw new Error(`job ${job.id} changed during paging`);
				}
				jobs.set(job.id, job);
			}
			jobCursor = page.truncated.jobs
				? pageCursor(page.next_job_cursor, "status next_job_cursor")
				: null;
			if (!page.truncated.jobs && page.next_job_cursor !== null) {
				throw new Error("status next_job_cursor must be null on the final job page");
			}
		} while (jobCursor !== null);
		batchCursor = batchPage.truncated.batches
			? pageCursor(batchPage.next_cursor, "status next_cursor")
			: null;
		if (!batchPage.truncated.batches && batchPage.next_cursor !== null) {
			throw new Error("status next_cursor must be null on the final batch page");
		}
	} while (batchCursor !== null);
	return {
		...first,
		batches: [...batches.values()],
		jobs: [...jobs.values()],
		truncated: { batches: false, jobs: false },
		next_cursor: null,
		next_job_cursor: null,
		loaded: { batches: batches.size, jobs: jobs.size },
	};
}

export async function collectHistoryPages(fetchPage, { maxPages = 100 } = {}) {
	if (typeof fetchPage !== "function") throw new Error("history page loader is required");
	const history = [];
	const seen = new Set();
	let first;
	let cursor = null;
	for (let count = 0; count < maxPages; count += 1) {
		const cursorKey = cursor ?? "";
		if (seen.has(cursorKey)) throw new Error("history cursor loop");
		seen.add(cursorKey);
		const page = await fetchPage({ cursor });
		if (!page || page.schema_version !== 1 || !Array.isArray(page.history) || typeof page.truncated !== "boolean") {
			throw new Error("invalid history page");
		}
		first ??= page;
		history.push(...page.history);
		if (!page.truncated) {
			if (page.next_cursor !== null) throw new Error("history next_cursor must be null on the final page");
			return { ...first, history, truncated: false, next_cursor: null, loaded: history.length };
		}
		cursor = pageCursor(page.next_cursor, "history next_cursor");
	}
	throw new Error("history paging limit exceeded");
}

export class EnabledRequestEpoch {
	constructor(enabled = false) {
		this.enabled = Boolean(enabled);
		this.generation = 0;
	}

	setEnabled(enabled) {
		const next = Boolean(enabled);
		if (next === this.enabled) return false;
		this.enabled = next;
		this.invalidate();
		return true;
	}

	invalidate() {
		this.generation += 1;
		return this.generation;
	}

	issue() { return this.generation; }

	isCurrent(generation) {
		return this.enabled && generation === this.generation;
	}
}

export class PollGate {
	constructor({ ttlMs, now = Date.now } = {}) {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0 || typeof now !== "function") {
			throw new Error("poll gate requires a positive TTL and clock");
		}
		this.ttlMs = ttlMs;
		this.now = now;
		this.issued = 0;
		this.accepted = 0;
		this.value = null;
		this.receivedAt = null;
		this.error = null;
	}

	issue() {
		this.issued += 1;
		return this.issued;
	}

	succeed(sequence, value) {
		if (sequence !== this.issued || sequence <= this.accepted) return false;
		this.accepted = sequence;
		this.value = value;
		this.receivedAt = this.now();
		this.error = null;
		return true;
	}

	fail(sequence, error) {
		if (sequence !== this.issued || sequence < this.accepted) return false;
		this.accepted = sequence;
		this.error = error instanceof Error ? error.message : String(error);
		return true;
	}

	snapshot() {
		if (!this.value) {
			return this.error ? { ok: false, fresh: false, stale: false, lastError: this.error } : null;
		}
		const localAgeMs = Math.max(0, this.now() - this.receivedAt);
		if (localAgeMs >= this.ttlMs) {
			return {
				...this.value,
				ok: false,
				fresh: false,
				stale: true,
				ageMs: Math.max(Number(this.value.ageMs) || 0, localAgeMs),
				lastError: "local snapshot TTL expired",
			};
		}
		if (this.error) {
			return { ...this.value, ok: false, fresh: false, stale: true, lastError: this.error };
		}
		return { ...this.value, localAgeMs };
	}
}
