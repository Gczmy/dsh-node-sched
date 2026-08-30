export function createLimitedOutput() {
	return {
		text: "",
		bytes: 0,
		droppedBytes: 0,
		truncated: false,
		pending: Buffer.alloc(0),
	};
}

function initializeLimitedOutput(target) {
	if (typeof target.text !== "string") target.text = String(target.text ?? "");
	if (!Number.isFinite(target.bytes) || target.bytes < 0) {
		target.bytes = Buffer.byteLength(target.text, "utf8");
	}
	if (!Number.isFinite(target.droppedBytes) || target.droppedBytes < 0) {
		target.droppedBytes = 0;
	}
	target.truncated = target.truncated === true;
	if (!Buffer.isBuffer(target.pending)) target.pending = Buffer.alloc(0);
	return target;
}

function completeUtf8Length(buffer) {
	let continuationCount = 0;
	let index = buffer.length - 1;
	while (index >= 0 && (buffer[index] & 0xc0) === 0x80) {
		continuationCount += 1;
		index -= 1;
	}
	if (index < 0) return buffer.length;
	const lead = buffer[index];
	const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
	return expected > continuationCount + 1 ? index : buffer.length;
}

export function appendLimitedOutput(target, chunk, maxBytes) {
	initializeLimitedOutput(target);
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
	if (target.truncated) {
		target.droppedBytes += buffer.length;
		return;
	}
	const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
	target.maxBytes = limit;
	const pending = target.pending.length ? Buffer.concat([target.pending, buffer]) : buffer;
	const completeLength = completeUtf8Length(pending);
	const complete = pending.subarray(0, completeLength);
	const remaining = Math.max(0, limit - target.bytes);
	if (complete.length <= remaining) {
		target.text += complete.toString("utf8");
		target.bytes += complete.length;
		target.pending = Buffer.from(pending.subarray(completeLength));
		if (remaining === complete.length && target.pending.length > 0) {
			target.droppedBytes += target.pending.length;
			target.pending = Buffer.alloc(0);
			target.truncated = true;
		}
		return;
	}
	let accepted = remaining;
	let text = complete.subarray(0, accepted).toString("utf8");
	while (
		accepted > 0 &&
		(Buffer.byteLength(text, "utf8") > remaining ||
			completeUtf8Length(complete.subarray(0, accepted)) !== accepted)
	) {
		accepted -= 1;
		text = complete.subarray(0, accepted).toString("utf8");
	}
	target.text += text;
	target.bytes += accepted;
	target.droppedBytes += pending.length - accepted;
	target.pending = Buffer.alloc(0);
	target.truncated = true;
}

export function finalizeLimitedOutput(target) {
	initializeLimitedOutput(target);
	if (!target.pending.length) return;
	const configuredLimit = Number.isFinite(target.maxBytes)
		? Math.max(0, Math.floor(target.maxBytes))
		: Number.POSITIVE_INFINITY;
	const remaining = Math.max(0, configuredLimit - target.bytes);
	const accepted = target.truncated ? 0 : Math.min(remaining, target.pending.length);
	if (accepted > 0) {
		target.text += target.pending.subarray(0, accepted).toString("utf8");
		target.bytes += accepted;
	}
	const dropped = target.pending.length - accepted;
	if (dropped > 0) {
		target.droppedBytes += dropped;
		target.truncated = true;
	}
	target.pending = Buffer.alloc(0);
}

export function limitedOutputText(target) {
	initializeLimitedOutput(target);
	if (!target.truncated) return target.text;
	return `${target.text}\n…[truncated ${target.droppedBytes} bytes]`;
}
