function isLoopbackHost(value) {
	const raw = String(value ?? "").trim();
	if (!raw) return true;
	try {
		const hostname = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "::ffff:127.0.0.1" || hostname === "::ffff:7f00:1";
	} catch {
		return false;
	}
}

export function isLoopbackAddress(address) {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function originHostAllowed(req) {
	const headers = req?.headers ?? {};
	return isLoopbackHost(headers.host) && isLoopbackHost(headers.origin);
}
