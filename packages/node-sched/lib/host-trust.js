import { createHash, randomUUID } from "node:crypto";
import { resolveHostRoute, trustedHostKeyRecords } from "./ssh-engine.js";

export const HOST_TRUST_CHALLENGE_TTL_MS = 60_000;
export const HOST_TRUST_MAX_CHALLENGES = 64;
export const HOST_TRUST_PROBE_RATE_WINDOW_MS = 60_000;
export const HOST_TRUST_PROBE_RATE_MAX = 8;

function trustError(code, message, status = 400) {
	const error = new Error(message);
	error.code = code;
	error.status = status;
	return error;
}

export function hostTrustPrincipalKey(principal) {
	if (!principal || typeof principal !== "object") {
		throw trustError("SSH_TRUST_UNAUTHORIZED", "authenticated browser principal is required", 401);
	}
	const kind = principal.kind === "session" ? "session" : "master";
	const clientId = kind === "session" ? String(principal.clientId ?? "") : "local-master";
	if (kind === "session" && !clientId) {
		throw trustError("SSH_TRUST_UNAUTHORIZED", "trusted browser client id is required", 401);
	}
	return `${kind}:${clientId}`;
}

export function hostTrustRouteSnapshot(store, targetAlias) {
	const target = store.find(targetAlias);
	if (!target) throw trustError("SSH_HOST_NOT_FOUND", `alias '${targetAlias}' not found`, 404);
	const route = resolveHostRoute(store, target);
	const snapshot = route.map((entry) => ({
		alias: entry.alias,
		host: entry.host,
		port: entry.port,
		user: entry.user,
		hostKeyAlias: entry.hostKeyAlias ?? null,
		proxyJump: entry.proxyJump ?? [],
		revision: entry.revision ?? 0,
		hostKeys: trustedHostKeyRecords(entry).map((record) => record.fingerprint).sort(),
	}));
	const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("base64url");
	return { digest, route, snapshot };
}

export function knownHostTrustRecords(keys, trustedAt = Date.now()) {
	if (!Array.isArray(keys)) return [];
	const seen = new Set();
	const records = [];
	for (const key of keys) {
		const fingerprint = String(key?.fingerprint ?? "").trim();
		if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint) || seen.has(fingerprint)) continue;
		seen.add(fingerprint);
		records.push({
			algorithm: String(key?.keyType ?? key?.algorithm ?? "").trim() || undefined,
			fingerprint,
			source: "known_hosts",
			trustedAt,
		});
	}
	return records;
}

export class HostTrustBroker {
	constructor({
		clock = { now: () => Date.now() },
		ttlMs = HOST_TRUST_CHALLENGE_TTL_MS,
		maxChallenges = HOST_TRUST_MAX_CHALLENGES,
		maxPerPrincipal = 8,
		probeRateWindowMs = HOST_TRUST_PROBE_RATE_WINDOW_MS,
		probeRateMax = HOST_TRUST_PROBE_RATE_MAX,
		maxActiveProbes = 8,
		maxActivePerPrincipal = 2,
	} = {}) {
		this.clock = clock;
		this.ttlMs = ttlMs;
		this.maxChallenges = maxChallenges;
		this.maxPerPrincipal = maxPerPrincipal;
		this.probeRateWindowMs = probeRateWindowMs;
		this.probeRateMax = probeRateMax;
		this.maxActiveProbes = maxActiveProbes;
		this.maxActivePerPrincipal = maxActivePerPrincipal;
		this.challenges = new Map();
		this.probeRates = new Map();
		this.activeProbes = 0;
		this.activeProbesByPrincipal = new Map();
		this.currentProbes = new Map();
	}

