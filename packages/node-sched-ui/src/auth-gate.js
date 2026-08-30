import { validAccessToken } from "./ui-contracts.js";

export const AUTH_API = Object.freeze({
	challenge: "/sched/api/auth/challenge",
	verify: "/sched/api/auth/verify",
	pair: "/sched/api/auth/pair",
	session: "/sched/api/auth/session",
	forget: "/sched/api/auth/forget",
});

const SESSION_KEY = "node-sched:short-session";
const LEGACY_MASTER_TOKEN_KEY = "node-sched:access-token";
const DEVICE_RECORD_ID = "current";
const EXPIRY_SKEW_MS = 5_000;

export class AuthRequiredError extends Error {
	constructor(message = "node-sched authentication is required") {
		super(message);
		this.name = "AuthRequiredError";
	}
}

function bytesToBase64Url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw new Error("认证 challenge 格式无效");
	}
	const padded = value.replaceAll("-", "+").replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = globalThis.atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function expirationMillis(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 10_000_000_000 ? value * 1_000 : value;
	}
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return expirationMillis(numeric);
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return NaN;
}

async function responsePayload(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function responseMessage(response, payload, fallback) {
	const detail = payload?.error ?? payload?.message;
	if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 240);
	return `${fallback} (HTTP ${response.status})`;
}

function requestPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionPromise(transaction) {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
	});
}

function sameDeviceRecord(current, expected) {
	if (expected == null) return current == null;
	return Boolean(
		current
		&& current.clientId === expected.clientId
		&& current.writeId === expected.writeId
		&& current.createdAt === expected.createdAt
		&& Boolean(current.pending) === Boolean(expected.pending),
	);
}

function reusablePublicKey(record) {
	const key = record?.publicKeyJwk;
	return Boolean(
		key
		&& key.kty === "EC"
		&& key.crv === "P-256"
		&& /^[A-Za-z0-9_-]{43}$/u.test(key.x ?? "")
		&& /^[A-Za-z0-9_-]{43}$/u.test(key.y ?? ""),
	);
}

function pairFailureIsDefinitelyPrecommit(response, payload) {
	const status = Number(response?.status);
	if (status === 401 || status === 403 || status === 405) return true;
	if (status === 400 && ["invalid_json", "invalid_request"].includes(payload?.code)) return true;
	return status === 409 && payload?.code === "device_limit";
}

function previousTrustedRecord(record) {
	const seen = new Set();
	let previous = record?.previousRecord;
	let fallback = null;
	while (validTrustedRecord(previous) && !seen.has(previous) && seen.size < 16) {
		seen.add(previous);
		fallback = previous;
		previous = previous.previousRecord;
	}
	return fallback;
}

/** Store a non-exportable CryptoKey using IndexedDB structured cloning. */
export class IndexedDbTrustedDeviceStore {
	constructor(indexedDb = globalThis.indexedDB, {
		databaseName = "node-sched-auth",
		storeName = "trusted-device",
	} = {}) {
		this.indexedDb = indexedDb;
		this.databaseName = databaseName;
		this.storeName = storeName;
		this.available = Boolean(indexedDb?.open);
		this.openPromise = null;
	}

