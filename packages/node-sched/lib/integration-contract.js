// Public integration facts. These reads never select or replay a writer.
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const INSTANCE_ID = /^[0-9a-f]{32}$/;
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);

export function canonicalIdentity(raw) {
    if (!record(raw) || raw.schema_version !== 1 || raw.query !== "identity"
        || raw.contract !== "sched-identity-v1" || typeof raw.available !== "boolean"
        || !text(raw.node) || !text(raw.query_host)) throw new TypeError("invalid identity envelope");
    if (raw.available ? !INSTANCE_ID.test(raw.instance_id) || raw.reason !== null
        : raw.instance_id !== null || !["state_unavailable", "migration_required"].includes(raw.reason)) {
        throw new TypeError("invalid identity availability");
    }
    return { schema_version: 1, query: raw.query, contract: raw.contract,
        instance_id: raw.instance_id, available: raw.available, reason: raw.reason,
        node: raw.node, query_host: raw.query_host };
}

export function canonicalRequestStatus(raw, requestId) {
    if (!record(raw) || raw.schema_version !== 1 || raw.query !== "request_status"
        || raw.contract !== "sched-request-status-v1" || raw.request_id !== requestId
        || typeof requestId !== "string" || !REQUEST_ID.test(requestId) || typeof raw.found !== "boolean"
        || !["not_found", "unknown", "delivered", "done"].includes(raw.phase)
        || (raw.instance_id !== null && !INSTANCE_ID.test(raw.instance_id))
        || typeof raw.output_compacted !== "boolean") throw new TypeError("invalid request receipt");
    if (raw.phase === "not_found" ? raw.found || raw.code !== null
        : !raw.found || !["operation", "submission"].includes(raw.request_kind)) throw new TypeError("invalid request phase");
    if (["done", "delivered"].includes(raw.phase)
        ? !Number.isInteger(raw.code) || raw.code < 0 || raw.code > 255
        : raw.code !== null) throw new TypeError("invalid request code");
    if (raw.binding_sha256 !== null && !/^[0-9a-f]{64}$/.test(raw.binding_sha256)) throw new TypeError("invalid request binding");
    // Select only documented receipt fields; raw command/output is never relayed.
    if (raw.payload_sha256 !== undefined && (typeof raw.payload_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.payload_sha256))) throw new TypeError("invalid payload binding");
    const result = raw.result;
    if (result !== null && !record(result)) throw new TypeError("invalid request result");
    const selected = result === null ? null : {};
    if (selected !== null) {
        for (const key of ["batch_id", "project", "delivery", "outcome"]) {
            if (Object.hasOwn(result, key) && !text(result[key])) throw new TypeError("invalid receipt field");
        }
        if (Object.hasOwn(result,"persisted") && typeof result.persisted !== "boolean") throw new TypeError("invalid persistence fact");
        if (Object.hasOwn(result,"tasks") && (!Number.isInteger(result.tasks) || result.tasks < 0)) throw new TypeError("invalid task count");
        for (const key of ["outcome", "batch_id", "delivery", "persisted", "project", "tasks"]) {
            if (Object.hasOwn(result, key)) selected[key] = result[key];
        }
        if (result.effect !== undefined) {
            if (result.effect !== null && !record(result.effect)) throw new TypeError("invalid request effect");
            selected.effect = result.effect === null ? null : Object.fromEntries(
                ["batch_id", "task", "version", "status", "project", "batch_revision"]
                    .filter((key) => Object.hasOwn(result.effect, key)).map((key) => [key, result.effect[key]]));
        }
    }
    return { schema_version: 1, query: raw.query, contract: raw.contract, request_id: requestId,
        instance_id: raw.instance_id, found: raw.found, request_kind: raw.request_kind,
        phase: raw.phase, code: raw.code, output_compacted: raw.output_compacted,
        binding_sha256: raw.binding_sha256, result: selected,
        ...(raw.payload_sha256 === undefined ? {} : { payload_sha256: raw.payload_sha256 }) };
}

export function integrationReadCommand(schedBin, kind, requestId) {
    if (typeof schedBin !== "string" || !schedBin) throw new TypeError("sched binary required");
    if (kind === "identity") return `${schedBin} identity --json`;
    if (kind !== "request-status" || typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new TypeError("invalid integration query");
    return `${schedBin} request-status '${requestId}' --json`;
}
