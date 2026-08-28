const LOOPBACK_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1",
	"::ffff:7f00:1",
]);

function loopbackEndpoint(value) {
	const raw = String(value ?? "").trim();
	if (!raw) return null;
	try {
		const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
		const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		if (!LOOPBACK_HOSTS.has(hostname)) return null;
		return { protocol: url.protocol, port: url.port ? Number(url.port) : null };
	} catch {
		return null;
	}
}

function defaultPort(protocol) {
	return protocol === "https:" ? 443 : 80;
}

export function isLoopbackAddress(address) {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === "::ffff:7f00:1";
}
export function loopbackRequestAllowed(req) {
	return isLoopbackAddress(req?.socket?.remoteAddress ?? "") && originHostAllowed(req);
}
export function originHostAllowed(req) {
	const headers = req?.headers ?? {};
	const host = loopbackEndpoint(headers.host);
	if (!host) return false;
	const originRaw = String(headers.origin ?? "").trim();
	if (!originRaw) return true;
	const origin = loopbackEndpoint(originRaw);
	if (!origin) return false;
	const hostPort = host.port ?? (req?.socket?.encrypted ? 443 : 80);
	const originPort = origin.port ?? defaultPort(origin.protocol);
	return hostPort === originPort;
}