	async open() {
		if (!this.available) throw new Error("当前浏览器不支持 IndexedDB 设备信任");
		if (this.openPromise) return this.openPromise;
		this.openPromise = new Promise((resolve, reject) => {
			const request = this.indexedDb.open(this.databaseName, 1);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(this.storeName)) {
					database.createObjectStore(this.storeName, { keyPath: "id" });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("无法打开设备信任存储"));
			request.onblocked = () => reject(new Error("设备信任存储被其他页面阻塞"));
		}).catch((error) => {
			this.openPromise = null;
			throw error;
		});
		return this.openPromise;
	}

	async load() {
		const database = await this.open();
		const transaction = database.transaction(this.storeName, "readonly");
		return requestPromise(transaction.objectStore(this.storeName).get(DEVICE_RECORD_ID));
	}

	async save(record, options = {}) {
		const database = await this.open();
		const transaction = database.transaction(this.storeName, "readwrite");
		const store = transaction.objectStore(this.storeName);
		let written = false;
		if (Object.hasOwn(options, "expected")) {
			const request = store.get(DEVICE_RECORD_ID);
			request.onsuccess = () => {
				if (!sameDeviceRecord(request.result, options.expected)) return;
				store.put({ ...record, id: DEVICE_RECORD_ID });
				written = true;
			};
		} else {
			store.put({ ...record, id: DEVICE_RECORD_ID });
			written = true;
		}
		await transactionPromise(transaction);
		return written;
	}

	async clear(expectedClientId) {
		if (!this.available) return;
		const database = await this.open();
		const transaction = database.transaction(this.storeName, "readwrite");
		const store = transaction.objectStore(this.storeName);
		let removed = false;
		if (expectedClientId) {
			const request = store.get(DEVICE_RECORD_ID);
			request.onsuccess = () => {
				const matches = typeof expectedClientId === "string"
					? request.result?.clientId === expectedClientId
					: sameDeviceRecord(request.result, expectedClientId);
				if (matches) {
					store.delete(DEVICE_RECORD_ID);
					removed = true;
				}
			};
		} else {
			store.delete(DEVICE_RECORD_ID);
			removed = true;
		}
		await transactionPromise(transaction);
		return removed;
	}
}

function validTrustedRecord(record) {
	return Boolean(
		record
		&& typeof record.clientId === "string"
		&& /^[A-Za-z0-9_-]{16,128}$/u.test(record.clientId)
		&& record.privateKey
		&& record.privateKey.type === "private"
		&& record.privateKey.extractable === false
		&& record.privateKey.algorithm?.name === "ECDSA"
		&& record.privateKey.algorithm?.namedCurve === "P-256",
	);
}

export class BrowserAuthGate {
	constructor({
		fetchImpl = globalThis.fetch?.bind(globalThis),
		cryptoImpl = globalThis.crypto,
		sessionStorage = globalThis.sessionStorage,
		deviceStore = new IndexedDbTrustedDeviceStore(),
		now = () => Date.now(),
	} = {}) {
		if (typeof fetchImpl !== "function") throw new Error("fetch is required for node-sched authentication");
		this.fetchImpl = fetchImpl;
		this.crypto = cryptoImpl;
		this.sessionStorage = sessionStorage;
		this.deviceStore = deviceStore;
		this.now = now;
		this.listeners = new Set();
		this.credentialValue = null;
		this.trustedRecord = null;
		this.pending = null;
		this.operationId = 0;
		this.state = Object.freeze({
			status: "idle",
			message: "",
			canTrust: Boolean(deviceStore?.available),
			hasTrustedDevice: false,
			trusted: false,
			clientId: null,
			expiresAt: null,
		});
		// Never silently retain the old long-lived master credential.
		try { this.sessionStorage?.removeItem(LEGACY_MASTER_TOKEN_KEY); } catch { /* unavailable */ }
	}

	snapshot() { return this.state; }

	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	_publish(patch) {
		this.state = Object.freeze({ ...this.state, ...patch });
		for (const listener of [...this.listeners]) {
			try { listener(this.state); } catch { /* subscriber isolation */ }
		}
	}

