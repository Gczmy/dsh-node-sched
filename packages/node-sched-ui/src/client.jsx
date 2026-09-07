import { BrowserAuthGate, IndexedDbTrustedDeviceStore } from "./auth-gate.js";
import {
	authAnswerErrorText,
	authAudienceFrame,
	batchCancelRequest,
	buildAuthAnswer,
	collectHistoryPages,
	collectStatusPages,
	configuredProjectNames,
	createIndexedDbRequestStore,
	EnabledRequestEpoch,
	jobsForBatch,
	listenCaptured,
	mutationResultIsDefinitive,
	normalizeAuthPrompts,
	PollGate,
	reduceAuthQueue,
	reconcileSystemMasterNotice,
	schedulerMutationAvailability,
	submitExampleForProject,
	taskReference,
	taskStatusContract,
	validHostKey,
} from "./ui-contracts.js";

/**

 * node-sched dashboard — client plugin.

 *

 * Surfaces:

 *  - Sidebar nav entry row (plain DOM injection between New Session and the

 *    workspace browser; dual MutationObserver self-healing, task-board

 *    sidebar-entry-core pattern) toggling a full-page view that takes over

 *    the center column via its own React root (React never manages the

 *    injected container, so shell reconciliation cannot evict it).

 *  - `web-ui.plugin.item`: compact status card in Settings → Web UI 插件.

 *

 * Data: WS /sched/ws/events frames + fetch /sched/api/*.

 * Writes are all two-step confirmed in the UI; host side gates and audits.

 */

const ENTRY_ATTR = "data-dsh-sched-entry";

const VIEW_ATTR = "data-dsh-sched-view";

const ACTIVE_ATTR = "data-dsh-sched-active";

const PANEL_ACTIVATE_EVENT = "dsh-panel-activate";

const PANEL_NAME = "sched";

const SLOT_SETTINGS = "web-ui.plugin.item";

const NS = "nodesched";



const name = "@zzc/dsh-node-sched-ui";



const inject = ["slots"];



// 官方主题语义 token（跟随明暗主题）；statics 仅作补充色相。

const T = {

	brand: "var(--dsw-alias-brand-primary, #3b82f6)",

	ok: "var(--dsw-alias-state-success-primary, #22c55e)",

	warn: "var(--dsw-alias-state-warn-primary, #f59e0b)",

	err: "var(--dsw-alias-state-error-primary, #ef4444)",

	label: "var(--dsw-alias-label-primary, #1f2937)",

	label2: "var(--dsw-alias-label-secondary, #6b7280)",

	bgLayer: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",

	border: "var(--dsw-alias-border-l1)",

	border2: "var(--dsw-alias-border-l2)",

	font: "var(--dsw-font-family, ui-monospace, monospace)",

	onFill: "var(--dsw-alias-bg-base)", // 实底上的文字：明色主题→白、暗色主题→深

};

const COLORS = {

	done: T.ok, skip: T.ok, free: T.ok, active: T.ok,

	running: T.brand, assigned: "#3b82f6",

	blocked: T.err, releasing: T.warn,
	failed: T.err, timed_out: T.err, unmanaged: T.err,
	cancelled: T.err, interrupted: T.err,
	pending: T.label2, waiting_dep: T.warn, queued: T.label2,

};



// ── 样式注入（模块级一次）：侧栏入口行 + 中央列接管规则 ─────────────────

function injectStyles() {

	if (typeof document === "undefined") return;

	let el = document.getElementById("ns-ui-style");

	if (!el) {
		el = document.createElement("style");
		el.id = "ns-ui-style";
		document.head.appendChild(el);
	}

	el.textContent = [

		"/* --- center-column takeover (attribute-scoped) --- */",

		"[data-pane='conversation'], [class*='centerCol'] { position: relative; }",

		"[" + VIEW_ATTR + "] { position: absolute; inset: 0; display: none; z-index: 60; overflow-y: auto; background: var(--dsw-alias-bg-base); }",

		"html[" + ACTIVE_ATTR + "] [" + VIEW_ATTR + "] { display: block; }",

		// 中央列单占位：面板打开时隐藏对话内容（!important 压过外壳 inline display:contents）

		"html[" + ACTIVE_ATTR + "] [data-pane='conversation'] > :not([" + VIEW_ATTR + "]),",

		"html[" + ACTIVE_ATTR + "] [class*='centerCol'] > :not([" + VIEW_ATTR + "]) { display: none !important; }",

		"",

		"/* --- sidebar entry row --- */",

		".nsEntry { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; height: 36px; padding: 0 10px; background: transparent; border: none; border-radius: 8px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 13px; white-space: nowrap; transition: background-color 120ms ease, color 120ms ease; }",

		".nsEntry:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }",

		".nsEntry[data-active] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 600; }",

		".nsEntry[data-active]:hover { background: var(--dsw-specific-sidebar-nav-item-active); }",

		".nsEntryIcon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: none; }",

		".nsEntryIcon svg { display: block; width: 18px; height: 18px; }",

		".nsEntryLabel { overflow: hidden; text-overflow: ellipsis; }",

		"",

		"/* --- bounded vertical resize grip for multiline text panels --- */",

		".nsResizableTextBox { display: block; resize: vertical !important; overflow: auto !important; }",

		".nsResizableTextBox::-webkit-resizer { background: linear-gradient(135deg, transparent 0 35%, var(--dsw-alias-label-secondary, #6b7280) 35% 43%, transparent 43% 53%, var(--dsw-alias-label-secondary, #6b7280) 53% 61%, transparent 61% 71%, var(--dsw-alias-label-secondary, #6b7280) 71% 79%, transparent 79%) right bottom / 14px 14px no-repeat; }",

		"",

		"/* --- collapsed rail: icon-only --- */",

		"[data-sidebar-collapsed] .nsEntry { justify-content: center; padding: 0; width: 36px; height: 36px; margin: 0 auto 12px; border-radius: 50%; }",

		"[data-sidebar-collapsed] .nsEntryLabel { display: none; }",

	].join("\n");

}



// ── B23: SSH 看板 tab（复刻自 Apache-2.0 dsh-ssh 的 hosts+terminal 能力）──

let xtermCssInjected = false;

function injectXtermCss(cssText) {

	if (xtermCssInjected || typeof document === "undefined") return;

	const el = document.createElement("style");

	el.id = "ns-xterm-style";

	el.textContent = cssText;

	document.head.appendChild(el);

	xtermCssInjected = true;

}





