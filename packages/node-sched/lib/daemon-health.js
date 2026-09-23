// Shared, browser-safe validation. Health decisions belong to sched CLI.
export function canonicalDaemonHealth(raw) {
	const fail = () => { throw new TypeError("daemon health JSON is invalid or unsupported"); };
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema_version !== 1) fail();
	if (!["healthy", "delayed", "stalled", "stopped", "unknown"].includes(raw.health_state)
		|| !["running", "stopped", "unknown"].includes(raw.process_state)) fail();
	for (const key of ["node", "query_host"]) {
		if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 255) fail();
	}
	for (const key of ["heartbeat_age_s", "tick_ok_age_s"]) {
		if (raw[key] !== null && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < 0)) fail();
	}
	if (raw.pid !== null && (!Number.isSafeInteger(raw.pid) || raw.pid <= 0)) fail();
	if (!Number.isFinite(raw.observed_at) || raw.observed_at <= 0
		|| typeof raw.draining !== "boolean" || typeof raw.frozen !== "boolean"
		|| !(raw.read_error === null || ["timestamp_in_future", "health_file_unreadable"].includes(raw.read_error))) fail();
	if (raw.frozen !== (raw.tick_ok_age_s !== null && raw.tick_ok_age_s > 90)) fail();
	if (raw.read_error !== null && raw.health_state !== "unknown") fail();
	if (raw.process_state === "stopped" && !["stopped", "unknown"].includes(raw.health_state)) fail();
	if (raw.health_state === "healthy" && (raw.read_error !== null || raw.process_state === "stopped"
		|| raw.heartbeat_age_s === null || raw.heartbeat_age_s >= 60 || raw.tick_ok_age_s === null || raw.frozen)) fail();
	if (raw.health_state === "stopped" && raw.process_state !== "stopped") fail();
	if (raw.health_state === "stalled" && !raw.frozen) fail();
	return raw;
}