	_readSession() {
		try {
			const raw = this.sessionStorage?.getItem(SESSION_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			const expiresAt = expirationMillis(parsed?.expiresAt);
			if (!validAccessToken(parsed?.accessToken) || !Number.isFinite(expiresAt)) return null;
			return { ...parsed, expiresAt };
		} catch {
			return null;
		}
	}

	_writeSession(session) {
		try { this.sessionStorage?.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* memory still works */ }
	}

	_clearSession(expectedToken) {
		try {
			if (expectedToken) {
				const current = this._readSession();
				if (current?.accessToken !== expectedToken) return;
			}
			this.sessionStorage?.removeItem(SESSION_KEY);
		} catch { /* unavailable */ }
	}

	_installCredential(payload, { trusted, clientId }) {
		const accessToken = payload?.accessToken;
		const expiresAt = expirationMillis(payload?.expiresAt);
		if (!validAccessToken(accessToken) || !Number.isFinite(expiresAt) || expiresAt <= this.now() + EXPIRY_SKEW_MS) {
			throw new Error("服务端返回的短期访问凭据无效");
		}
		const resolvedClientId = payload?.clientId ?? clientId ?? null;
		const credential = Object.freeze({ accessToken, expiresAt, generation: Symbol("credential") });
		this.credentialValue = credential;
		this._writeSession({ accessToken, expiresAt, clientId: resolvedClientId, trusted: Boolean(trusted) });
		this._publish({
			status: "ready",
			message: "",
			trusted: Boolean(trusted),
			clientId: resolvedClientId,
			expiresAt,
			hasTrustedDevice: Boolean(trusted || this.trustedRecord),
		});
		return credential;
	}

	requireCredential() {
		const credential = this.credentialValue;
		if (!credential || this.state.status !== "ready") throw new AuthRequiredError();
		if (credential.expiresAt <= this.now() + EXPIRY_SKEW_MS) {
			this.rejectCredential(credential, "短期访问凭据已过期，请重新验证。");
			throw new AuthRequiredError("node-sched session expired");
		}
		return credential;
	}

	isReady() {
		try { this.requireCredential(); return true; } catch { return false; }
	}

	rejectCredential(credential, message = "认证已失效，请重新验证当前设备。") {
		if (!credential || this.credentialValue !== credential) return false;
		this.credentialValue = null;
		this._clearSession(credential.accessToken);
		this._publish({
			status: "locked",
			message,
			trusted: false,
			expiresAt: null,
			hasTrustedDevice: Boolean(this.state.hasTrustedDevice || this.trustedRecord),
		});
		return true;
	}

	async authorizedFetch(input, init = {}) {
		const credential = this.requireCredential();
		const headers = new Headers(init.headers ?? {});
		headers.set("authorization", `Bearer ${credential.accessToken}`);
		const response = await this.fetchImpl(input, { ...init, headers });
		if (response.status === 401) this.rejectCredential(credential);
		return response;
	}

	webSocketProtocols() {
		const credential = this.requireCredential();
		return ["sched-auth", credential.accessToken];
	}

	_startOperation(status) {
		this.cancelPending();
		const operation = {
			id: ++this.operationId,
			controller: new AbortController(),
			promise: null,
		};
		this.pending = operation;
		this._publish({ status, message: "" });
		return operation;
	}

	_isCurrent(operation) {
		return this.pending === operation && this.operationId === operation.id;
	}

	_finishOperation(operation) {
		if (this.pending === operation) this.pending = null;
	}

	cancelPending() {
		const pending = this.pending;
		if (!pending) return false;
		this.pending = null;
		this.operationId += 1;
		pending.controller.abort();
		if (this.state.status !== "ready") this._publish({ status: "required", message: "" });
		return true;
	}

	async _postJson(path, body, { bearer, signal } = {}) {
		const headers = new Headers({ "content-type": "application/json" });
		if (bearer) headers.set("authorization", `Bearer ${bearer}`);
		const response = await this.fetchImpl(path, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		const payload = await responsePayload(response);
		return { response, payload };
	}

	async _loadTrustedRecord(operation) {
		const isCurrent = () => !operation || this._isCurrent(operation);
		if (!this.deviceStore?.available) {
			if (isCurrent()) this._publish({ canTrust: false, hasTrustedDevice: false });
			return null;
		}
		try {
			const record = await this.deviceStore.load();
			if (!isCurrent()) return null;
			if (!record) {
				this.trustedRecord = null;
				this._publish({ hasTrustedDevice: false });
				return null;
			}
			if (!validTrustedRecord(record)) {
				const removed = await this.deviceStore.clear(record);
				if (!isCurrent()) return null;
				if (!removed) {
					const replacement = await this._adoptCurrentDeviceRecord(operation);
					if (!isCurrent()) return null;
					if (replacement) {
						this._publish({ canTrust: true, hasTrustedDevice: true, clientId: replacement.clientId });
						return replacement;
					}
					throw new Error("设备记录已被其他页面更新，请重试");
				}
				this.trustedRecord = null;
				this._publish({ hasTrustedDevice: false });
				return null;
			}
			this.trustedRecord = record;
			this._publish({ canTrust: true, hasTrustedDevice: true, clientId: record.clientId });
			return record;
		} catch (error) {
			if (!isCurrent()) return null;
			this._publish({ canTrust: false, hasTrustedDevice: false });
			throw new Error(`无法读取受信设备：${error?.message ?? error}`);
		}
	}

	async _adoptCurrentDeviceRecord(operation) {
		const record = await this.deviceStore.load();
		if (!this._isCurrent(operation)) return false;
		this.trustedRecord = validTrustedRecord(record) ? record : null;
		return this.trustedRecord;
	}

	async _verifyTrustedRecord(record, operation) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (!this._isCurrent(operation)) return false;
			const challengeResult = await this._postJson(AUTH_API.challenge, {
				clientId: record.clientId,
			}, { signal: operation.controller.signal });
			if (!this._isCurrent(operation)) return false;
			if (!challengeResult.response.ok || !challengeResult.payload?.ok) {
				if (challengeResult.payload?.code === "unknown_client") {
					const removed = await this.deviceStore.clear(record);
					if (!this._isCurrent(operation)) return false;
					if (removed) this.trustedRecord = null;
					else await this._adoptCurrentDeviceRecord(operation);
					if (!this._isCurrent(operation)) return false;
				}
				throw new Error(responseMessage(challengeResult.response, challengeResult.payload, "受信设备 challenge 失败"));
			}
			const { challengeId, challenge } = challengeResult.payload;
			if (
				typeof challengeId !== "string"
				|| !challengeId
				|| typeof challenge !== "string"
				|| !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
			) {
				throw new Error("服务端返回的认证 challenge 无效");
			}
			const challengeBytes = base64UrlToBytes(challenge);
			if (challengeBytes.byteLength !== 32) throw new Error("服务端认证 challenge 必须为 32 字节");
			const signature = await this.crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				record.privateKey,
				challengeBytes,
			);
			if (!this._isCurrent(operation)) return false;
			const verifyResult = await this._postJson(AUTH_API.verify, {
				clientId: record.clientId,
				challengeId,
				signature: bytesToBase64Url(new Uint8Array(signature)),
			}, { signal: operation.controller.signal });
			if (!this._isCurrent(operation)) return false;
			if (!verifyResult.response.ok || !verifyResult.payload?.ok) {
				const code = verifyResult.payload?.code;
				if (code === "invalid_challenge" && attempt === 0 && this._isCurrent(operation)) continue;
				if (code === "invalid_signature" && record.pending === true && previousTrustedRecord(record)) {
					const previous = previousTrustedRecord(record);
					const restored = await this.deviceStore.save(previous, { expected: record });
					if (!this._isCurrent(operation)) return false;
					if (restored) this.trustedRecord = previous;
					else await this._adoptCurrentDeviceRecord(operation);
					if (!this._isCurrent(operation)) return false;
				} else if (code === "unknown_client" || code === "invalid_signature") {
					const removed = await this.deviceStore.clear(record);
					if (!this._isCurrent(operation)) return false;
					if (removed) this.trustedRecord = null;
					else await this._adoptCurrentDeviceRecord(operation);
					if (!this._isCurrent(operation)) return false;
				}
				throw new Error(responseMessage(verifyResult.response, verifyResult.payload, "受信设备验证失败"));
			}
			let finalizedRecord = record;
			if (record.pending === true) {
				const { previousRecord: _previousRecord, ...recordWithoutPrevious } = record;
				const candidate = { ...recordWithoutPrevious, pending: false };
				let saved = null;
				try {
					saved = await this.deviceStore.save(candidate, { expected: record });
				} catch { /* pending record remains recoverable */ }
				if (!this._isCurrent(operation)) return false;
				if (saved === false) {
					await this._adoptCurrentDeviceRecord(operation);
					if (!this._isCurrent(operation)) return false;
					throw new Error("设备记录已被其他页面更新，请重试");
				}
				if (saved === true) finalizedRecord = candidate;
			}
			if (!this._isCurrent(operation)) return false;
			this.trustedRecord = finalizedRecord;
			this._installCredential(verifyResult.payload, { trusted: true, clientId: record.clientId });
			return true;
		}
		return false;
	}

	async restore({ force = false } = {}) {
		if (!force && this.isReady()) return true;
		if (this.pending) return this.pending.promise;
		const operation = this._startOperation("restoring");
		operation.promise = (async () => {
			try {
				const session = this._readSession();
				if (!force && session && session.expiresAt > this.now() + EXPIRY_SKEW_MS) {
					if (session.trusted && this.deviceStore?.available) {
						try { await this._loadTrustedRecord(operation); } catch { /* valid short bearer still works */ }
					}
					if (!this._isCurrent(operation)) return false;
					this._installCredential(session, {
						trusted: Boolean(session.trusted),
						clientId: session.clientId ?? null,
					});
					return true;
				}
				this._clearSession();
				this.credentialValue = null;
				const record = await this._loadTrustedRecord(operation);
				if (!this._isCurrent(operation)) return false;
				if (!record) {
					this._publish({ status: "required", message: "", trusted: false, expiresAt: null });
					return false;
				}
				return await this._verifyTrustedRecord(record, operation);
			} catch (error) {
				if (!this._isCurrent(operation) || error?.name === "AbortError") return false;
				this.credentialValue = null;
				this._publish({
					status: "required",
					message: String(error?.message ?? error).slice(0, 240),
					trusted: false,
					expiresAt: null,
					hasTrustedDevice: Boolean(this.trustedRecord),
				});
				return false;
			} finally {
				this._finishOperation(operation);
			}
		})();
		return operation.promise;
	}

	async pair(masterToken, { remember = true, label = "浏览器", trustDays = 30 } = {}) {
		const master = String(masterToken ?? "").trim();
		if (!validAccessToken(master)) {
			this._publish({ status: "required", message: "本机主令牌格式无效" });
			throw new Error("本机主令牌格式无效");
		}
		const operation = this._startOperation("pairing");
		operation.promise = (async () => {
			try {
				if (!remember) {
					const result = await this._postJson(AUTH_API.session, {}, {
						bearer: master,
						signal: operation.controller.signal,
					});
					if (!this._isCurrent(operation)) return false;
					if (!result.response.ok || !result.payload?.ok) {
						throw new Error(responseMessage(result.response, result.payload, "创建临时会话失败"));
					}
					this._installCredential(result.payload, {
						trusted: false,
						clientId: result.payload.clientId ?? null,
					});
					return true;
				}

				if (!this.deviceStore?.available || !this.crypto?.subtle) {
					throw new Error("当前浏览器无法安全保存受信设备密钥，请选择仅本次会话");
				}

				let storedRecord;
				try {
					storedRecord = await this.deviceStore.load();
				} catch (error) {
					throw new Error(`无法读取受信设备私钥：${error?.message ?? error}`);
				}
				if (!this._isCurrent(operation)) return false;
				if (storedRecord && !validTrustedRecord(storedRecord)) {
					const removed = await this.deviceStore.clear(storedRecord);
					if (!this._isCurrent(operation)) return false;
					if (!removed) {
						await this._adoptCurrentDeviceRecord(operation);
						if (!this._isCurrent(operation)) return false;
						throw new Error("设备记录已被其他页面更新，请重试");
					}
					storedRecord = null;
				}

				let privateKey;
				let publicKeyJwk;
				if (storedRecord && reusablePublicKey(storedRecord)) {
					privateKey = storedRecord.privateKey;
					publicKeyJwk = storedRecord.publicKeyJwk;
				} else {
					const keyPair = await this.crypto.subtle.generateKey(
						{ name: "ECDSA", namedCurve: "P-256" },
						false,
						["sign", "verify"],
					);
					if (!this._isCurrent(operation)) return false;
					if (keyPair.privateKey.extractable !== false) throw new Error("浏览器未生成不可导出的设备私钥");
					publicKeyJwk = await this.crypto.subtle.exportKey("jwk", keyPair.publicKey);
					if (!this._isCurrent(operation)) return false;
					privateKey = keyPair.privateKey;
				}

				const clientId = storedRecord?.clientId ?? this.crypto.randomUUID();
				const writeId = this.crypto.randomUUID();
				const record = {
					clientId,
					privateKey,
					publicKeyJwk,
					label: String(label || "浏览器").trim().slice(0, 80) || "浏览器",
					createdAt: new Date(this.now()).toISOString(),
					writeId,
					pending: true,
				};
				if (storedRecord) {
					const earliest = previousTrustedRecord(storedRecord) ?? storedRecord;
					const { previousRecord: _nestedPrevious, ...stableRecord } = earliest;
					record.previousRecord = stableRecord;
				}
				try {
					const saved = await this.deviceStore.save(record, { expected: storedRecord ?? null });
					if (!this._isCurrent(operation)) {
						if (saved) {
							try {
								if (storedRecord) await this.deviceStore.save(storedRecord, { expected: record });
								else await this.deviceStore.clear(record);
							} catch { /* a later restore will resolve an uncommitted pending record */ }
						}
						return false;
					}
					if (!saved) {
						await this._adoptCurrentDeviceRecord(operation);
						if (!this._isCurrent(operation)) return false;
						throw new Error("设备记录已被其他页面更新，请重试");
					}
				} catch (error) {
					throw new Error(`无法保存受信设备私钥：${error?.message ?? error}`);
				}
				this.trustedRecord = record;
				const result = await this._postJson(AUTH_API.pair, {
					clientId,
					publicKeyJwk,
					label: record.label,
					trustDays,
				}, { bearer: master, signal: operation.controller.signal });
				if (!this._isCurrent(operation)) return false;
				if (!result.response.ok || !result.payload?.ok) {
					if (pairFailureIsDefinitelyPrecommit(result.response, result.payload)) {
						const reverted = storedRecord
							? await this.deviceStore.save(storedRecord, { expected: record })
							: await this.deviceStore.clear(record);
						if (!this._isCurrent(operation)) return false;
						if (!reverted) {
							await this._adoptCurrentDeviceRecord(operation);
							if (!this._isCurrent(operation)) return false;
							throw new Error("设备记录已被其他页面更新，请重试");
						}
						this.trustedRecord = storedRecord ?? null;
					}
					throw new Error(responseMessage(result.response, result.payload, "受信设备配对失败"));
				}
				const { previousRecord: _previousRecord, ...recordWithoutPrevious } = record;
				const finalizedRecord = { ...recordWithoutPrevious, pending: false };
				let finalizedSaved = null;
				try {
					finalizedSaved = await this.deviceStore.save(finalizedRecord, { expected: record });
				} catch {
					// The pending record already contains the key and is recoverable next open.
				}
				if (!this._isCurrent(operation)) return false;
				if (finalizedSaved === false) {
					await this._adoptCurrentDeviceRecord(operation);
					if (!this._isCurrent(operation)) return false;
					throw new Error("设备记录已被其他页面更新，请重试");
				}
				if (finalizedSaved === true) this.trustedRecord = finalizedRecord;
				this._installCredential(result.payload, { trusted: true, clientId });
				return true;
			} catch (error) {
				if (!this._isCurrent(operation) || error?.name === "AbortError") return false;
				this.credentialValue = null;
				this._publish({
					status: "required",
					message: String(error?.message ?? error).slice(0, 240),
					trusted: false,
					expiresAt: null,
					hasTrustedDevice: Boolean(this.trustedRecord),
				});
				throw error;
			} finally {
				this._finishOperation(operation);
			}
		})();
		return operation.promise;
	}

	async forget() {
		const credential = this.requireCredential();
		const trusted = this.state.trusted;
		const clientId = trusted ? (this.state.clientId ?? this.trustedRecord?.clientId ?? null) : null;
		if (clientId) {
			const result = await this._postJson(AUTH_API.forget, { clientId }, {
				bearer: credential.accessToken,
			});
			if (result.response.status === 401) this.rejectCredential(credential);
			if (!result.response.ok || !result.payload?.ok) {
				throw new Error(responseMessage(result.response, result.payload, "忘记设备失败"));
			}
		}
		if (trusted) {
			try { await this.deviceStore?.clear(clientId); } catch { /* server revocation already succeeded */ }
		}
		if (trusted) this.trustedRecord = null;
		if (this.credentialValue === credential) this.credentialValue = null;
		this._clearSession(credential.accessToken);
		this._publish({
			status: "required",
			message: trusted ? "当前设备已撤销。" : "本次会话已结束。",
			trusted: false,
			clientId: null,
			expiresAt: null,
			hasTrustedDevice: Boolean(this.trustedRecord),
		});
		return true;
	}

	dispose() {
		this.cancelPending();
		this.listeners.clear();
	}
}

export const authSessionStorageKey = SESSION_KEY;
