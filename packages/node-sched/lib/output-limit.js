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
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
	if (target.truncated) {
		target.droppedBytes += buffer.length;
		return;
	}
	const pending = target.pending?.length ? Buffer.concat([target.pending, buffer]) : buffer;
	const completeLength = completeUtf8Length(pending);
	const complete = pending.subarray(0, completeLength);
	const remaining = maxBytes - target.bytes;
	if (complete.length <= remaining) {
		target.text += complete.toString("utf8");
		target.bytes += complete.length;
		target.pending = Buffer.from(pending.subarray(completeLength));
		if (remaining === 0 && target.pending.length > 0) {
			target.droppedBytes += target.pending.length;
			target.pending = Buffer.alloc(0);
			target.truncated = true;
		}
		return;
	}
	let accepted = Math.max(0, remaining);
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
	if (!target.pending?.length) return;
	if (target.truncated) {
		target.droppedBytes += target.pending.length;
	} else {
		target.text += target.pending.toString("utf8");
		target.bytes += target.pending.length;
	}
	target.pending = Buffer.alloc(0);
}

export function limitedOutputText(target) {
	if (!target.truncated) return target.text;
	return `${target.text}\n…[truncated ${target.droppedBytes} bytes]`;
}
