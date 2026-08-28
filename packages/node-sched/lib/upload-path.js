export function parseUploadedPath(stdout, name) {
	const expected = `/${name}`;
	const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const path = lines.at(-1);
	if (!path || !path.startsWith("/") || !path.endsWith(expected)) {
		throw new Error(`upload did not return an absolute path for ${name}`);
	}
	return path;
}