	#prune() {
		const now = this.clock.now();
		for (const [id, challenge] of this.challenges) {
			if (challenge.expiresAt <= now) this.challenges.delete(id);
		}
		for (const [principalKey, timestamps] of this.probeRates) {
			const recent = timestamps.filter((timestamp) => now - timestamp < this.probeRateWindowMs);
			if (recent.length > 0) this.probeRates.set(principalKey, recent);
			else this.probeRates.delete(principalKey);
		}
	}

	beginProbe({ principalKey, targetAlias, abort }) {
		this.#prune();
		if (
			typeof principalKey !== "string"
			|| principalKey.length === 0
			|| typeof targetAlias !== "string"
			|| targetAlias.length === 0
			|| typeof abort !== "function"
		) {
			throw trustError("SSH_TRUST_UNAUTHORIZED", "authenticated browser principal is required", 401);
		}

		// One browser can display only one trust confirmation. A newer prepare
		// supersedes the older operation before rate/cap accounting, and the old
		// generation is never allowed to publish a late challenge.
		const previous = this.currentProbes.get(principalKey);
		if (previous) {
			try { previous.abort(); } catch { /* best-effort cancellation */ }
			previous.finish();
		}
		this.cancelForPrincipal(principalKey);

		const recent = this.probeRates.get(principalKey) ?? [];
		if (recent.length >= this.probeRateMax) {
			throw trustError("SSH_TRUST_RATE_LIMITED", "host key probe rate limit exceeded", 429);
		}
		const activeForPrincipal = this.activeProbesByPrincipal.get(principalKey) ?? 0;
		if (
			this.activeProbes >= this.maxActiveProbes
			|| activeForPrincipal >= this.maxActivePerPrincipal
		) {
			throw trustError("SSH_TRUST_BUSY", "too many host key probes are already running", 429);
		}

		this.probeRates.set(principalKey, [...recent, this.clock.now()]);
		this.activeProbes += 1;
		this.activeProbesByPrincipal.set(principalKey, activeForPrincipal + 1);
		const generation = randomUUID();
		let released = false;
		const finish = () => {
			if (released) return;
			released = true;
			this.activeProbes = Math.max(0, this.activeProbes - 1);
			const remaining = (this.activeProbesByPrincipal.get(principalKey) ?? 1) - 1;
			if (remaining > 0) this.activeProbesByPrincipal.set(principalKey, remaining);
			else this.activeProbesByPrincipal.delete(principalKey);
			if (this.currentProbes.get(principalKey)?.generation === generation) {
				this.currentProbes.delete(principalKey);
			}
		};
		const operation = {
			generation,
			targetAlias,
			abort,
			finish,
			isCurrent: () => (
				!released
				&& this.currentProbes.get(principalKey)?.generation === generation
			),
		};
		this.currentProbes.set(principalKey, operation);
		return operation;
	}

	create({
		principalKey,
		targetAlias,
		targetRevision,
		alias,
		host,
		port,
		algorithm,
		fingerprint,
		routeDigest,
	}) {
		this.#prune();
		if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(String(fingerprint ?? ""))) {
			throw trustError("SSH_TRUST_INVALID_FINGERPRINT", "observed host key fingerprint is invalid");
		}
		if (!Number.isInteger(targetRevision) || targetRevision < 0) {
			throw trustError("SSH_TRUST_INVALID_REVISION", "target host revision is invalid");
		}
		for (const [id, challenge] of this.challenges) {
			if (challenge.principalKey === principalKey) {
				this.challenges.delete(id);
			}
		}
		const principalCount = [...this.challenges.values()]
			.filter((challenge) => challenge.principalKey === principalKey).length;
		if (this.challenges.size >= this.maxChallenges || principalCount >= this.maxPerPrincipal) {
			throw trustError("SSH_TRUST_BUSY", "too many pending host trust confirmations", 429);
		}
		const id = randomUUID();
		const challenge = {
			id,
			principalKey,
			targetAlias,
			targetRevision,
			alias,
			host,
			port,
			algorithm,
			fingerprint,
			routeDigest,
			createdAt: this.clock.now(),
			expiresAt: this.clock.now() + this.ttlMs,
		};
		this.challenges.set(id, challenge);
		return this.summarize(challenge);
	}

	consume(id, { principalKey, targetAlias, alias, fingerprint, routeDigest }) {
		this.#prune();
		const challenge = this.challenges.get(id);
		if (!challenge) throw trustError("SSH_TRUST_CHALLENGE_EXPIRED", "host trust confirmation expired or was already used", 410);
		this.challenges.delete(id);
		if (
			challenge.principalKey !== principalKey
			|| challenge.targetAlias !== targetAlias
			|| challenge.alias !== alias
		) {
			throw trustError("SSH_TRUST_CHALLENGE_MISMATCH", "host trust confirmation does not match this browser or host", 409);
		}
		if (challenge.routeDigest !== routeDigest) {
			throw trustError("SSH_TRUST_ROUTE_CHANGED", "SSH host or ProxyJump route changed after the probe", 409);
		}
		if (challenge.fingerprint !== fingerprint) {
			throw trustError("SSH_TRUST_FINGERPRINT_CHANGED", "confirmed fingerprint does not match the observed host key", 409);
		}
		return challenge;
	}

	cancel(id, principalKey) {
		this.#prune();
		const challenge = this.challenges.get(id);
		if (!challenge || challenge.principalKey !== principalKey) return false;
		this.challenges.delete(id);
		return true;
	}

	cancelForPrincipal(principalKey) {
		let cancelled = 0;
		for (const [id, challenge] of this.challenges) {
			if (challenge.principalKey !== principalKey) continue;
			this.challenges.delete(id);
			cancelled += 1;
		}
		return cancelled;
	}

	cancelProbe(principalKey, targetAlias) {
		const operation = this.currentProbes.get(principalKey);
		if (!operation || (targetAlias !== undefined && operation.targetAlias !== targetAlias)) {
			return false;
		}
		try { operation.abort(); } catch { /* best-effort cancellation */ }
		operation.finish();
		return true;
	}

	summarize(challenge) {
		return {
			id: challenge.id,
			expiresAt: challenge.expiresAt,
			targetRevision: challenge.targetRevision,
			target: {
				alias: challenge.alias,
				host: challenge.host,
				port: challenge.port,
			},
			observed: {
				algorithm: challenge.algorithm,
				fingerprint: challenge.fingerprint,
			},
			credentialsSentToObservedHost: false,
		};
	}

	dispose() {
		for (const operation of this.currentProbes.values()) {
			try { operation.abort(); } catch { /* best-effort cancellation */ }
			operation.finish();
		}
		this.challenges.clear();
		this.probeRates.clear();
		this.activeProbes = 0;
		this.activeProbesByPrincipal.clear();
		this.currentProbes.clear();
	}
}