function apply(cctx, config) {

	const { useEffect, useState, useCallback, useRef, memo } = require("react");



	if (typeof document !== "undefined" && !document.getElementById("ns-card-style")) {

		const st = document.createElement("style");

		st.id = "ns-card-style";

		st.textContent = [

			".ns-settings-card { transition: border-color .16s, background .16s; }",

			".ns-settings-card:hover { border-color: var(--dsw-alias-label-dimmed); }"

		].join("\n");

		document.head.appendChild(st);

	}



	// B19: 跨重挂载缓存 —— 上游(看板外壳/轮询)可能随时重建本 tab 的组件树,

	// 把数据与展开状态放模块级, 重挂载瞬间水合, 视觉零感知。

	let INC_CACHE = null;        // {list, frozenAt}

	let INC_OPEN_ID = null;      // 当前展开的 incident id

	let INC_DETAIL = null;       // {id -> incident} 已取详情缓存

	let INC_VIEW_GEN = 0;        // 详情请求代数 —— 收起后丢弃在途响应, 防竞态重展开

	const { jsx: _jsx } = require("react/jsx-runtime");

	const j = (tag, props, ...kids) => {

		const p = { ...(props ?? {}) };

		if (kids.length === 1) p.children = kids[0];

		else if (kids.length > 1) p.children = kids;

		return _jsx(tag, p);

	};

	const jsxs2 = j; // children-array variant shares the corrected semantics



	// ── styles ──────────────────────────────────────────────────────────────

	const pre = { margin: "4px 0", whiteSpace: "pre-wrap", background: T.bgLayer, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, fontSize: 13, color: T.label };

	// 柔和按钮：状态色 12% 底纹 + 同色文字，双主题自动柔和（不再用高饱和实底）

	const btn = (color = T.brand, disabled) => {

		if (disabled) {

			// 几何尺寸与 enabled 分支一致（radius/padding/fontSize），仅配色降级

			return { background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label2, borderRadius: 8, padding: "6px 14px", fontSize: 13, cursor: "default", marginRight: 4 };

		}

		return {

			background: `color-mix(in srgb, ${color} 12%, transparent)`,

			border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,

			color, borderRadius: 8, padding: "6px 14px", fontSize: 13,

			cursor: "pointer", marginRight: 4, transition: "background .15s",

		};

	};

	// web-ui ghostButton 对齐：13px 字号 + 8px 圆角 + hover 反馈

	const ghostBtn = {

		background: "var(--dsw-alias-interactive-bg-hover, transparent)", border: `1px solid ${T.border2}`,

		color: T.label, borderRadius: 8, padding: "6px 14px", fontSize: 13,

		cursor: "pointer", marginRight: 4, transition: "background-color 120ms ease",

	};

	const backBtn = { ...ghostBtn, display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500 };

	const boardTitleStyle = { margin: 0, fontSize: 16, fontWeight: 700, color: T.label, whiteSpace: "nowrap" };

		const badge = (s) => {

		const c = COLORS[s] ?? T.label2;

		return {

			background: `color-mix(in srgb, ${c} 13%, transparent)`,

			border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,

			color: c, borderRadius: 999, padding: "2px 9px", fontSize: 13, marginRight: 6,

		};

	};

	// 页面视图：填满接管容器（不再是 fixed 弹窗；显隐由 html data 属性驱动）

	const overlayStyle = {

		position: "absolute", inset: 0, zIndex: 60,

		display: "flex", flexDirection: "column", boxSizing: "border-box",

		padding: "14px 16px 16px", gap: 8,

		background: "var(--dsw-alias-bg-base)", overflowY: "auto",

		color: T.label, fontFamily: T.font, fontSize: 13, lineHeight: 1.55,

	};

	const panelStyle = {

		flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 8,

		maxWidth: 1280, width: "100%", margin: "0 auto",

		color: T.label, fontFamily: T.font, fontSize: 13, lineHeight: 1.55,

	};

	const bar = (pct) => ({ height: 6, background: "rgba(127,127,127,.2)", borderRadius: 3, overflow: "hidden", flex: 1, margin: "0 8px", display: "flex" });

	const barFill = (pct) => ({ height: "100%", width: `${Math.max(0, Math.min(100, pct))}%`, background: T.brand });
	const resizeHint = "拖动右下角斜线调整高度";

	function ResizableTextBox({
		as = "pre",
		className,
		style,
		minHeight = 96,
		maxHeight = "min(70vh, 640px)",
		initialHeight,
		title = resizeHint,
		children,
		...props
	}) {
		return j(as, {
			...props,
			className: [className, "nsResizableTextBox"].filter(Boolean).join(" "),
			title,
			style: {
				width: "100%",
				boxSizing: "border-box",
				...style,
				minHeight,
				maxHeight,
				height: initialHeight ?? style?.height,
				resize: "vertical",
				overflow: "auto",
			},
		}, children);
	}



		const Badge = ({ s }) => j("span", { style: badge(s) }, s);

	const durableRequests = createIndexedDbRequestStore();
	const authGate = new BrowserAuthGate({
		fetchImpl: globalThis.fetch.bind(globalThis),
		cryptoImpl: globalThis.crypto,
		sessionStorage: globalThis.sessionStorage,
		deviceStore: new IndexedDbTrustedDeviceStore(globalThis.indexedDB),
	});

	async function authFetch(input, init = {}) {
		return authGate.authorizedFetch(input, init);
	}

	function authenticatedWebSocket(url) {
		return new WebSocket(url, authGate.webSocketProtocols());
	}

	function useAuthGateState() {
		const [state, setState] = useState(authGate.snapshot());
		useEffect(() => authGate.subscribe(setState), []);
		return state;
	}

	async function mutationPayloadKey(action, payload) {
		const bytes = new TextEncoder().encode(String(payload));
		const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
		const hash = [...new Uint8Array(digest)]
			.map((value) => value.toString(16).padStart(2, "0"))
			.join("");
		return `${action}:${hash}`;
	}




	async function post(action, body) {
		const r = await authFetch(`/sched/api/${action}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const text = await r.text();
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new Error(`HTTP ${r.status}: ${text.slice(0, 160) || "non-JSON response"}`);
		}
		if (!r.ok && payload && typeof payload === "object" && payload.ok === undefined) {
			payload.ok = false;
		}
		return payload;
	}

	async function getText(action, params = "") {

		const r = await authFetch(`/sched/api/${action}${params}`);

		return r.text();

	}



	function ArmButton({ label, confirmLabel, color, onConfirm, stopProp }) {
		const [armed, setArmed] = useState(false);
		const [busy, setBusy] = useState(false);
		const guard = (e) => { if (stopProp) e.stopPropagation(); };
		if (!armed) return j("button", { onClick: (e) => { guard(e); setArmed(true); }, style: btn(color) }, label);
		const confirm = async (e) => {
			guard(e);
			if (busy) return;
			setBusy(true);
			try {
				await onConfirm();
			} finally {
				setBusy(false);
				setArmed(false);
			}
		};
		return j("button", {
			disabled: busy,
			onClick: confirm,
			style: btn(color, busy),
		}, busy ? "处理中…" : confirmLabel ?? `${label}?`);
	}



	function TypedConfirm({ placeholder, color, onConfirm, children }) {

		const [typed, setTyped] = useState("");

		return j("span", {}, [

			j("input", { placeholder, value: typed, onChange: (e) => setTyped(e.target.value), style: { fontSize: 13, width: 150, marginRight: 4 } }),

			j("button", { disabled: typed !== placeholder, onClick: async () => { await onConfirm(); setTyped(""); }, style: btn(color, typed !== placeholder) }, children),

			j("button", { onClick: () => setTyped(""), style: ghostBtn }, "×"),

		]);

	}



	function useSchedStream(visible) {

		const [state, setState] = useState({ lines: [], connected: false, authQueue: [] });
		const socketRef = useRef(null);
		const visibleRef = useRef(Boolean(visible));
		visibleRef.current = Boolean(visible);

		useEffect(() => {
			let ws; let closed = false; let timer;

			const connect = () => {
				if (closed || !authGate.isReady()) return;
				const proto = location.protocol === "https:" ? "wss://" : "ws://";
				try {
					ws = authenticatedWebSocket(`${proto}${location.host}/sched/ws/events`);
				} catch (error) {
					setState((current) => ({
						...current,
						connected: false,
						lines: [...current.lines.slice(-400), String(error?.message ?? error)],
					}));
					return;
				}
				socketRef.current = ws;
				ws.onopen = () => {
					if (closed) return;
					setState((s) => ({ ...s, connected: true }));
					ws.send(JSON.stringify(authAudienceFrame(visibleRef.current)));
				};
				ws.onmessage = (e) => {
					if (closed) return;
					let m;
					try { m = JSON.parse(e.data); } catch { return; }
					if (!m || typeof m !== "object") return;
					if (m.type === "log") setState((s) => ({ ...s, lines: [...s.lines.slice(-400), m.line] }));
					else if (m.type === "auth" || m.type === "auth-snapshot") setState((s) => ({
						...s,
						authQueue: reduceAuthQueue(s.authQueue, m),
					}));
				};
				ws.onclose = () => {
					if (socketRef.current === ws) socketRef.current = null;
					if (closed || !authGate.isReady()) return;
					setState((s) => ({ ...s, connected: false, authQueue: [] }));
					timer = setTimeout(connect, 3000);
				};
			};

			connect();

			return () => {
				closed = true;
				clearTimeout(timer);
				if (socketRef.current === ws) socketRef.current = null;
				ws?.close();
			};

		}, []);

		useEffect(() => {
			const ws = socketRef.current;
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(authAudienceFrame(visible)));
			}
		}, [visible]);

		const clearAuth = useCallback((id) => {
			setState((s) => ({ ...s, authQueue: (s.authQueue ?? []).filter((req) => req.id !== id) }));
		}, []);

		return [state, clearAuth];
	}



	function useSnapshot(path, ms, enabled = true) {
		const gateRef = useRef(null);
		if (gateRef.current === null) {
			gateRef.current = new PollGate({ ttlMs: Math.max(ms * 2, 30_000) });
		}
		const inFlightRef = useRef(null);
		const requestEpochRef = useRef(null);
		if (requestEpochRef.current === null) requestEpochRef.current = new EnabledRequestEpoch(enabled);
		if (requestEpochRef.current.setEnabled(enabled)) {
			inFlightRef.current = null;
		}
		const [data, setData] = useState(null);

		const refresh = useCallback(() => {
			if (!enabled) return Promise.resolve();
			const generation = requestEpochRef.current.issue();
			if (inFlightRef.current?.generation === generation) return inFlightRef.current.promise;
			const gate = gateRef.current;
			const sequence = gate.issue();
			let firstEnvelope;
			const entry = { generation, promise: null };
			const isCurrent = () => requestEpochRef.current.isCurrent(generation);
			entry.promise = collectStatusPages(async ({ cursor, jobCursor }) => {
				if (!isCurrent()) throw new Error("status request superseded");
				const query = new URLSearchParams();
				if (cursor !== null) query.set("cursor", cursor);
				if (jobCursor !== null) query.set("job_cursor", jobCursor);
				const suffix = query.size > 0 ? `?${query}` : "";
				const response = await authFetch(`${path}${suffix}`);
				const envelope = await response.json();
				if (!response.ok || !envelope?.ok || !envelope.raw) {
					throw new Error(envelope?.text || envelope?.lastError || `status HTTP ${response.status}`);
				}
				firstEnvelope ??= envelope;
				return envelope.raw;
			}).then((raw) => {
				if (isCurrent()) gate.succeed(sequence, {
					...firstEnvelope,
					ok: true,
					fresh: true,
					stale: false,
					raw,
				});
			}, (error) => {
				if (isCurrent()) gate.fail(sequence, error);
			}).finally(() => {
				if (inFlightRef.current === entry) inFlightRef.current = null;
				if (isCurrent()) setData(gate.snapshot());
			});
			inFlightRef.current = entry;
			return entry.promise;
		}, [enabled, path]);

		useEffect(() => {
			if (!enabled) {
				setData(null);
				return undefined;
			}
			let alive = true;
			const update = () => { void refresh(); };
			update();
			const pollTimer = setInterval(update, ms);
			const ttlTimer = setInterval(() => {
				if (alive) setData(gateRef.current.snapshot());
			}, Math.min(ms, 5_000));
			return () => {
				alive = false;
				requestEpochRef.current.invalidate();
				inFlightRef.current = null;
				clearInterval(pollTimer);
				clearInterval(ttlTimer);
			};
		}, [enabled, ms, refresh]);

		return [data, refresh];
	}



	function parseProgress(p) {

		const m = /^(\d+)\/(\d+)$/.exec(String(p ?? ""));

		return m ? { done: +m[1], total: +m[2] } : null;

	}



	function ProgressBar({ p }) {

		const pp = parseProgress(p);

		if (!pp || pp.total === 0) return null;

		return jsxs2("span", { style: { display: "inline-flex", alignItems: "center", flex: 1 } }, [

			j("span", { style: bar() }, j("span", { style: barFill((pp.done / pp.total) * 100) })),

			j("span", { style: { fontSize: 12, color: T.label2 } }, p),

		]);

	}



	function LogViewer({ taskId, onClose }) {

		const [text, setText] = useState("loading…");

		useEffect(() => {

			let alive = true;

			const load = () => getText("log", `?task=${encodeURIComponent(taskId)}&lines=400`).then((t) => { if (alive) setText(t || "(empty log)"); }).catch((e) => { if (alive) setText(String(e)); });

			load();

			const t = setInterval(load, 5000);

			return () => { alive = false; clearInterval(t); };

		}, [taskId]);

		return jsxs2("div", { style: { position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center" } }, [

			jsxs2("div", { style: { ...panelStyle, width: "min(860px, 92vw)" }, onClick: (e) => e.stopPropagation() }, [

				jsxs2("div", { style: { display: "flex", alignItems: "center", marginBottom: 6 } }, [

					j("b", null, `log: ${taskId}`),

					j("span", { style: { flex: 1 } }),

					j("button", { onClick: onClose, style: ghostBtn }, "×"),

				]),

				j(ResizableTextBox, {
					minHeight: 160,
					maxHeight: "70vh",
					initialHeight: "min(60vh, 480px)",
					style: pre,
				}, text),

			]),

		]);

	}



	// ── B23 组件：依赖 apply 作用域的 j/hooks/T/btn ──

	function authPromptMethodLabel(req) {
		return req?.method === "private-key-passphrase"
			? "私钥口令"
			: req?.method === "keyboard-interactive" ? "交互式身份验证" : String(req?.method || "身份验证");
	}

	function sshMasterErrorText(error, fallback = "未检测到已认证的 OpenSSH ControlMaster 主连接") {
		if (!error) return fallback;
		if (typeof error === "string") return error;
		return String(error.message || error.code || fallback);
	}

	function AuthPromptBanner({ req, pendingCount, onOpen }) {
		if (!req) return null;
		const methodLabel = authPromptMethodLabel(req);
		return jsxs2("section", {
			"aria-label": "SSH 验证请求",
			style: {
				display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
				padding: "10px 12px", border: `1px solid ${T.warn}`, borderRadius: 10,
				background: `color-mix(in srgb, ${T.warn} 8%, transparent)`,
			},
		}, [
			jsxs2("div", { style: { flex: "1 1 320px", minWidth: 0 } }, [
				jsxs2("div", { style: { display: "flex", gap: 7, alignItems: "baseline", flexWrap: "wrap" } }, [
					j("b", null, `SSH ${methodLabel}等待输入`),
					req.alias && j("span", { style: { color: T.brand, fontWeight: 700, overflowWrap: "anywhere" } }, req.alias),
					pendingCount > 1 && j("span", { style: { color: T.label2 } }, `另有 ${pendingCount - 1} 个请求`),
				]),
				j("div", { role: "status", "aria-live": "polite", style: { color: T.label2, marginTop: 2 } },
					"验证请求不会自动弹窗；点击按钮后再填写，180 秒未处理将自动取消连接。"),
			]),
			j("button", { type: "button", onClick: onOpen, style: btn(T.warn) }, "打开验证"),
		]);
	}

	// B24c: SSH 交互式身份认证弹窗 —— 仅由横幅按钮显式打开，将完整质询逐项回传引擎
	function AuthPromptModal({ req, onDone }) {
		const [answers, setAnswers] = useState([]);
		const [busy, setBusy] = useState(false);
		const [errorText, setErrorText] = useState("");
		const [dismissedId, setDismissedId] = useState(null);
		const prompts = normalizeAuthPrompts(req);

		useEffect(() => {
			setAnswers(prompts.map(() => ""));
			setBusy(false);
			setErrorText("");
		}, [req?.id]);

		if (!req || dismissedId === req.id) return null;

		const sendAnswer = async (answer) => {
			if (busy) return;
			setBusy(true);
			setErrorText("");
			try {
				const response = await authFetch("/sched/ssh/auth-answer", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: req.id, answer }),
				});
				const responseText = await response.text();
				let body = {};
				if (responseText) {
					try { body = JSON.parse(responseText); } catch { body = responseText; }
				}
				if (!response.ok) {
					setErrorText(authAnswerErrorText({
						status: response.status,
						statusText: response.statusText,
						body,
					}));
					setBusy(false);
					return;
				}
				setDismissedId(req.id);
				onDone?.(req.id);
			} catch (cause) {
				setErrorText(authAnswerErrorText({ cause }));
				setBusy(false);
			}
		};

		const submit = async () => {
			if (busy) return;
			await sendAnswer(buildAuthAnswer(prompts, answers));
		};

		const cancel = async () => {
			await sendAnswer({ kind: "cancel" });
		};

		const setAnswer = (index, value) => {
			setAnswers((current) => current.map((answer, i2) => i2 === index ? value : answer));
		};
		const methodLabel = authPromptMethodLabel(req);
		const instructions = req.instructions || req.instr;

		return j("div", { style: {
			position: "fixed", inset: 0, zIndex: 11000,
			background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center",
			padding: 12, boxSizing: "border-box",
		} }, [
			jsxs2("div", { style: {
				background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))",
				border: `1px solid ${T.border2}`, borderRadius: 12, padding: 18,
				width: "min(480px, 100%)", maxHeight: "90vh", overflowY: "auto",
				display: "flex", flexDirection: "column", gap: 10,
				boxShadow: "0 18px 60px rgba(0,0,0,.45)", color: T.label, fontFamily: T.font,
				boxSizing: "border-box", minWidth: 0,
			} }, [
				jsxs2("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", minWidth: 0 } }, [
					j("b", { style: { fontSize: 14 } }, `SSH ${methodLabel}`),
					req.alias && j("span", { style: { color: T.brand, fontWeight: 700, fontSize: 13, overflowWrap: "anywhere" } }, req.alias),
				]),
				req.name && j("div", { style: { fontSize: 12, color: T.label2, overflowWrap: "anywhere" } }, req.name),
				instructions && j("div", { style: { fontSize: 13, color: T.label2, whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, instructions),
				...prompts.map((prompt, index) => jsxs2("label", {
					key: prompt.id ?? index,
					style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
				}, [
					j("span", { style: { fontSize: 13, color: T.label2, overflowWrap: "anywhere" } },
						prompt.prompt || `Authentication response ${index + 1}`),
					j("input", {
						autoFocus: index === 0,
						type: prompt.echo ? "text" : "password",
						autoComplete: "off",
						value: answers[index] ?? "",
						onChange: (e) => setAnswer(index, e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") submit(); },
						style: {
							width: "100%", boxSizing: "border-box", padding: "7px 10px", fontSize: 14, fontFamily: T.font,
							border: `1px solid ${T.border2}`, borderRadius: 8, outline: "none",
							color: T.label, background: "var(--dsw-alias-bg-base)",
						},
					}),
				])),
				jsxs2("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } }, [
					j("button", { onClick: submit, disabled: busy, style: btn(T.ok, busy) },
						busy ? "\u63d0\u4ea4\u4e2d\u2026" : "\u786e\u8ba4"),
					j("button", { onClick: cancel, disabled: busy, title: "放弃本次连接", style: { ...ghostBtn, flexShrink: 0 } }, "\u53d6\u6d88"),
				]),
				errorText && j("div", { role: "alert", style: { fontSize: 13, color: T.err, overflowWrap: "anywhere" } }, errorText),
				j("div", { style: { fontSize: 13, color: T.label2, overflowWrap: "anywhere" } }, "180 秒内未提交将自动放弃本次连接"),
			]),
		]);
	}



	function SshTab() {

		const [hosts, setHosts] = useState(null);

		const [busy, setBusy] = useState("");

		const [msg, setMsg] = useState("");
		const [systemMasterNotice, setSystemMasterNotice] = useState(null);

		const [confirmAlias, setConfirmAlias] = useState(null);
		const [pinDraft, setPinDraft] = useState(null);
		const [trustDraft, setTrustDraft] = useState(null);
		const trustAbortRef = useRef(null);
		const trustEpochRef = useRef(0);
		const trustCommitRef = useRef(false);

		const [termTarget, setTermTarget] = useState(null); // {alias, transport: engine|system-openssh}



		const [binding, setBinding] = useState(null); // {alias, mode, sshEntry, master?}

		const load = useCallback(async () => {

			try {

				const [h, b] = await Promise.all([

					authFetch("/sched/ssh/hosts").then((r) => r.json()),

					authFetch("/sched/ssh/binding").then((r) => r.json()),

				]);

				const nextHosts = h.hosts ?? [];
				setHosts(nextHosts);

				setBinding(b);
				setSystemMasterNotice((current) => reconcileSystemMasterNotice(
					current,
					b,
					sshMasterErrorText(b?.master?.error),
				));
				return { hosts: nextHosts, binding: b };

			} catch { setHosts([]); return { hosts: [], binding: null }; }

		}, []);

		useEffect(() => { load(); }, [load]);
		useEffect(() => {
			if (binding?.mode !== "system-openssh") return undefined;
			const timer = setInterval(load, 30_000);
			return () => clearInterval(timer);
		}, [binding?.mode, binding?.sshEntry, load]);
		useEffect(() => () => {
			trustEpochRef.current += 1;
			trustAbortRef.current?.abort();
		}, []);



		// B24: 绑定/解绑 sched 主机（诚实反馈：主机必须可达；daemon 状态仅提示）

		const doBind = async (alias) => {

			setBusy("bind:" + alias);

			try {

				const r = await authFetch("/sched/ssh/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias }) }).then((r) => r.json());

				if (r.ok) {
					setSystemMasterNotice(null);
					setMsg(`✅ ${alias} 已设为 SCHED 主机 (${r.latencyMs}ms) · daemon: ${r.probeText || "?"}`);
				}

				else setMsg(`绑定失败: ${r.error}`);

				await load();

			} catch (e) { setMsg("绑定失败: " + e.message); }

			setBusy("");

		};

		const doUnbind = async () => {

			setBusy("unbind");

			try {

				const response = await authFetch("/sched/ssh/unbind", { method: "POST" });
				const result = await response.json().catch(() => ({}));
				if (!response.ok || result.ok === false) {
					throw new Error(sshMasterErrorText(result.error, `HTTP ${response.status}`));
				}

				setSystemMasterNotice(null);
				setMsg(`已解绑内置引擎；当前改用系统 OpenSSH (sshEntry: ${result.sshEntry ?? binding?.sshEntry ?? "?"})`);

				await load();

			} catch (e) { setMsg("解绑失败: " + e.message); }

			setBusy("");

		};

		const doUseSystemOpenSsh = async (requestedEntry = binding?.sshEntry) => {
			const sshEntry = String(requestedEntry ?? "").trim();
			if (!sshEntry) {
				setMsg("启用系统 OpenSSH 失败: 缺少 sshEntry");
				return;
			}
			setBusy("use-system:" + sshEntry);
			setMsg("");
			try {
				const response = await authFetch("/sched/ssh/use-system", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sshEntry }),
				});
				const result = await response.json().catch(() => ({}));
				if (!response.ok || result.ok === false) {
					if (result.code === "no_control_master" || result.error?.code === "no_control_master") {
						setSystemMasterNotice({
							source: "candidate",
							sshEntry,
							error: sshMasterErrorText(result.error),
						});
						return;
					}
					throw new Error(sshMasterErrorText(result.error, `HTTP ${response.status}`));
				}
				setBinding(result.binding ?? result);
				setSystemMasterNotice(null);
				setMsg(`✅ 已通过系统 OpenSSH 复用 ${sshEntry} 的终端 ControlMaster；dsh 不会索取或保存 2FA 验证码`);
				await load();
			} catch (error) {
				setMsg("启用系统 OpenSSH 失败: " + error.message);
			} finally {
				setBusy("");
			}
		};



		const doImport = async () => {

			setBusy("import");

			try {

				const r = await authFetch("/sched/ssh/import", { method: "POST" }).then((r) => r.json());

				setMsg(r.result
					? `导入完成: 解析 ${r.result.parsed} / 新增 ${r.result.added} / 自动信任 ${r.result.pinned ?? 0} / 待确认 ${r.result.pending ?? 0} / 冲突 ${(r.result.conflicts ?? []).length}`
					: `失败: ${r.error}`);

				await load();

			} catch (e) { setMsg("失败: " + e.message); }

			setBusy("");

		};

		const doTest = async (alias) => {

			setBusy("test:" + alias);

			try {

				const r = await authFetch("/sched/ssh/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias }) }).then((r) => r.json());

				setMsg(r.ok ? `${alias}: ok (${r.latencyMs}ms)` : `${alias}: 失败 — ${r.error ?? "unreachable"}`);

			} catch (e) { setMsg("失败: " + e.message); }

			setBusy("");

		};

		const testAfterTrust = async (alias) => {
			try {
				const result = await authFetch("/sched/ssh/test", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ alias }),
				}).then((response) => response.json());
				setMsg(result.ok
					? `✅ ${alias} 已建立信任并通过 SSH 测试 (${result.latencyMs}ms)`
					: `✅ ${alias} 的服务器身份已信任；但用户认证或连通性测试失败 — ${result.error ?? "unreachable"}`);
			} catch (error) {
				setMsg(`✅ ${alias} 的服务器身份已信任；但用户认证或连通性测试失败 — ${error.message}`);
			}
		};

		const cancelTrust = async () => {
			if (trustCommitRef.current) return;
			const current = trustDraft;
			trustEpochRef.current += 1;
			trustAbortRef.current?.abort();
			trustAbortRef.current = null;
			setTrustDraft(null);
			setBusy("trust-cancel");
			setMsg("已取消主机信任操作；未确认的指纹不会保存");
			if (current?.targetAlias) {
				try {
					await authFetch("/sched/ssh/host-key", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "cancel",
							targetAlias: current.targetAlias,
							challengeId: current.challenge?.id,
						}),
					});
				} catch { /* challenge also expires automatically */ }
			}
			setBusy("");
		};

		const prepareTrust = async (targetAlias, options = {}) => {
			trustAbortRef.current?.abort();
			const controller = new AbortController();
			trustAbortRef.current = controller;
			const epoch = ++trustEpochRef.current;
			const host = (hosts ?? []).find((candidate) => candidate.alias === targetAlias);
			setTrustDraft({ phase: "probing", targetAlias, mode: options.mode ?? "initial" });
			setBusy("trust:" + targetAlias);
			setMsg(options.mode === "rotate"
				? `正在重新探测 ${options.hostAlias ?? targetAlias} 的服务器身份…`
				: `正在检查本机 known_hosts；如无记录，将安全探测 ${targetAlias}…`);
			try {
				const response = await authFetch("/sched/ssh/host-key", {
					method: "POST",
					headers: { "content-type": "application/json" },
					signal: controller.signal,
					body: JSON.stringify({
						action: "prepare",
						targetAlias,
						expectedHostRevision: options.expectedHostRevision ?? host?.revision,
						mode: options.mode ?? "initial",
						hostAlias: options.hostAlias,
					}),
				});
				const result = await response.json().catch(() => ({}));
				if (epoch !== trustEpochRef.current) return;
				if (!response.ok || result.ok !== true) {
					throw new Error(result.error ?? `HTTP ${response.status}`);
				}
				if (["trusted_from_known_hosts", "already_trusted", "trusted"].includes(result.state)) {
					setTrustDraft(null);
					await load();
					await testAfterTrust(targetAlias);
					return;
				}
				if (result.state !== "confirmation_required" || !result.challenge) {
					throw new Error("服务器返回了未知的主机信任状态");
				}
				setTrustDraft({
					phase: "confirm",
					targetAlias,
					mode: options.mode ?? "initial",
					challenge: result.challenge,
				});
				setMsg((result.warnings ?? []).length > 0
					? `known_hosts 存在不可安全复用的记录；请人工核对 ${result.challenge.target.alias} 的服务器指纹`
					: `请核对 ${result.challenge.target.alias} 的服务器指纹`);
			} catch (error) {
				if (epoch !== trustEpochRef.current || error?.name === "AbortError") return;
				setTrustDraft(null);
				setMsg("建立信任失败: " + error.message);
			} finally {
				if (epoch === trustEpochRef.current) {
					setBusy("");
					trustAbortRef.current = null;
				}
			}
		};

		const confirmTrust = async () => {
			const current = trustDraft;
			if (current?.phase !== "confirm" || trustCommitRef.current) return;
			trustCommitRef.current = true;
			const epoch = ++trustEpochRef.current;
			setBusy("trust-confirm:" + current.targetAlias);
			try {
				const response = await authFetch("/sched/ssh/host-key", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action: "confirm",
						targetAlias: current.targetAlias,
						hostAlias: current.challenge.target.alias,
						challengeId: current.challenge.id,
						fingerprint: current.challenge.observed.fingerprint,
						expectedHostRevision: current.challenge.targetRevision,
					}),
				});
				const result = await response.json().catch(() => ({}));
				if (epoch !== trustEpochRef.current) return;
				if (!response.ok || result.ok !== true) {
					throw new Error(result.error ?? `HTTP ${response.status}`);
				}
				setTrustDraft(null);
				const loaded = await load();
				if (result.state === "next_required") {
					setMsg(`${current.challenge.target.alias} 已信任，继续处理下一段 SSH 路径…`);
					const refreshedTarget = loaded.hosts.find((candidate) => candidate.alias === current.targetAlias);
					await prepareTrust(current.targetAlias, { expectedHostRevision: refreshedTarget?.revision });
					return;
				}
				await testAfterTrust(current.targetAlias);
			} catch (error) {
				if (epoch !== trustEpochRef.current) return;
				setTrustDraft(null);
				setMsg("确认主机信任失败，请重新建立信任: " + error.message);
			} finally {
				trustCommitRef.current = false;
				if (epoch === trustEpochRef.current) setBusy("");
			}
		};

		const doDelete = async (alias) => {
			setBusy("del:" + alias);
			try {
				const response = await authFetch("/sched/ssh/hosts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action: "delete",
						alias,
						expectedHostRevision: (hosts ?? []).find((host) => host.alias === alias)?.revision,
					}),
				});
				const result = await response.json().catch(() => ({}));
				if (!response.ok || result.removed === false) {
					setMsg(`失败: ${result.error ?? `HTTP ${response.status}`}`);
					return;
				}
				setConfirmAlias(null);
				await load();
			} catch (e) {
				setMsg("失败: " + e.message);
			} finally {
				setBusy("");
			}
		};

		const doPin = async () => {
			if (!pinDraft) return;
			const hostKey = pinDraft.value.trim();
			if (!validHostKey(hostKey)) {
				setMsg("失败: host pin 必须是 OpenSSH SHA256: 加 43 位 base64 指纹");
				return;
			}
			setBusy("pin:" + pinDraft.alias);
			try {
				const response = await authFetch("/sched/ssh/hosts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action: "update",
						alias: pinDraft.alias,
						expectedHostRevision: (hosts ?? []).find((host) => host.alias === pinDraft.alias)?.revision,
						patch: { hostKey },
					}),
				});
				const result = await response.json().catch(() => ({}));
				if (!response.ok || !result.host) {
					throw new Error(result.error ?? `HTTP ${response.status}`);
				}
				setMsg(`✅ ${pinDraft.alias} host key 已固定`);
				setPinDraft(null);
				await load();
			} catch (error) {
				setMsg("失败: " + error.message);
			} finally {
				setBusy("");
			}
		};



		if (termTarget) return j(SshTerminal, {
			alias: termTarget.alias,
			transport: termTarget.transport,
			onClose: () => { setTermTarget(null); },
		});


		const engineMode = binding?.mode === "engine";
		const systemOpenSshMode = binding?.mode === "system-openssh";
		const localMode = binding?.mode === "local";
		const systemMasterReady = systemOpenSshMode && binding?.master?.ready === true;
		const transportColor = engineMode || systemMasterReady ? T.ok : systemOpenSshMode ? T.warn : localMode ? T.brand : T.label2;
		const activeSystemNotice = (systemOpenSshMode && binding?.master?.ready === false ? {
				sshEntry: binding.sshEntry,
				error: sshMasterErrorText(binding.master.error),
			} : null) ?? systemMasterNotice;

		return jsxs2("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, [

			// B24: SCHED 绑定状态条

			jsxs2("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 12px", background: engineMode || systemOpenSshMode || localMode ? `color-mix(in srgb, ${transportColor} 10%, transparent)` : T.bgLayer, borderRadius: 10, border: `1px solid ${engineMode || systemOpenSshMode || localMode ? `color-mix(in srgb, ${transportColor} 30%, transparent)` : T.border}` } }, [

				j("span", { style: { fontSize: 13, fontWeight: 700 } }, "SCHED"),

				j("span", {

					style: { fontSize: 13, color: transportColor, fontWeight: engineMode || systemOpenSshMode || localMode ? 700 : 400 },

				}, engineMode

					? `→ ${binding.alias}（内置引擎，连接池复用）`

					: systemOpenSshMode
						? `→ ${binding.sshEntry}（系统 OpenSSH，复用终端 ControlMaster${systemMasterReady ? "" : " · 未就绪"}）`

					: localMode ? "→ 本地 transport（无需 SSH）"

					: `→ sshEntry ${binding?.sshEntry ?? "?"}（通道未知）`),

				j("span", { style: { flex: 1 } }),

				engineMode && j("button", {
					onClick: () => doUseSystemOpenSsh(binding?.sshEntry),
					disabled: !!busy || !binding?.sshEntry,
					title: "复用本机终端已经通过密码/2FA 建立的 OpenSSH ControlMaster；不会在网页中请求验证码",
					style: ghostBtn,
				}, busy === "use-system:" + binding?.sshEntry ? "检测中…" : "复用终端登录"),

				systemOpenSshMode && j("button", {
					onClick: () => setTermTarget({ alias: binding.sshEntry, transport: "system-openssh" }),
					disabled: !!busy || !systemMasterReady,
					title: systemMasterReady
						? "打开复用当前 ControlMaster 的系统 OpenSSH 终端"
						: "请先按下方提示在本机终端建立 ControlMaster",
					style: { ...ghostBtn, opacity: systemMasterReady ? 1 : 0.5 },
				}, "终端"),

				engineMode && j("button", { onClick: doUnbind, disabled: !!busy, title: "解除内置引擎绑定并使用系统 OpenSSH", style: ghostBtn },

					busy === "unbind" ? "解绑中…" : "解绑"),

			]),

			activeSystemNotice && jsxs2("section", {
				"aria-label": "OpenSSH ControlMaster 未就绪",
				style: {
					display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
					padding: "10px 12px", border: `1px solid ${T.warn}`, borderRadius: 10,
					background: `color-mix(in srgb, ${T.warn} 8%, transparent)`,
				},
			}, [
				jsxs2("div", { style: { flex: "1 1 360px", minWidth: 0 } }, [
					j("b", null, "请先在终端完成 SSH 登录"),
					j("div", { role: "status", "aria-live": "polite", style: { color: T.label2, marginTop: 2, overflowWrap: "anywhere" } }, [
						"未发现可复用的 OpenSSH ControlMaster。请在本机终端运行 ",
						j("code", { style: { color: T.label, fontWeight: 700 } }, `ssh ${activeSystemNotice.sshEntry}`),
						" 并完成密码/2FA，然后回来重新检测。dsh 不会弹出 OTP 输入框，也不会读取或保存验证码。",
					]),
					activeSystemNotice.error && j("div", { style: { color: T.warn, fontSize: 12, marginTop: 3, overflowWrap: "anywhere" } }, activeSystemNotice.error),
				]),
				j("button", {
					type: "button",
					onClick: () => doUseSystemOpenSsh(activeSystemNotice.sshEntry),
					disabled: !!busy,
					style: btn(T.warn, !!busy),
				}, busy === "use-system:" + activeSystemNotice.sshEntry ? "检测中…" : "重新检测"),
			]),

			jsxs2("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } }, [

				j("button", { onClick: doImport, disabled: !!busy, style: btn(T.brand, !!busy) },

					busy === "import" ? "导入中…" : "从 ~/.ssh/config 导入"),

				j("span", { style: { color: T.label2, fontSize: 13 } },

					`共 ${hosts ? hosts.length : "…"} 台主机 · 密钥认证走本机 ~/.ssh 文件或 ssh-agent`),

				msg && j("span", { style: { color: msg.includes("失败") ? T.err : T.ok, fontSize: 13 } }, msg),

			]),

			hosts === null && j("div", { style: { color: T.label2 } }, "loading…"),

			hosts !== null && hosts.length === 0 && j("div", { style: { color: T.label2, fontSize: 13 } },

				"暂无主机 —— 点上方「从 ~/.ssh/config 导入」一键导入"),

			trustDraft && jsxs2("div", {
				style: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", border: `1px solid ${T.warn}`, borderRadius: 10, background: `color-mix(in srgb, ${T.warn} 7%, transparent)` },
			}, trustDraft.phase === "probing" ? [
				j("div", { key: "title", style: { fontWeight: 700 } }, `正在为 ${trustDraft.targetAlias} 建立服务器信任…`),
				j("div", { key: "detail", style: { color: T.label2, fontSize: 13 } }, "先检查本机 known_hosts；如果没有记录，只进行 SSH 密钥交换，不向待确认主机发送用户凭据。"),
				j("div", { key: "actions", style: { display: "flex", justifyContent: "flex-end" } },
					j("button", { onClick: cancelTrust, style: ghostBtn }, "取消")),
			] : [
				j("div", { key: "title", style: { fontWeight: 700 } }, `确认 ${trustDraft.challenge.target.alias} 的服务器身份`),
				j("div", { key: "endpoint", style: { color: T.label2, fontSize: 13 } },
					`${trustDraft.challenge.target.host}:${trustDraft.challenge.target.port} · ${trustDraft.challenge.observed.algorithm ?? "未知算法"}`),
				trustDraft.mode === "rotate" && j("div", { key: "old", style: { color: T.err, fontSize: 12, fontFamily: "monospace", overflowWrap: "anywhere" } },
					`原指纹: ${(hosts ?? []).find((host) => host.alias === trustDraft.challenge.target.alias)?.hostKey ?? "未记录"}`),
				j("div", { key: "fingerprint", style: { padding: "8px 10px", borderRadius: 8, background: T.bgLayer, fontFamily: "monospace", fontSize: 13, overflowWrap: "anywhere" } },
					trustDraft.challenge.observed.fingerprint),
				j("div", { key: "safety", style: { color: T.ok, fontSize: 12 } }, "此次探测未向这台待确认主机发送密码、私钥、ssh-agent 签名或动态验证码。首次确认属于 TOFU，请只在你确认当前网络路径可信时继续。"),
				jsxs2("div", { key: "actions", style: { display: "flex", gap: 8, justifyContent: "flex-end" } }, [
					j("button", {
						onClick: cancelTrust,
						disabled: busy.startsWith("trust-confirm:"),
						title: busy.startsWith("trust-confirm:") ? "保存已开始，不能再撤销本次确认" : "取消且不保存指纹",
						style: { ...ghostBtn, opacity: busy.startsWith("trust-confirm:") ? 0.5 : 1 },
					}, "取消"),
					j("button", { onClick: confirmTrust, disabled: busy.startsWith("trust-confirm:"), style: btn(T.warn, busy.startsWith("trust-confirm:")) },
						busy.startsWith("trust-confirm:") ? "保存中…" : "确认并信任"),
				]),
			]),

			pinDraft && jsxs2("div", {
				style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", border: `1px solid ${T.warn}`, borderRadius: 8 },
			}, [
				j("label", { style: { flex: 1, minWidth: 260 } }, [
					j("span", { style: { display: "block", color: T.label2, marginBottom: 4 } }, `${pinDraft.alias} 的 OpenSSH SHA256 host key 指纹`),
					j("input", {
						value: pinDraft.value,
						onChange: (event) => setPinDraft((current) => ({ ...current, value: event.target.value })),
						spellCheck: false,
						style: { width: "100%", boxSizing: "border-box", padding: "7px 9px", borderRadius: 8, border: `1px solid ${T.border}`, fontFamily: "monospace" },
					}),
				]),
				j("button", { onClick: doPin, disabled: !!busy, style: btn(T.warn, !!busy) }, busy === "pin:" + pinDraft.alias ? "保存中…" : "保存 pin"),
				j("button", { onClick: () => setPinDraft(null), disabled: !!busy, style: ghostBtn }, "取消"),
			]),

			hosts !== null && jsxs2("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, [

					...hosts.map((h) => {

						const engineBoundHere = engineMode && binding?.alias === h.alias;
						const systemBoundHere = systemOpenSshMode && binding?.sshEntry === h.alias;
						const boundHere = engineBoundHere || systemBoundHere;
						const trustSource = h.hostKeys?.[0]?.source;
						const trustReady = h.hostKeyReady && h.chainReady !== false;

					return jsxs2("div", {

						key: h.alias,

						style: {

							display: "flex", alignItems: "center", gap: 12,

							padding: "8px 12px", borderRadius: 10,

							border: `1px solid ${boundHere ? `color-mix(in srgb, ${transportColor} 35%, transparent)` : T.border}`,

							background: boundHere ? `color-mix(in srgb, ${transportColor} 7%, transparent)` : "transparent",

						},

					}, [

						// 左：身份区（一行一条 ssh 配置）

						j("span", { style: { fontWeight: 700, fontSize: 13, flexShrink: 0 } }, h.alias),

						boundHere && j("span", { style: { color: transportColor, fontWeight: 700, fontSize: 13, border: `1px solid ${transportColor}`, borderRadius: 999, padding: "1px 8px", flexShrink: 0 } }, "SCHED"),

						j("span", { style: { color: T.label2, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } }, [

							h.user !== "root" ? `${h.user}@${h.host}` : h.host,

							`:${h.port}`,

							h.auth === "key" ? (h.keyReady ? " · 🔑" : " · ⚠key缺失") : h.auth === "agent" ? " · agent" : " · 密码",

							(h.proxyJump && h.proxyJump.length > 0) ? ` · via ${h.proxyJump.join(">")}` : "",

							h.description ? ` · ${h.description}` : "",
							h.hostKeyReady ? ` · host✓${trustSource ? `(${trustSource})` : ""}` : " · ⚠host pin缺失",
							h.chainReady === false ? " · ⚠跳板链未信任" : "",

						].join("")),

						// 右：操作区

						(localMode || engineBoundHere)

							? j("span", { key: "sb", style: { color: localMode ? T.brand : T.ok, fontWeight: 700, fontSize: 13, flexShrink: 0 } }, localMode ? "本地运行" : "✔ 内置引擎")

							: j("button", {
								key: "bnd",
								onClick: () => doBind(h.alias),
								disabled: !!busy || !trustReady,
								title: trustReady ? "设为 sched 数据源主机（引擎模式）" : "先建立目标及完整 ProxyJump 链的主机信任",
								style: { ...ghostBtn, color: T.brand, borderColor: `color-mix(in srgb, ${T.brand} 45%, transparent)`, flexShrink: 0, opacity: trustReady ? 1 : 0.5 },
							}, busy === "bind:" + h.alias ? "绑定中…" : "设为SCHED"),

						!localMode && (systemBoundHere
							? j("span", { key: "system-sb", style: { color: systemMasterReady ? T.ok : T.warn, fontWeight: 700, fontSize: 13, flexShrink: 0 } }, systemMasterReady ? "✔ ControlMaster" : "⚠ ControlMaster")
							: j("button", {
								key: "system-sb",
								onClick: () => doUseSystemOpenSsh(h.alias),
								disabled: !!busy,
								title: `复用终端中 ssh ${h.alias} 已建立的 OpenSSH ControlMaster；不会在网页中请求 2FA`,
								style: { ...ghostBtn, color: T.brand, flexShrink: 0 },
							}, busy === "use-system:" + h.alias ? "检测中…" : "复用终端")),

						j("button", {
							key: "trust",
							onClick: () => prepareTrust(h.alias, trustReady ? { mode: "rotate", hostAlias: h.alias } : {}),
							disabled: !!busy,
							title: trustReady ? "无凭据重新探测并显式确认服务器身份" : "优先复用本机 known_hosts，否则无凭据逐段探测后确认",
							style: { ...ghostBtn, color: trustReady ? T.label2 : T.warn, flexShrink: 0 },
						}, busy === "trust:" + h.alias ? "…" : (trustReady ? "重新确认" : "建立信任")),
						j("button", {
							key: "manual-pin",
							onClick: () => setPinDraft({ alias: h.alias, value: h.hostKey ?? "SHA256:" }),
							disabled: !!busy,
							title: "高级设置：手动粘贴 OpenSSH SHA256 host key 指纹",
							style: { ...ghostBtn, color: T.label2, flexShrink: 0 },
						}, "手动pin"),
						j("button", {
							key: "o",
							onClick: () => setTermTarget({
								alias: systemBoundHere ? binding.sshEntry : h.alias,
								transport: systemBoundHere ? "system-openssh" : "engine",
							}),
							disabled: systemBoundHere ? !systemMasterReady : !trustReady,
							title: systemBoundHere
								? (systemMasterReady ? "打开复用当前 ControlMaster 的系统 OpenSSH 终端" : "请先在本机终端建立 ControlMaster")
								: (trustReady ? "打开内置 SSH 引擎终端" : "先建立目标及完整 ProxyJump 链的主机信任"),
							style: { ...ghostBtn, flexShrink: 0, opacity: (systemBoundHere ? systemMasterReady : trustReady) ? 1 : 0.5 },
						}, "终端"),

						confirmAlias === h.alias

							? j("button", { key: "c", onClick: () => doDelete(h.alias), style: { ...btn(T.err), flexShrink: 0 } }, "确认删除")

							: j("button", {
								key: "t",
								onClick: () => systemBoundHere ? doUseSystemOpenSsh(binding.sshEntry) : doTest(h.alias),
								disabled: !!busy || (!systemBoundHere && !trustReady),
								title: systemBoundHere
								? "只检测终端 ControlMaster，不发起新的 SSH 身份验证"
								: (trustReady ? "测试内置 SSH 引擎连通性" : "先建立目标及完整 ProxyJump 链的主机信任"),
								style: { ...ghostBtn, flexShrink: 0, opacity: (systemBoundHere || trustReady) ? 1 : 0.5 },
							}, busy === (systemBoundHere ? "use-system:" : "test:") + h.alias ? "…" : "测试"),

						confirmAlias === h.alias

							? j("button", { key: "x", onClick: () => setConfirmAlias(null), style: { ...ghostBtn, flexShrink: 0 } }, "取消")

							: j("button", { key: "d", onClick: () => setConfirmAlias(h.alias), disabled: !!busy, title: "删除该主机配置", style: { ...ghostBtn, color: T.err, flexShrink: 0 } }, "删"),

					]);

				}),

			]),

			confirmAlias && j("div", { style: { fontSize: 13, color: T.warn } }, `再次点「确认删除」以移除 ${confirmAlias}（连接立即断开）`),

		]);

	}



	// xterm.js WS 终端：帧协议 server->{ready|output|exit}, client->{input|resize}

	function SshTerminal({ alias, transport = "engine", onClose }) {

		const boxRef = useRef(null);

		useEffect(() => {

			const el = boxRef.current;

			if (!el) return;

			let ws, term, fit, ro;

			let disposed = false;

			(async () => {

				const xtermMod = require("@xterm/xterm");

				const fitMod = require("@xterm/addon-fit");

				const TerminalCtor = xtermMod.Terminal ?? xtermMod.default?.Terminal ?? xtermMod.default;

				const FitAddonCtor = fitMod.FitAddon ?? fitMod.default?.FitAddon ?? fitMod.default;

				injectXtermCss(require("@xterm/xterm/css/xterm.css"));

				if (disposed) return;

				term = new TerminalCtor({

					fontFamily: "var(--dsw-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)",

					fontSize: 13, cursorBlink: true, scrollback: 5000,

					theme: { background: "#111318" },

				});

				fit = new FitAddonCtor();

				term.loadAddon(fit);

				term.open(el);

				try { fit.fit(); } catch { /* zero-size */ }

				term.writeln(`\x1b[90m连接 ${alias} …\x1b[0m`);

				const proto = location.protocol === "https:" ? "wss://" : "ws://";

				ws = authenticatedWebSocket(`${proto}${location.host}/sched/ws/ssh-terminal?transport=${encodeURIComponent(transport)}&alias=${encodeURIComponent(alias)}&cols=${term.cols}&rows=${term.rows}`);

				ws.onmessage = (ev) => {

					let frame;

					try { frame = JSON.parse(ev.data); } catch { return; }

					if (frame.type === "ready") { term.clear(); term.focus(); }

					else if (frame.type === "output") term.write(frame.data);

					else if (frame.type === "exit") {

						term.write(`\r\n\x1b[31m■ 会话结束${frame.error ? ": " + frame.error : ""}\x1b[0m\r\n`);

					}

				};

				ws.onerror = () => term.write(`\r\n\x1b[31m■ WebSocket 错误\x1b[0m\r\n`);

				term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data: d })); });

				term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols, rows })); });

				ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });

				ro.observe(el);

				})().catch((error) => {
					if (disposed) return;
					try {
						term?.write(`\r\n\x1b[31m■ 终端认证不可用: ${String(error?.message ?? error).slice(0, 160)}\x1b[0m\r\n`);
					} catch { /* terminal not initialized */ }
				});

			return () => {

				disposed = true;

				try { ro?.disconnect(); } catch { /* gone */ }

				try { ws?.close(); } catch { /* gone */ }

				try { term?.dispose(); } catch { /* gone */ }

			};

		}, [alias, transport]);

		return jsxs2("div", { style: { display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 } }, [

			jsxs2("div", { style: { display: "flex", gap: 10, alignItems: "center" } }, [

				j("button", { onClick: onClose, style: backBtn, title: "返回主机列表" }, [

					j("span", { "aria-hidden": true, style: { fontSize: 15 } }, "\u2039"),

					j("span", null, "返回"),

				]),

				j("h3", { style: { ...boardTitleStyle, fontSize: 14 } }, `终端 · ${alias}`),

				j("span", { style: { color: transport === "system-openssh" ? T.ok : T.label2, fontSize: 13 } },
					transport === "system-openssh" ? "系统 OpenSSH · 复用终端 ControlMaster" : "内置 SSH 引擎"),

				j("span", { style: { color: T.label2, fontSize: 13 } }, "关闭页签即断开远端 shell"),

			]),

			j("div", { ref: boxRef, style: { flex: 1, minHeight: 320, borderRadius: 10, border: `1px solid ${T.border2}`, overflow: "hidden", padding: 6, background: "#111318" } }),

		]);

	}


	const GRID = {

		display: "grid",

		gridTemplateColumns: "76px minmax(110px, 1fr) minmax(150px, 1.8fr) 56px 84px",

		gap: "0 12px", alignItems: "center",

	};






	// B25/B25b: 离散任务段 —— 一段一任务, 颜色即状态。每行段数由中列实际

	// 宽度自适应决定 (flex wrap): 窗口宽 → 一行多段, 窗口窄 → 自动减段换行。

	// 超过 MAX_VISIBLE 段截断并显示 "+N"（168 任务全画会淹没列表）。

	const SEG_MAX_VISIBLE = 30;

	function TaskSegments({ tasks }) {

		if (!tasks || !tasks.length) return null;


		const shown = Math.min(tasks.length, SEG_MAX_VISIBLE);

		return jsxs2("span", { style: {

			display: "flex", flexWrap: "wrap", gap: 3,

			width: "100%", maxWidth: 400,

			alignContent: "start",

		} }, [

			...tasks.slice(0, shown).map((t, i) =>

				j("span", {

					key: (t.id ?? t.task ?? i) + "",

					title: `${t.task}: ${t.status}`,

					style: { width: 18, height: 15, borderRadius: 3,

						background: COLORS[t.status] ?? T.label2, display: "inline-block",

						cursor: "default" },

				})),

			tasks.length > SEG_MAX_VISIBLE && j("span", {

				style: { fontSize: 12, color: T.label2, alignSelf: "center" },

			}, `+${tasks.length - SEG_MAX_VISIBLE}`),

		]);

	}



	function BatchRow({ b, jobsAll, runOp, setLogTask }) {

		const [open, setOpen] = useState(false);
		const tasks = jobsForBatch(jobsAll, b.id);
		const cancelRequest = batchCancelRequest(b);
		const failures = [];
		for (const task of tasks) {
			const reference = taskReference(task);
			const contract = taskStatusContract(task.status);
			if (reference && contract.category === "failure") {
				failures.push({ task, reference, contract });
			}
		}

		return jsxs2("div", { style: { marginBottom: 10 } }, [
			jsxs2("div", { style: { ...GRID, alignItems: "start" }, onClick: () => setOpen(!open) }, [
				j("span", { style: { textAlign: "center", cursor: "pointer", lineHeight: "15px" } }, Badge({ s: b.status })),
				jsxs2("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer", lineHeight: "15px" }, onClick: (e) => { e.stopPropagation(); setOpen(!open); } }, [
					j("b", { style: { fontSize: 13 }, title: b.name }, b.name),
					b.project && j("span", { style: { fontSize: 11, color: T.label2, marginLeft: 6 } }, b.project),
				]),
				j(TaskSegments, { tasks }),
				j("span", { style: { fontSize: 12.5, color: T.label2, textAlign: "right", lineHeight: "15px" } }, b.progress ?? ""),
				cancelRequest && j(ArmButton, {
					label: "cancel",
					confirmLabel: "cancel(取消任务!)",
					color: T.err,
					stopProp: true,
					onConfirm: () => runOp(cancelRequest.op, b),
				}),
			]),
			open && jsxs2("div", { style: { marginTop: 6, marginLeft: 76, paddingLeft: 10, borderLeft: `2px solid ${T.border}` } }, [
				b.depends_on?.length > 0 && j("div", { style: { fontSize: 12, color: T.label2 } }, `依赖: ${b.depends_on.join(", ")}`),
				...failures.map(({ task, reference, contract }) =>
					jsxs2("div", { key: reference, style: { fontSize: 13, marginLeft: 14, marginTop: 2, display: "flex", alignItems: "center" } }, [
						contract.controls.includes("log") && j("span", {
							style: { fontFamily: "monospace", cursor: "pointer", textDecoration: "underline", marginRight: 6 },
							onClick: () => setLogTask(reference),
							title: "查看日志",
						}, task.task),
						Badge({ s: task.status }),
						task.retries != null && j("span", { style: { color: T.label2, marginRight: 4 } }, `retries=${task.retries}`),
						j("span", { style: { flex: 1 } }),
						contract.controls.includes("retry") && j("button", {
							onClick: () => runOp("retry", { ...task, revision: b.revision }),
							style: btn(T.brand),
						}, "retry"),
						contract.controls.includes("resubmit") && j(ArmButton, {
							label: "resubmit",
							confirmLabel: "resubmit(删产物!)",
							color: T.warn,
							onConfirm: () => runOp("resubmit", { ...task, revision: b.revision }),
						}),
					])),
			]),
		]);
	}



	function GpuRow({ g, runOp }) {
		const assignmentText = (g.assignments ?? [])
			.map((assignment) => `${assignment.job_id}${assignment.vram_gib === null ? "" : ` (${assignment.vram_gib} GiB)`}`)
			.join(", ");

		return jsxs2("div", { style: { marginBottom: 6, display: "flex", alignItems: "center" } }, [

			Badge({ s: g.status }),

			j("span", {
				style: { fontFamily: "monospace", marginRight: 8 },
				title: `revision ${g.revision}`,
			}, `GPU${g.idx}`),

			assignmentText && j("span", {
				style: { fontSize: 12, marginRight: 8, color: T.label2, flex: 1 },
			}, assignmentText),

			g.quarantined && j("span", { style: { color: T.err, marginRight: 8, fontSize: 12 } }, "[quarantined]"),

			!assignmentText && g.status === "free" && j("span", { style: { flex: 1 } }),

			g.status === "unmanaged" && j(ArmButton, { label: "gpu-free 强制回收", confirmLabel: "确认回收?", color: T.warn,

				onConfirm: () => runOp("gpu-free", g) }),

			g.quarantined && j("button", { onClick: () => runOp("gpu-ok", g), style: btn(T.ok) }, "gpu-ok 解除隔离"),

		]);

	}



	function DaemonBar({ runOp }) {

		const [status, setStatus] = useState(null);      // 上次成功查询的状态文本（保留不清空）

		const [querying, setQuerying] = useState(true);  // 是否正在查询

		const [confirmStop, setConfirmStop] = useState(false);

		const [channel, setChannel] = useState(null);    // B24f: 生效通道 {alias, mode, sshEntry}

		const load = useCallback(() => {

			setQuerying(true);

			authFetch("/sched/api/daemon").then((r) => r.json()).then((d) => {

				if (d.ok) setStatus(d.text);

				else setStatus((prev) => prev ?? ("查询失败: " + String(d.text ?? "").slice(0, 80)));

				setQuerying(false);

			}).catch(() => { setQuerying(false); }); // 失败保留上次值

			// 只读通道徽章：单一事实来源在 ssh tab 的绑定状态条，这里仅展示

			authFetch("/sched/api/entry").then((r) => r.json()).then(setChannel).catch(() => {});

		}, []);

		useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

		const running = status != null && status.includes("运行中");
		const engineMode = channel?.mode === "engine";
		const systemOpenSshMode = channel?.mode === "system-openssh";
		const localMode = channel?.mode === "local";
		const systemMasterReady = systemOpenSshMode && channel?.master?.ready === true;
		const channelColor = engineMode || systemMasterReady ? T.ok : systemOpenSshMode ? T.warn : localMode ? T.brand : T.label2;

		return jsxs2("div", { style: { marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center" } }, [

			// B24f: 只读通道徽章 —— 连接控制唯一入口在 ssh tab

			j("span", {

				title: systemOpenSshMode
					? "系统 OpenSSH 复用本机终端的 ControlMaster；连接失效时请到 ssh 页按提示重新检测"
					: "\u8fde\u63a5\u901a\u9053\u5728 ssh \u9875\u7ba1\u7406",

				style: { fontSize: 13, padding: "2px 8px", borderRadius: 999, flexShrink: 0,

					color: channelColor,

					border: `1px solid ${engineMode || systemOpenSshMode || localMode ? `color-mix(in srgb, ${channelColor} 35%, transparent)` : T.border}`,

					background: engineMode || systemOpenSshMode || localMode ? `color-mix(in srgb, ${channelColor} 8%, transparent)` : "transparent",

					marginRight: 8, whiteSpace: "nowrap" },

			}, engineMode ? `\u26a1 ${channel.alias}` :

				systemOpenSshMode ? `ssh:${channel.sshEntry} · master${systemMasterReady ? "✓" : "×"}` :

				localMode ? "local transport" :

				channel ? `cli:${channel.sshEntry}` : "\u2026"),

			jsxs2("span", { style: { fontSize: 13, marginRight: 8, flex: 1 } }, [

				j("span", { style: { color: running ? T.ok : (status ? T.err : T.label2) } },

					`daemon: ${status ?? ""}`),

				querying && j("span", { style: { color: T.label2 } }, " …等待查询"),

			]),

			// B14: 状态联动 —— 运行中禁用 start, 未运行禁用 stop

			...(status === null ? [j("span", { key: "dw", style: btn(T.label2, true) }, "…")] : [

				running

					? j("button", { key: "s", disabled: true, title: "已在运行", style: btn(T.ok, true) }, "start")

					: j("button", { key: "s", onClick: async () => { await runOp("daemon-start", null); setTimeout(load, 3000); }, style: btn(T.ok) }, "start"),

				running

					? (!confirmStop && j("button", { key: "x", onClick: () => setConfirmStop(true), style: btn(T.err) }, "stop"))

					: j("button", { key: "x", disabled: true, title: "未运行", style: btn(T.err, true) }, "stop"),

			]),

			confirmStop && j(TypedConfirm, {

				placeholder: "输入 stop 确认（会取消未完成任务）", color: T.err,

				onConfirm: async () => { await runOp("daemon-stop", null); setConfirmStop(false); },

			}, "确认 stop"),

		]);

	}



	const IncidentsTab = memo(function IncidentsTab() {

		// 挂载即从模块缓存水合 (有缓存则无 loading 态), 再静默刷新

		const [list, setList] = useState(INC_CACHE ? INC_CACHE.list : null);

		const [frozenAt, setFrozenAt] = useState(INC_CACHE ? INC_CACHE.frozenAt : "");

		const [detail, setDetail] = useState(

			INC_OPEN_ID && INC_DETAIL && INC_DETAIL[INC_OPEN_ID]

				? { ...INC_DETAIL[INC_OPEN_ID], id: INC_OPEN_ID } : null);

		const [msg, setMsg] = useState("");
		const setDetailT = (value) => setDetail(value);




		const applyList = (incidents, snapshotTime) => {
			const frozenAt = snapshotTime || new Date().toLocaleTimeString("zh-CN", { hour12: false });
			setList(incidents);
			setFrozenAt(frozenAt);
			INC_CACHE = { list: incidents, frozenAt };
		};




		const openDetail = useCallback(async (id) => {

			const gen = ++INC_VIEW_GEN;

			setDetailT({ id, loading: true });

			INC_OPEN_ID = id;

			try {

				const r = await authFetch(`/sched/api/incidents?id=${id}`);

				const d = await r.json();
				if (!r.ok || !d?.ok) {
					throw new Error(String(d?.text || `HTTP ${r.status}`).slice(0, 240));
				}
				let payload;
				try {
					payload = JSON.parse(d.text);
				} catch {
					throw new Error("详情响应不是有效 JSON");
				}
				const inc = payload?.incident;
				if (!inc || typeof inc !== "object") throw new Error("详情响应缺少 incident");

				// 先写模块缓存 (跨重挂载存活 —— 水合时可原样恢复展开态)

				INC_DETAIL = { ...(INC_DETAIL || {}), [inc.id]: inc };

				// UI 更新带代数守卫: 已收起/切换则只留缓存不改界面

				if (gen !== INC_VIEW_GEN || INC_OPEN_ID !== inc.id) return;

				setDetailT(inc);

			} catch (e) {
				if (gen === INC_VIEW_GEN && INC_OPEN_ID === id) {
					setDetailT({ id, error: String(e) });
				}
			}

		}, []);



		const load = useCallback(async () => {
			try {
				const r = await authFetch("/sched/api/incidents?limit=30");
				const d = await r.json();
				if (!d.ok) { setMsg("❌ " + (d.text || "").slice(0, 120)); return; }
				applyList(JSON.parse(d.text).incidents || []);
			} catch (e) { setMsg("❌ " + String(e)); }
		}, []);



		useEffect(() => { load(); }, [load]);

		// B19: 不在挂载时自动恢复展开详情 —— 外壳周期性重挂载会把已收起的

		// 详情反复"复活"(用户实测自动展开)。重进本页只看最新列表冻结态,

		// 详情需要时点行展开。



		if (!list) return j("div", { style: { color: T.label2, fontSize: 13 } },

			msg || (INC_CACHE ? "" : "loading…"));



		const p = detail && !detail.loading && !detail.error ? detail.payload || {} : null;


		const failed = p ? p.failed || {} : {};

		const mem = p ? p.memory || {} : {};



		return jsxs2("div", { style: { fontSize: 13, minWidth: 0, width: "100%" } }, [

			jsxs2("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
				padding: "5px 8px", borderRadius: 6, background: T.bgLayer,
				border: `1px solid ${T.border}`, flexWrap: "wrap", minWidth: 0, width: "100%", boxSizing: "border-box" } }, [

				j("span", { style: { color: T.warn } }, "⏸ 冻结"),

				j("span", { style: { color: T.label2, minWidth: 0, flex: "1 1 220px", overflowWrap: "anywhere" } },
					`快照时间 ${frozenAt || "…"} —— 阅读期间内容不变。`),


				j("button", { onClick: () => load(), style: { ...btn(T.brand), flexShrink: 0 } }, "刷新"),

			]),

			list.length === 0 && j("div", { style: { color: T.label2 } },

				"暂无事故快照 (OOM/gpu_fault 发生时自动采集)"),

			list.map((r) => jsxs2("div", { key: r.id, style: { minWidth: 0, width: "100%" } }, [

				jsxs2("div", {
					key: "row",
					onClick: () => {
						if (detail && detail.id === r.id) {
							INC_VIEW_GEN++;
							setDetailT(null);
							INC_OPEN_ID = null;
						} else {
							openDetail(r.id);
						}
					},
					style: {
						display: "grid",
						gridTemplateColumns: "max-content minmax(0, 1fr) max-content max-content",
						gridTemplateRows: "auto auto",
						columnGap: 10,
						rowGap: 2,
						alignItems: "start",
						padding: "5px 8px",
						cursor: "pointer",
						borderRadius: 4,
						background: detail && detail.id === r.id ? T.bgLayer : "transparent",
						minWidth: 0,
						width: "100%",
						boxSizing: "border-box",
					},
				}, [
					j("span", { style: { gridColumn: 1, gridRow: "1 / span 2", minWidth: "4ch", whiteSpace: "nowrap", color: T.label2 } }, "#" + r.id),
					j("span", { style: { gridColumn: 2, gridRow: 1, minWidth: 0, color: T.label, overflowWrap: "anywhere" } }, r.ts),
					j("span", { style: { gridColumn: 3, gridRow: 1, whiteSpace: "nowrap", color: r.kind === "oom" ? T.err : T.warn } }, r.kind),
					j("span", { style: { gridColumn: 4, gridRow: 1, whiteSpace: "nowrap" } }, "gpu" + (r.gpu_idx ?? "-")),
					j("span", {
						style: {
							gridColumn: "2 / -1",
							gridRow: 2,
							minWidth: 0,
							color: T.label2,
							overflowWrap: "anywhere",
							wordBreak: "break-word",
						},
					}, r.job_id || "—"),
				]),
				detail && detail.id === r.id && detail.loading &&
					j("div", { key: "detail-loading", style: { color: T.label2, padding: 8, margin: "2px 0 6px clamp(0px, 38px, 10vw)", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", overflowWrap: "anywhere" } }, "加载事故详情…"),
				detail && detail.id === r.id && detail.error &&
					j("div", { key: "detail-error", style: { color: T.err, padding: 8, margin: "2px 0 6px clamp(0px, 38px, 10vw)", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", overflowWrap: "anywhere" } }, `详情加载失败: ${detail.error}`),
				detail && detail.id === r.id && !detail.loading && !detail.error && jsxs2("div", {
					key: "detail",
					style: { border: `1px solid ${T.border}`, borderRadius: 6, padding: 8, margin: "2px 0 6px clamp(0px, 38px, 10vw)",
						minWidth: 0, maxWidth: "100%", boxSizing: "border-box", overflowWrap: "anywhere" } }, [
					jsxs2("div", { style: { marginBottom: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 } }, [
						j("span", { style: { fontWeight: 600, color: T.brand, minWidth: 0, overflowWrap: "anywhere" } },
							`#${detail.id} ${detail.kind} @ gpu${detail.gpu_idx ?? "-"}`),
						j("button", { onClick: (e) => { e.stopPropagation(); INC_VIEW_GEN++; setDetailT(null); INC_OPEN_ID = null; },
							style: { ...ghostBtn, marginLeft: 0, flexShrink: 0 } }, "收起"),
					]),
					j("div", { style: { color: T.label2, fontSize: 12, marginBottom: 4, minWidth: 0, overflowWrap: "anywhere" } },
						`${detail.ts} · job ${detail.job_id} · batch ${detail.batch_id}`),
					failed.dispatch_mode && j("div", { style: { wordBreak: "break-word", overflowWrap: "anywhere", lineHeight: 1.5 } },
						`派发方式: ${failed.dispatch_mode} · 声明 ${failed.declared_vram_gib ?? "-"} GiB · 历史峰值 ${failed.profile_peak_gib ?? "-"}`),
					mem.packed_sum_gib !== undefined && j("div", { style: { wordBreak: "break-word", overflowWrap: "anywhere", lineHeight: 1.5 } },
						`显存: cap=${mem.cap_gib ?? "?"} packed=${mem.packed_sum_gib} actual=${mem.actual_used_gib ?? "?"}${mem.degraded ? " [降级]" : ""}`),
					(mem.external_pids || []).length > 0 && jsxs2("div", { style: { color: T.warn, minWidth: 0, overflowWrap: "anywhere" } },
						["外部进程: ", ...(mem.external_pids || []).map((e) =>
							j("span", { key: e.pid }, `pid${e.pid}(${e.mem_mib ?? "?"}MiB) `))]),
					(p.co_runners || []).length > 0 && jsxs2("div", { style: { minWidth: 0, overflowWrap: "anywhere" } }, [
						j("div", { style: { color: T.label2, marginTop: 4 } }, "同卡邻居:"),
						...p.co_runners.map((c) => j("div", { key: c.job_id, style: { paddingLeft: 10, minWidth: 0, overflowWrap: "anywhere" } },
							`${c.task} [${c.status}] declared=${c.declared_vram_gib} peak=${c.profile_peak_gib} runtime=${c.runtime_sec}s`)),
					]),
					(detail.verdicts || []).length > 0 && jsxs2("div", { style: { marginTop: 6, minWidth: 0, overflowWrap: "anywhere" } }, [
						j("div", { style: { color: T.warn, fontWeight: 600 } }, "判读假设:"),
						...detail.verdicts.map((v, i2) => j("div", { key: i2, style: { color: T.warn, paddingLeft: 10, minWidth: 0, overflowWrap: "anywhere" } }, "? " + v)),
					]),
					p.log_excerpt && jsxs2("div", { style: { minWidth: 0 } }, [
						j("div", { style: { color: T.label2, marginTop: 6 } }, "日志摘录:"),
						j(ResizableTextBox, {
							minHeight: 72,
							maxHeight: 360,
							initialHeight: 120,
							style: { ...pre, minWidth: 0, margin: "2px 0" },
						}, p.log_excerpt),
					]),
				]),
			])),

			msg && j("div", { style: { color: T.err, fontSize: 13 } }, msg),

		]);

	});





	// B25c: 模块级水合缓存 —— 重挂载时立即恢复内容, 杜绝 "loading config…" 闪屏

	let CFG_CACHE = null;

	function ConfigTab() {

		const [cfgText, setCfgText] = useState(CFG_CACHE ? CFG_CACHE.text : "");

		const [cfg, setCfg] = useState(CFG_CACHE ? JSON.parse(JSON.stringify(CFG_CACHE.cfg)) : null);

		const [msg, setMsg] = useState("");

		const [advanced, setAdvanced] = useState(false);



		const load = useCallback(() => {

			authFetch("/sched/api/config").then((r) => r.json()).then((d) => {

				if (!d.ok) { setMsg("❌ 加载失败: " + (d.text || "").slice(0, 120)); return; }

				const parsed = JSON.parse(d.text);

				CFG_CACHE = { cfg: parsed, text: d.text };

				setCfg(parsed);

				setCfgText(d.text);

				setMsg("");

			}).catch(() => setMsg("❌ 加载异常"));

		}, []);

		useEffect(() => {

			authFetch("/sched/api/client-log", {

				method: "POST", headers: { "content-type": "application/json" },

				body: JSON.stringify({ kind: "lifecycle", detail: "config-mount ts=" + new Date().toISOString() + " cache=" + (CFG_CACHE ? "hit" : "miss"), ts: new Date().toISOString() }),

			}).catch(() => {});

			load();

		}, [load]);

		if (!cfg) return j("div", { style: { color: T.label2, fontSize: 13 } }, msg || "loading config…");



		const upd = (fn) => setCfg((c) => { const n = JSON.parse(JSON.stringify(c)); fn(n); return n; });



		async function save(patch) {
			setMsg("保存中…");
			const payload = JSON.stringify(patch);
			let requestKey;
			try {
				requestKey = await mutationPayloadKey("config-set", payload);
				const requestId = await durableRequests.claim(requestKey);
				const response = await authFetch("/sched/api/config/set", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ patch, requestId }),
				});
				const result = await response.json();
				if (mutationResultIsDefinitive(result)) {
					await durableRequests.complete(requestKey, requestId);
				}
				setMsg((result.ok ? "✅ " : "❌ ") + (result.text || "").split("\n")[0]);
				if (result.ok) load();
			} catch (error) {
				setMsg("❌ " + error);
			}
		}



		const numInput = (value, onChange, style) => j("input", {
			value: Number.isFinite(value) ? value : "",
			onChange: (e) => {
				const raw = e.target.value;
				if (raw === "") return onChange(null);
				const number = Number(raw);
				if (Number.isFinite(number)) onChange(number);
			},
			style: { ...style, width: 52, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, padding: "2px 4px", fontSize: 13 },
		});

		const secTitle = (t) => j("div", { style: { fontSize: 13, color: T.brand, margin: "8px 0 4px", fontWeight: 600 } }, t);

		const rowStyle = { display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 13, flexWrap: "wrap" };



		// ---- 项目区 ----

		const projects = cfg.projects || {};

		const projRows = Object.entries(projects).map(([name, pj]) => jsxs2("div", { key: name, style: rowStyle }, [

			j("span", { style: { width: 80, color: T.label } }, name),

			j("span", { style: { color: T.label2 } }, "配额"),

			numInput(pj.gpu_quota, (v) => upd((n) => { if (v === null) delete n.projects[name].gpu_quota; else n.projects[name].gpu_quota = v; })),

			j("span", { style: { color: T.label2 } }, "优先级"),

			numInput(pj.priority ?? 0, (v) => upd((n) => { n.projects[name].priority = v ?? 0; })),

			j("span", { style: { color: T.label2 } }, "单卡上限"),

			numInput(pj.max_jobs, (v) => upd((n) => { if (v === null) delete n.projects[name].max_jobs; else n.projects[name].max_jobs = v; })),

			j("select", {

				value: pj.colocate === undefined ? "" : String(pj.colocate),

				onChange: (e) => upd((n) => {

					const v = e.target.value;

					if (v === "") delete n.projects[name].colocate; else n.projects[name].colocate = v === "true";

				}),

				style: { background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, fontSize: 13 },

			}, [

				j("option", { value: "" }, "colocate跟随全局"),

				j("option", { value: "true" }, "允许共享"),

				j("option", { value: "false" }, "禁用(独占)"),

			]),

			j("span", { style: { color: T.label2 } }, "亲和卡 " + JSON.stringify(pj.gpu_affinity || [])),

		]));



		const buildProjectsPatch = () => {

			const patch = {};

			for (const [name, pj] of Object.entries(cfg.projects || {})) {

				patch.projects = patch.projects || {};

				patch.projects[name] = {};

				for (const k of ["gpu_quota", "priority", "max_jobs"]) {

					if (pj[k] !== undefined && pj[k] !== null) patch.projects[name][k] = pj[k];

				}

				if (pj.colocate !== undefined) patch.projects[name].colocate = pj.colocate;

			}

			return { projects: patch.projects };

		};



		// ---- co-location 区 ----

		const cl = cfg.co_locate;

		const clPatch = () => ({ co_locate: !!cl, co_locate_safety: Number(cfg.co_locate_safety ?? 0.7), co_locate_max_jobs: Number(cfg.co_locate_max_jobs ?? 3) });



		// ---- 通知区 ----

		const nf = cfg.notify || {};

		const evOn = (e) => Array.isArray(nf.on) && nf.on.includes(e);

		const fileOn = !!(nf.file && nf.file.enabled);

		const notifyPatch = () => ({

			notify: {

				on: ["batch_done", "batch_blocked"].filter((e, i) =>

					[e === "batch_done" ? evOn("batch_done") : true, e === "batch_blocked" ? evOn("batch_blocked") : true][i] !== false || evOn(e)),

				file: { ...(nf.file || {}), enabled: fileOn },

			},

		});



		return jsxs2("div", { style: { fontSize: 13 } }, [

			secTitle("项目参数（双项目共享配置 — 保存影响两个代理）"),

			jsxs2("div", { style: rowStyle }, [

				j("span", { style: { color: T.err } }, "⚠️ 保存需二次确认；冷键(node/state_dir/gpus 卡集)仅可读，变更须 ssh 重启 daemon"),

			]),

			projRows,

			j(ArmButton, { label: "保存项目参数", confirmLabel: "确认保存?", color: T.brand,

				onConfirm: () => save(buildProjectsPatch()) }),



			secTitle("co-location 全局"),

			jsxs2("div", { style: rowStyle }, [

				j("label", { style: { color: T.label } }, [

					j("input", { type: "checkbox", checked: !!cl, onChange: (e) => upd((n) => { n.co_locate = e.target.checked; }) }),

					" 启用共享装箱",

				]),

				j("span", { style: { color: T.label2 } }, "safety"),

				numInput(cfg.co_locate_safety ?? 0.7, (v) => upd((n) => { if (v !== null) n.co_locate_safety = v; })),

				j("span", { style: { color: T.label2 } }, "每卡上限"),

				numInput(cfg.co_locate_max_jobs ?? 3, (v) => upd((n) => { if (v !== null) n.co_locate_max_jobs = v; })),

				j(ArmButton, { label: "保存", confirmLabel: "确认保存?", color: T.brand, onConfirm: () => save(clPatch()) }),

			]),



			secTitle("通知"),

			jsxs2("div", { style: rowStyle }, [

				j("label", { style: { color: T.label } }, [

					j("input", { type: "checkbox", checked: evOn("batch_done"),

						onChange: (e) => upd((n) => {

							n.notify = n.notify || {}; n.notify.on = n.notify.on || [];

							n.notify.on = e.target.checked

								? [...new Set([...n.notify.on, "batch_done"])]

								: n.notify.on.filter((x) => x !== "batch_done");

						}) }),

					" batch_done",

				]),

				j("label", { style: { color: T.label, marginRight: 10 } }, [

					j("input", { type: "checkbox", checked: evOn("batch_blocked"),

						onChange: (e) => upd((n) => {

							n.notify = n.notify || {}; n.notify.on = n.notify.on || [];

							n.notify.on = e.target.checked

								? [...new Set([...n.notify.on, "batch_blocked"])]

								: n.notify.on.filter((x) => x !== "batch_blocked");

						}) }),

					" batch_blocked",

				]),

				j("label", { style: { color: T.label, marginRight: 10 } }, [

					j("input", { type: "checkbox", checked: fileOn,

						onChange: (e) => upd((n) => { n.notify = n.notify || {}; n.notify.file = { ...(n.notify.file || {}), enabled: e.target.checked }; }) }),

					" file 渠道",

				]),

				j(ArmButton, { label: "保存通知设置", confirmLabel: "确认保存?", color: T.brand, onConfirm: () => save(notifyPatch()) }),

			]),



			secTitle("冷键（只读）"),

			jsxs2("div", { style: { ...rowStyle, color: T.label2 } }, [

				j("span", {}, `node=${cfg.node} · user=${cfg.user} · gpus=${JSON.stringify(cfg.gpus)}`),

			]),



			jsxs2("div", { style: rowStyle }, [

				j("button", { onClick: () => setAdvanced(!advanced), style: ghostBtn }, advanced ? "收起高级模式" : "高级模式 (原始 JSON)"),

				advanced && j(ArmButton, { label: "保存完整 JSON", confirmLabel: "确认保存全部?", color: T.warn,

					onConfirm: async () => {

						try { JSON.parse(cfgText); } catch (e) { setMsg("❌ JSON 解析失败"); return; }

						upd(() => {}); // noop

						await save(JSON.parse(cfgText));

					} }),

			]),

			advanced && j(ResizableTextBox, {

				as: "textarea",

				value: cfgText, onChange: (e) => setCfgText(e.target.value),

				"aria-label": "配置 JSON",

				minHeight: 160,

				maxHeight: "min(70vh, 640px)",

				initialHeight: 240,

				style: { background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 6, fontSize: 13, fontFamily: "monospace", padding: 8 },

			}),

			msg && j("div", { style: { fontSize: 13, marginTop: 6, color: msg.startsWith("✅") ? T.ok : T.warn } }, msg),

		]);

	}



	function SubmitTab({ post, refreshSnap, setTab }) {

		const [text, setText] = useState("");

		const [preview, setPreview] = useState(null);

		const [msg, setMsg] = useState("");

		const [projectNames, setProjectNames] = useState(["default"]);

		const [selectedProject, setSelectedProject] = useState("default");

		useEffect(() => {
			let alive = true;
			const applyConfig = (cfg) => {
				const names = configuredProjectNames(cfg);
				if (!alive || names.length === 0) return;
				setProjectNames(names);
				setSelectedProject((current) => names.includes(current) ? current : names[0]);
			};
			if (CFG_CACHE?.cfg) applyConfig(CFG_CACHE.cfg);
			authFetch("/sched/api/config")
				.then((response) => response.json())
				.then((payload) => {
					if (!payload?.ok || typeof payload.text !== "string") return;
					applyConfig(JSON.parse(payload.text));
				})
				.catch(() => {});
			return () => { alive = false; };
		}, []);

		const doDryRun = async () => {

			setPreview(null); setMsg("dry-run 中…");

			try {

				const r = await post("dryrun", { content: text });

				setPreview(r); setMsg(r.ok ? "预览通过，可提交" : "预览失败");

			} catch (e) { setMsg(String(e)); }

		};

		const doSubmit = async () => {
			setMsg("提交中…");
			try {
				const requestKey = await mutationPayloadKey("submit", text);
				const requestId = await durableRequests.claim(requestKey);
				const result = await post("submit", { content: text, requestId });
				if (mutationResultIsDefinitive(result)) {
					await durableRequests.complete(requestKey, requestId);
				}
				setMsg(
					result.ok
						? `已提交：${String(result.text).slice(0, 160)}`
						: `失败：${String(result.text).slice(0, 160)}`,
				);
				if (result.ok) {
					setPreview(null);
					setText("");
					refreshSnap();
					setTab("batches");
				}
			} catch (error) {
				setMsg(String(error));
			}
		};

		return jsxs2("div", {}, [

			jsxs2("label", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 6 } }, [
				j("span", { style: { color: T.label2 } }, "Project"),
				j("select", {
					value: selectedProject,
					onChange: (event) => setSelectedProject(event.target.value),
					style: { minWidth: 160, padding: "5px 8px" },
				}, projectNames.map((name) => j("option", { key: name, value: name }, name))),
			]),

			j(ResizableTextBox, {

				as: "textarea",

				value: text, onChange: (e) => setText(e.target.value),

				placeholder: submitExampleForProject(selectedProject),

				"aria-label": "批次 JSON",

				minHeight: 120,

				maxHeight: "min(70vh, 640px)",

				initialHeight: 180,

				style: { fontFamily: "monospace", fontSize: 13, padding: 8 },

			}),

			jsxs2("div", { style: { margin: "6px 0" } }, [

				j("button", { onClick: doDryRun, disabled: !text.trim(), style: btn(T.brand, !text.trim()) }, "① dry-run 预览"),

				j("button", { onClick: doSubmit, disabled: !(preview?.ok && text.trim()), style: btn(T.ok, !(preview?.ok && text.trim())) }, "② 确认提交"),

				j("span", { style: { fontSize: 13, marginLeft: 8 } }, msg),

			]),

			preview && j(ResizableTextBox, {
				minHeight: 80,
				maxHeight: 480,
				initialHeight: 160,
				style: pre,
			}, preview.text),

		]);

	}



	function HistoryTab() {
		const [state, setState] = useState({ loading: true, document: null, error: "" });
		const load = useCallback(async () => {
			setState((current) => ({ ...current, loading: true, error: "" }));
			try {
				const document = await collectHistoryPages(async ({ cursor }) => {
					const query = new URLSearchParams({ limit: "200" });
					if (cursor !== null) query.set("cursor", cursor);
					const response = await authFetch(`/sched/api/history?${query}`);
					const envelope = await response.json();
					if (!response.ok || !envelope?.ok || !envelope.raw) {
						throw new Error(envelope?.text || `history HTTP ${response.status}`);
					}
					return envelope.raw;
				});
				setState({ loading: false, document, error: "" });
			} catch (error) {
				setState({ loading: false, document: null, error: String(error?.message ?? error) });
			}
		}, []);
		useEffect(() => { load(); }, [load]);
		const rows = state.document?.history ?? [];
		return jsxs2("div", {}, [
			jsxs2("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } }, [
				j("b", null, `${rows.length} loaded history rows`),
				j("button", { onClick: load, disabled: state.loading, style: ghostBtn }, state.loading ? "loading…" : "refresh"),
			]),
			state.error && j("div", { role: "alert", style: { color: T.err } }, state.error),
			!state.loading && !state.error && rows.length === 0 && j("div", null, "(no history)"),
			...rows.map((row, index) => jsxs2("div", {
				key: `${row.batch_id}:${row.task}:v${row.version}:${index}`,
				style: {
					display: "grid",
					gridTemplateColumns: "minmax(160px,2fr) minmax(90px,1fr) minmax(80px,1fr) minmax(70px,.7fr)",
					gap: 8,
					padding: "6px 8px",
					borderBottom: `1px solid ${T.border}`,
					fontSize: 13,
				},
			}, [
				j("span", { title: row.batch_id }, row.batch_name || row.batch_id),
				j("span", null, row.task),
				j("span", { style: { color: COLORS[row.status] ?? T.label2 } }, row.status),
				j("span", null, `v${row.version}`),
			])),
		]);
	}

	function AuthenticationGate({ auth, onCancel }) {
		const [token, setToken] = useState("");
		const [remember, setRemember] = useState(auth.canTrust);
		const [label, setLabel] = useState(() => {
			const platform = String(globalThis.navigator?.platform ?? "").trim();
			return platform ? `${platform} 浏览器` : "当前浏览器";
		});
		const restoring = auth.status === "idle" || auth.status === "restoring";
		const busy = restoring || auth.status === "pairing";

		useEffect(() => {
			if (!auth.canTrust) setRemember(false);
		}, [auth.canTrust]);

		useEffect(() => {
			const onKeyDown = (event) => {
				if (event.key !== "Escape") return;
				authGate.cancelPending();
				setToken("");
				onCancel();
			};
			window.addEventListener("keydown", onKeyDown);
			return () => window.removeEventListener("keydown", onKeyDown);
		}, [onCancel]);

		const submit = async (event) => {
			event.preventDefault();
			if (busy || !token.trim()) return;
			const masterToken = token;
			setToken("");
			try {
				await authGate.pair(masterToken, { remember, label, trustDays: 30 });
			} catch { /* coordinator publishes a bounded visible error */ }
		};

		const cancel = () => {
			authGate.cancelPending();
			setToken("");
			onCancel();
		};

		return jsxs2("div", { style: overlayStyle }, [
			jsxs2("div", { style: { ...panelStyle, maxWidth: 560, justifyContent: "center" } }, [
				j("form", {
					onSubmit: submit,
					style: {
						background: T.bgLayer,
						border: `1px solid ${T.border}`,
						borderRadius: 12,
						padding: 20,
						display: "flex",
						flexDirection: "column",
						gap: 12,
					},
				}, [
					j("h2", { style: { ...boardTitleStyle, fontSize: 18 } }, "连接 sched 看板"),
					j("div", { style: { color: T.label2 } }, busy
						? (restoring ? "正在验证受信设备…" : "正在创建短期访问会话…")
						: "首次连接需要粘贴一次本机主令牌。主令牌只用于本次配对，不会保存在浏览器中。"),
					auth.message && j("div", {
						role: "alert",
						style: { color: T.err, border: `1px solid ${T.err}`, borderRadius: 8, padding: "8px 10px" },
					}, auth.message),
					auth.hasTrustedDevice && !busy && j("button", {
						type: "button",
						onClick: () => { void authGate.restore({ force: true }); },
						style: btn(T.brand),
					}, "使用受信设备重新验证"),
					!busy && j("label", { style: { display: "flex", flexDirection: "column", gap: 5 } }, [
						j("span", null, "本机主令牌"),
						j("input", {
							type: "password",
							value: token,
							onChange: (event) => setToken(event.target.value),
							autoComplete: "off",
							spellCheck: false,
							placeholder: "粘贴 ~/.dsh/node-sched-access-token 的内容",
							style: { padding: "9px 10px", borderRadius: 8, border: `1px solid ${T.border}`, fontFamily: "monospace" },
						}),
					]),
					!busy && j("label", { style: { display: "flex", gap: 8, alignItems: "center" } }, [
						j("input", {
							type: "checkbox",
							checked: remember,
							disabled: !auth.canTrust,
							onChange: (event) => setRemember(event.target.checked),
						}),
						j("span", null, auth.canTrust ? "信任此浏览器 30 天（推荐）" : "此环境不支持持久设备信任"),
					]),
					!busy && remember && j("label", { style: { display: "flex", flexDirection: "column", gap: 5 } }, [
						j("span", null, "设备名称"),
						j("input", {
							value: label,
							onChange: (event) => setLabel(event.target.value),
							maxLength: 80,
							style: { padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}` },
						}),
					]),
					j("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } }, [
						j("button", { type: "button", onClick: cancel, style: ghostBtn }, "取消"),
						!busy && j("button", { type: "submit", disabled: !token.trim(), style: btn(T.brand, !token.trim()) }, remember ? "配对并打开" : "仅本次会话"),
					]),
				]),
			]),
		]);
	}

	function AuthenticationRequiredView({ auth, onClose }) {
		const [dialogOpen, setDialogOpen] = useState(false);
		const restoring = auth.status === "idle" || auth.status === "restoring";
		const statusText = restoring
			? "正在检查当前会话和受信设备。你可以继续查看页面，验证框不会自动弹出。"
			: "实时调度数据与操作需要验证；验证框只会在你主动打开时出现。";

		return jsxs2("div", { style: overlayStyle }, [
			jsxs2("div", { style: panelStyle }, [
				jsxs2("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } }, [
					j("button", {
						type: "button", onClick: onClose, style: backBtn,
						title: "返回对话", "aria-label": "返回",
					}, [
						j("span", { "aria-hidden": true, style: { fontSize: 15 } }, "\u2039"),
						j("span", null, "返回"),
					]),
					j("h2", { style: boardTitleStyle }, "sched 看板"),
					j("span", { style: { color: T.warn, fontSize: 13 } }, restoring ? "\u25cb checking" : "\u25cb 未连接"),
				]),
				jsxs2("section", {
					"aria-label": "sched 连接状态",
					style: {
						display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
						padding: "12px 14px", border: `1px solid ${T.warn}`,
						borderRadius: 10,
						background: `color-mix(in srgb, ${T.warn} 8%, transparent)`,
					},
				}, [
					jsxs2("div", { style: { flex: "1 1 320px", minWidth: 0 } }, [
						j("b", null, restoring ? "正在自动检查连接" : "sched 尚未连接"),
						j("div", { role: "status", "aria-live": "polite", style: { color: T.label2, marginTop: 2 } }, statusText),
						auth.message && j("div", { role: "alert", style: { color: T.err, marginTop: 4, overflowWrap: "anywhere" } }, auth.message),
					]),
					j("button", {
						type: "button",
						onClick: () => setDialogOpen(true),
						style: btn(T.brand),
					}, restoring ? "查看验证进度" : "打开验证"),
				]),
				j("div", { style: { color: T.label2, padding: "4px 2px" } }, "尚未连接时不会请求远程调度数据。你仍可返回对话或浏览应用的其他区域。"),
			]),
			dialogOpen && j(AuthenticationGate, { auth, onCancel: () => setDialogOpen(false) }),
		]);
	}

	function Dashboard({ onClose, visible, auth }) {

		const [stream, clearAuth] = useSchedStream(visible);
		const [openAuthPromptId, setOpenAuthPromptId] = useState(null);
		const activeAuthPrompt = stream.authQueue?.[0] ?? null;
		const activeAuthPromptId = activeAuthPrompt?.id ?? null;

		useEffect(() => {
			setOpenAuthPromptId((current) => current === activeAuthPromptId ? current : null);
		}, [activeAuthPromptId]);

		const [snap, refreshSnap] = useSnapshot("/sched/api/status", 20000);

		const [tab, setTab] = useState("batches");

		const [opMsg, setOpMsg] = useState("");
		const pendingOps = useRef(new Set());
		const [, setPendingOpsVersion] = useState(0);

		const [logTask, setLogTask] = useState(null);

		const [projFilter, setProjFilter] = useState("");

		const raw = snap?.raw;
		const mutationAvailability = schedulerMutationAvailability(snap);

		const summary = snap?.summary;

		const projects = [...new Set((raw?.batches ?? []).map((b) => b.project).filter(Boolean))];
		const jobsAll = raw?.jobs;



		const runOp = async (op, entity) => {
			const id = taskReference(entity)
				?? (Number.isInteger(entity?.idx) ? String(entity.idx) : entity?.id ?? "");
			const key = `${op}:${id}`;
			if (!mutationAvailability.writable) {
				setOpMsg(mutationAvailability.reason);
				return;
			}
			if (pendingOps.current.has(key)) return;
			pendingOps.current.add(key);
			setPendingOpsVersion((version) => version + 1);
			try {
				const request = await durableRequests.claimOperation(key, op, entity);
				const { requestId } = request;
				const result = await post("op", request);
				if (!result || typeof result !== "object") throw new Error("invalid JSON response");
				if (mutationResultIsDefinitive(result)) {
					await durableRequests.complete(key, requestId);
				}
				setOpMsg(
					`${op} ${id}: ${result.ok ? "ok" : `fail (${result.error ?? result.code})`}`
					+ (result.text ? ` — ${String(result.text).slice(0, 120)}` : ""),
				);
				refreshSnap();
			} catch (error) {
				setOpMsg(`${op} ${id}: fail (${String(error?.message ?? error).slice(0, 160)})`);
			} finally {
				pendingOps.current.delete(key);
				setPendingOpsVersion((version) => version + 1);
			}
		};

		const forgetDevice = async () => {
			try {
				await authGate.forget();
			} catch (error) {
				setOpMsg(`认证清理失败: ${String(error?.message ?? error).slice(0, 160)}`);
			}
		};



		// 批次行网格：徽章 | 名称 | 分段进度条 | 计数 | cancel —— 固定列宽对齐
		return jsxs2("div", { style: overlayStyle }, [

			jsxs2("div", { style: panelStyle }, [

				jsxs2("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } }, [

					j("button", {

						type: "button", onClick: onClose, style: backBtn,

						title: "返回对话", "aria-label": "返回",

					}, [

						j("span", { "aria-hidden": true, style: { fontSize: 15 } }, "\u2039"),

						j("span", null, "返回"),

					]),

					j("h2", { style: boardTitleStyle }, "sched 看板"),

					j("span", { style: { color: stream.connected ? T.ok : T.err, fontSize: 13 } }, stream.connected ? "\u25cf live" : "\u25cb offline"),

					j("button", { onClick: refreshSnap, style: ghostBtn }, "refresh"),

					j(ArmButton, {
						label: auth.trusted ? "忘记本设备" : "结束会话",
						confirmLabel: auth.trusted ? "确认忘记?" : "确认结束?",
						color: T.warn,
						onConfirm: forgetDevice,
					}),

					j("select", {

						value: projFilter,

						onChange: (e) => setProjFilter(e.target.value),

						style: { background: "transparent", border: `1px solid ${T.border}`, color: T.label, borderRadius: 8, padding: "5px 8px", fontSize: 13, marginRight: 4 },

					}, [

						j("option", { value: "" }, "all projects"),

						...projects.map((pr) => j("option", { key: pr, value: pr }, pr)),

					]),

					...["batches", "history", "gpus", "events", "submit", "config", "incidents", "ssh"].map((t) =>

						j("button", { key: t, onClick: () => setTab(t), style: tab === t ? btn(T.brand) : ghostBtn }, t)),

				]),

				// B24c: SSH 交互式身份验证先显示横幅，用户主动打开后才挂载弹窗。
				j(AuthPromptBanner, {
					req: activeAuthPrompt,
					pendingCount: stream.authQueue?.length ?? 0,
					onOpen: () => setOpenAuthPromptId(activeAuthPromptId),
				}),
				openAuthPromptId === activeAuthPromptId && activeAuthPrompt && j(AuthPromptModal, {
					req: activeAuthPrompt,
					onDone: (id) => {
						setOpenAuthPromptId(null);
						clearAuth(id);
					},
				}),

				opMsg && j("div", { style: { fontSize: 13, color: T.warn, marginBottom: 4 } }, opMsg),
				!mutationAvailability.writable && j("div", {
					id: "sched-read-only-reason",
					role: "alert",
					style: {
						fontSize: 13,
						color: T.warn,
						padding: "6px 10px",
						border: `1px solid ${T.warn}`,
						borderRadius: 8,
					},
				}, mutationAvailability.reason),

				tab === "batches" && jsxs2("fieldset", {
					disabled: !mutationAvailability.writable,
					"aria-describedby": "sched-read-only-reason",
					style: { border: 0, padding: 0, margin: 0, minWidth: 0 },
				}, [

					j(DaemonBar, { runOp }),

					!summary && j("div", null, "loading…"),

					summary && j(ResizableTextBox, {
						minHeight: 64,
						maxHeight: "min(45vh, 360px)",
						initialHeight: 110,
						style: pre,
					}, summary.split("\njobs:")[0]),

					raw && jsxs2("div", {}, [

					jsxs2("div", { style: { fontSize: 13, color: T.label2, marginBottom: 6 } }, [

						j("span", { style: { marginRight: 10, color: "#ef4444" } }, "■ 红=失败/取消"),

						j("span", { style: { marginRight: 10, color: "#22c55e" } }, "■ 绿=成功"),

						j("span", { style: { marginRight: 10, color: "#3b82f6" } }, "■ 蓝=运行中"),

						j("span", { style: { color: "#9ca3af" } }, "■ 灰=排队"),

					]),

					(raw.batches ?? [])

						.filter((b) => !["done", "skip", "discarded"].includes(b.status))

						.filter((b) => !projFilter || b.project === projFilter)

						.map((b) => j(BatchRow, { key: b.id ?? b.name, b, jobsAll, runOp, setLogTask })),

				]),

				]),
				tab === "history" && j(HistoryTab, { key: "tab-history" }),

				tab === "gpus" && jsxs2("fieldset", {
					key: "tab-gpus",
					disabled: !mutationAvailability.writable,
					"aria-describedby": "sched-read-only-reason",
					style: { border: 0, padding: 0, margin: 0, minWidth: 0 },
				}, [

					raw && (raw.gpus ?? []).map((g) => j(GpuRow, { key: g.idx, g, runOp })),

					!raw && j("div", null, "loading…"),

				]),

				tab === "events" && j(ResizableTextBox, {
					key: "tab-events",
					minHeight: 140,
					maxHeight: "70vh",
					initialHeight: "55vh",
					style: pre,
				}, stream.lines.join("\n") || "(no events yet)"),

				tab === "submit" && j("fieldset", {
					key: "tab-submit",
					disabled: !mutationAvailability.writable,
					"aria-describedby": "sched-read-only-reason",
					style: { border: 0, padding: 0, margin: 0, minWidth: 0 },
				}, j(SubmitTab, { post, refreshSnap, setTab })),

				tab === "config" && j("fieldset", {
					key: "tab-config",
					disabled: !mutationAvailability.writable,
					"aria-describedby": "sched-read-only-reason",
					style: { border: 0, padding: 0, margin: 0, minWidth: 0 },
				}, j(ConfigTab)),

				tab === "incidents" && j(IncidentsTab, { key: "tab-incidents" }),

				tab === "ssh" && j(SshTab, { key: "tab-ssh" }),

				logTask && j(LogViewer, { taskId: logTask, onClose: () => setLogTask(null) }),

			]),

		]);

	}

	function DashboardHost({ panel }) {
		const [visible, setVisible] = useState(panel.isOpen());
		const auth = useAuthGateState();
		const reportedOpen = useRef(false);

		useEffect(() => panel.subscribe(() => setVisible(panel.isOpen())), [panel]);
		useEffect(() => {
			if (visible) void authGate.restore();
			else authGate.cancelPending();
		}, [visible]);
		useEffect(() => {
			if (visible && auth.status === "locked" && auth.hasTrustedDevice) {
				void authGate.restore({ force: true });
			}
		}, [auth.hasTrustedDevice, auth.status, visible]);

		useEffect(() => {
			if (!visible || auth.status !== "ready" || reportedOpen.current) return;
			reportedOpen.current = true;
			authFetch("/sched/api/client-log", {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "lifecycle", detail: "view-mounted ts=" + new Date().toISOString(), ts: new Date().toISOString() }),
			}).catch(() => {});
		}, [auth.status, visible]);

		if (!visible) return null;
		if (auth.status !== "ready") {
			return j(AuthenticationRequiredView, { auth, onClose: () => panel.hide() });
		}
		return j(Dashboard, { visible: true, auth, onClose: () => panel.hide() });
	}

	// ── sidebar footer entry: button toggling the fullscreen dashboard ──────

	// ── settings card: 手风琴卡片 (收起=摘要行 / 展开=完整面板入口) ────────
	// ── settings card: 与 PluginSettingsCard 完全同构 (1:1 样式) ──────────
	function StatusCard() {
		const [open, setOpen] = useState(false);
		const auth = useAuthGateState();
		const [snap] = useSnapshot("/sched/api/status", 30000, open && auth.status === "ready");
		const raw = snap?.raw;
		const gpus = raw?.gpus ?? [];
		const batches = raw?.batches ?? [];

		// PluginSettingsCard 原始样式值 (settings-card.module.css 1:1)
		const stCard = {
			border: "1px solid var(--dsw-alias-border-l1)",
			background: open ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-bg-layer-3)",
			borderRadius: 12,
			listStyle: "none",
			transition: "border-color .16s, background .16s",
		};
		if (open) stCard.borderColor = "var(--dsw-alias-label-dimmed)";
		const stHeader = {
			appearance: "none", width: "100%", font: "inherit", color: "inherit",
			textAlign: "left", cursor: "pointer", background: "0 0", border: 0,
			borderRadius: 12, alignItems: "center", gap: 12, padding: "14px 16px",
			display: "flex",
		};
		const stHeadText = {
			flexDirection: "column", flex: 1, gap: 4, minWidth: 0, display: "flex",
		};
		const stName = {
			color: "var(--dsw-alias-label-primary)", fontSize: 15,
			fontWeight: 600, lineHeight: 1.4,
		};
		const stDesc = {
			color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: 1.5,
		};
		const stBody = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			margin: "0 16px", paddingTop: 12, paddingBottom: 8,
		};

		const act = batches.filter((b) => b.status === "active").length;
		const blk = batches.filter((b) => b.status === "blocked").length;
		const done = batches.filter((b) => ["done", "skip"].includes(b.status)).length;
		const gpuColor = { free: "#22c55e", assigned: "#3b82f6",
			releasing: "#eab308", unmanaged: "#f97316", quarantined: "#ef4444" };

		return jsxs2("div", { className: "ns-settings-card", style: stCard }, [
			j("button", {
				type: "button",
				style: stHeader,
				"aria-expanded": open,
				onClick: () => setOpen(!open),
			}, [
				jsxs2("span", { style: stHeadText }, [
					j("span", { style: stName }, "node-sched 调度器"),
					j("span", { style: stDesc }, "GPU 共享装箱 · 批量重跑 · OOM 快照"),
				]),
				// chevron (与原插件一致的 14x14 svg, 展开旋转 180deg)
				j("svg", {
					width: 14, height: 14, viewBox: "0 0 14 14",
					style: {
						color: "var(--dsw-alias-label-tertiary)", flex: "none",
						transition: "transform .16s",
						transform: open ? "rotate(180deg)" : "none",
					},
				}, [
					j("path", {
						d: "M3.5 5.25 L7 8.75 L10.5 5.25",
						stroke: "currentColor", strokeWidth: 1.5,
						fill: "none", strokeLinecap: "round", strokeLinejoin: "round",
					}),
				]),
			]),
			open && jsxs2("div", { style: stBody }, [
				jsxs2("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
					gpus.map((g) => jsxs2("span", { key: g.idx, style: {
						border: `1px solid ${gpuColor[g.status] || "var(--dsw-alias-border-l2)"}`, borderRadius: 4,
						padding: "2px 6px", fontSize: 13,
						color: gpuColor[g.status] || T.label2,
					} }, [
						j("b", { style: { marginRight: 4 } }, "GPU" + g.idx),
						g.status,
					]))),
				jsxs2("div", { style: {
					borderTop: `1px solid var(--dsw-alias-border-l2)`,
					justifyContent: "flex-end", alignItems: "center", gap: 8,
					padding: "10px 0 4px", marginTop: 8, display: "flex",
				} }, [
					j("span", { style: {
						color: "var(--dsw-alias-label-secondary)", fontSize: 13,
					} }, `批次: 活跃 ${act} \u00b7 阻塞 ${blk} \u00b7 完成 ${done}`),
					j("span", { style: { flex: 1 } }),
					j("button", {
						onClick: () => window.dispatchEvent(new CustomEvent("nodesched-open")),
						style: {
							appearance: "none", font: "inherit", cursor: "pointer",
							border: "1px solid #0000", borderRadius: 8, padding: "5px 14px",
							fontSize: 13, lineHeight: 1.5,
							background: "var(--dsw-alias-label-primary)",
							color: "var(--dsw-alias-bg-layer-3)",
						},
					}, "打开面板"),
				]),
			]),
		]);
	}


	// ── sidebar footer entry: button toggling the fullscreen dashboard ──────


	// ── B21: 侧栏入口 + 页面视图 (task-board 同构) ──────────────────────
	injectStyles();
	const disposersUI = [];

	// 面板开关控制器：纯 JS 非 React；容器保持挂载，但看板子树仅在
	// 面板打开时存在，避免隐藏看板请求令牌或启动后台轮询。
	const panel = {
		open: false,
		listeners: new Set(),
		isOpen() { return this.open; },
		subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
		emit() { for (const fn of [...this.listeners]) { try { fn(); } catch (_) {} } },
		show() {
			this.open = true;
			document.documentElement.setAttribute(ACTIVE_ATTR, "");
			document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: PANEL_NAME }));
			this.emit();
		},
		hide() {
			authGate.cancelPending();
			this.open = false;
			document.documentElement.removeAttribute(ACTIVE_ATTR);
			this.emit();
		},
		toggle() { if (this.open) this.hide(); else this.show(); },
	};

	// 页面视图：centerCol 内追加 React 永不管理的容器 + 自建 root。
	// 外壳 reconciliation 不认识这个节点所以不会驱逐它；子树由 DashboardHost 懒挂载。
	{
		let root = null, container = null;
		const ensure = () => {
			if (container !== null) return;
			try {
				const col = document.querySelector('[data-pane="conversation"], [class*="centerCol"]');
				if (!col) return;
				container = document.createElement("div");
				container.setAttribute(VIEW_ATTR, "");
				col.appendChild(container);
				root = require("react-dom/client").createRoot(container);
				root.render(j(DashboardHost, { panel }));
			} catch (e) {
				cctx.logger?.warn?.("[node-sched-ui] view mount failed:", e?.message);
			}
		};
		// 外壳启动晚于插件 apply；监听 body 直到中央列出现。
		const viewWaitObs = new MutationObserver(() => ensure());
		viewWaitObs.observe(document.body, { childList: true, subtree: true });
		ensure();

		// 兄弟面板激活 → 关闭自己；侧栏行点击 → 交还对话区 (capture 先于外壳处理)
		const onOtherActivate = (e) => { if (e.detail !== PANEL_NAME && panel.isOpen()) panel.hide(); };
		document.addEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate);
		const SIDEBAR_ROW = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]';
		const onSidebarClick = (ev) => {
			if (!panel.isOpen()) return;
			const t = ev.target;
			if (t && t.closest && t.closest(SIDEBAR_ROW)) panel.hide();
		};
		const disposeSidebarClick = listenCaptured(document, "click", onSidebarClick);

		disposersUI.push(() => {
			viewWaitObs.disconnect();
			document.removeEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate);
			disposeSidebarClick();
			document.documentElement.removeAttribute(ACTIVE_ATTR);
			try { root?.unmount(); } catch (_) {}
			container?.remove();
		});
	}

	// 侧栏入口行：纯 DOM 注入 + 双 Observer 自愈 (sidebar-entry-core 模式)。
	// 行是普通 DOM 而非 React 节点，永不干扰外壳 reconciliation；
	// 重渲染驱逐后在同一微任务内重插 (绘制前，无闪烁)。
	{
		if (document.querySelector("[" + ENTRY_ATTR + "]") === null) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.setAttribute(ENTRY_ATTR, "");
			entry.className = "nsEntry";
			entry.setAttribute("aria-label", "sched 看板");
			entry.title = "node-sched GPU/CPU 调度看板";
			entry.innerHTML = '<span class="nsEntryIcon"><svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/></svg></span><span class="nsEntryLabel">sched 看板</span>';
			entry.addEventListener("click", () => panel.toggle());

			let rootEl, placed = false;

			const sidebarRoot = () => {
				const col = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
				if (!col) return undefined;
				// 当前外壳包了一层 wrapper; logoRow 的属主才是真正的 UI root
				return col.querySelector('[class*="logoRow"]')?.parentElement ?? col.firstElementChild;
			};
			const newSessionButton = (root) => {
				const nested = root.querySelector('button[class*="newSession"]');
				if (nested) return nested;
				for (const child of root.children) if (child.tagName === "BUTTON") return child;
				return undefined;
			};
			const placeEntry = (root) => {
				const btn = newSessionButton(root);
				if (!btn) return false;
				if (entry.parentElement !== root) {
					// 锚定 New Session 所在 logoRow 之后 (workspace 浏览区之前),
					// 不依赖瞬态几何位置，重渲染后顺序稳定
					const row = btn.closest('[class*="logoRow"]');
					const base = row && row.parentElement === root ? row : btn;
					root.insertBefore(entry, base.nextElementSibling);
				}
				return true;
			};
			const tryPlace = () => {
				if (rootEl !== undefined && !rootEl.isConnected) {
					// 外壳重建了整个侧栏 pane: root observer 随旧树消亡，重新查询
					rootObs.disconnect(); rootEl = undefined; placed = false;
				}
				if (placed) {
					// 廉价短路：已挂载且仍在 DOM 中 → 只花一次 contains 检查
					if (document.body.contains(entry)) return;
					rootObs.disconnect(); rootEl = undefined; placed = false;
				}
				rootEl ??= sidebarRoot();
				if (!rootEl) return;
				placed = placeEntry(rootEl);
				if (placed) rootObs.observe(rootEl, { childList: true, subtree: true });
			};
			const waitObs = new MutationObserver(() => tryPlace());
			waitObs.observe(document.body, { childList: true, subtree: true });
			const rootObs = new MutationObserver(() => {
				if (!rootEl || !rootEl.isConnected) { placed = false; tryPlace(); return; }
				if (!rootEl.contains(entry)) placeEntry(rootEl);
			});
			// active 高亮同步 (delete 属性而非赋 undefined，避免永久高亮 bug)
			const unsubActive = panel.subscribe(() => {
				if (panel.isOpen()) entry.dataset.active = "true"; else delete entry.dataset.active;
			});
			tryPlace();

			disposersUI.push(() => { waitObs.disconnect(); rootObs.disconnect(); unsubActive(); entry.remove(); });
		}
	}

	// B25c: 渲染树异常遥测 —— 掀树根因捕获 (错误对象回传 host 落盘)
	{
		const report = (kind, detail) => {
			if (!panel.isOpen()) return;
			try {
				authFetch("/sched/api/client-log", {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ kind, detail: String(detail).slice(0, 2000), ts: new Date().toISOString() }),
				}).catch(() => {});
			} catch (_) {}
		};
		const onError = (e) => report("js-error", e.message + " @ " + (e.filename || "") + ":" + e.lineno);
		const onUnhandledRejection = (e) => report(
			"unhandled-rejection",
			e.reason && (e.reason.stack || e.reason.message) || String(e.reason),
		);
		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onUnhandledRejection);
		disposersUI.push(() => {
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onUnhandledRejection);
		});
	}

	const disposeSettings = cctx.slots.inject(SLOT_SETTINGS, () =>
		cctx.slots.register({ name: SLOT_SETTINGS, id: NS, order: 90 }, StatusCard));
	disposersUI.push(disposeSettings);
	disposersUI.push(() => authGate.dispose());
	return () => { for (const d of disposersUI) { try { d?.(); } catch (_) {} } };
}

export { name, inject, apply };
