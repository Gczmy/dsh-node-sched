function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseScreenResult(output, id) {
	const marker = escapeRegExp(id);
	const begin = new RegExp(`^--- begin ${marker}\\r?$`, "m").exec(String(output ?? ""));
	if (!begin) return undefined;
	const bodyStart = begin.index + begin[0].length;
	const body = String(output ?? "").slice(bodyStart).replace(/^\r?\n/, "");
	const end = new RegExp(`^--- end rc=(\\d+) id=${marker}\\r?$`, "m").exec(body);
	if (!end) return undefined;
	const stdout = body.slice(0, end.index).replace(/\r?\n$/, "").trim();
	const code = Number.parseInt(end[1], 10);
	return { ok: code === 0, code, stdout, stderr: "" };
}
