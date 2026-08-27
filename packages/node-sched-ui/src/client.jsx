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

	blocked: T.label2, releasing: T.warn,

	failed: T.err, timed_out: T.err, unmanaged: T.err,

	cancelled: T.label2, interrupted: T.err,

	pending: T.label2, waiting_dep: T.warn, queued: T.label2,

};



// ── 样式注入（模块级一次）：侧栏入口行 + 中央列接管规则 ─────────────────

function injectStyles() {

	if (typeof document === "undefined" || document.getElementById("ns-ui-style")) return;

	const el = document.createElement("style");

	el.id = "ns-ui-style";

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

		"/* --- collapsed rail: icon-only --- */",

		"[data-sidebar-collapsed] .nsEntry { justify-content: center; padding: 0; width: 36px; height: 36px; margin: 0 auto 12px; border-radius: 50%; }",

		"[data-sidebar-collapsed] .nsEntryLabel { display: none; }",

	].join("\n");

	document.head.appendChild(el);

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

		flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8,

		maxWidth: 1280, width: "100%", margin: "0 auto",

		color: T.label, fontFamily: T.font, fontSize: 13, lineHeight: 1.55,

	};

	const bar = (pct) => ({ height: 6, background: "rgba(127,127,127,.2)", borderRadius: 3, overflow: "hidden", flex: 1, margin: "0 8px", display: "flex" });

	const barFill = (pct) => ({ height: "100%", width: `${Math.max(0, Math.min(100, pct))}%`, background: T.brand });



		const Badge = ({ s }) => j("span", { style: badge(s) }, s);



	async function post(action, body) {

		const r = await fetch(`/sched/api/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

		return r.json();

	}

	async function getText(action, params = "") {

		const r = await fetch(`/sched/api/${action}${params}`);

		return r.text();

	}



	function ArmButton({ label, confirmLabel, color, onConfirm, stopProp }) {

		const [armed, setArmed] = useState(false);

		const guard = (e) => { if (stopProp) e.stopPropagation(); };

		if (!armed) return j("button", { onClick: (e) => { guard(e); setArmed(true); }, style: btn(color) }, label);

		return j("button", { onClick: async (e) => { guard(e); setArmed(false); await onConfirm(); }, style: btn(color) }, confirmLabel ?? `${label}?`);

	}



	function TypedConfirm({ placeholder, color, onConfirm, children }) {

		const [typed, setTyped] = useState("");

		return j("span", {}, [

			j("input", { placeholder, value: typed, onChange: (e) => setTyped(e.target.value), style: { fontSize: 13, width: 150, marginRight: 4 } }),

			j("button", { disabled: typed !== placeholder, onClick: async () => { await onConfirm(); setTyped(""); }, style: btn(color, typed !== placeholder) }, children),

			j("button", { onClick: () => setTyped(""), style: ghostBtn }, "×"),

		]);

	}



	function useSchedStream() {

		const [state, setState] = useState({ lines: [], connected: false });

		useEffect(() => {

			let ws; let closed = false; let timer;

			const connect = () => {

				ws = new WebSocket(`ws://${location.host}/sched/ws/events`);

				ws.onopen = () => setState((s) => ({ ...s, connected: true }));

				ws.onmessage = (e) => {

					const m = JSON.parse(e.data);

					if (m.type === "log") setState((s) => ({ ...s, lines: [...s.lines.slice(-400), m.line] }));

			

					// B24c: SSH 2FA 质询 → 弹窗交给用户应答

					else if (m.type === "kbdint") setState((s) => ({ ...s, kbdint: m }));

				};

				ws.onclose = () => { if (!closed) timer = setTimeout(connect, 3000); setState((s) => ({ ...s, connected: false })); };

			};

			connect();

			return () => { closed = true; clearTimeout(timer); ws?.close(); };

		}, []);

		return [state];

	}



	function useSnapshot(path, ms) {

		const [data, setData] = useState(null);

		const refresh = useCallback(() => { fetch(path).then((r) => r.json()).then(setData).catch(() => {}); }, [path]);

		useEffect(() => { refresh(); const t = setInterval(refresh, ms); return () => clearInterval(t); }, [refresh]);

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

				j("pre", { style: { ...pre, maxHeight: "60vh", overflow: "auto" } }, text),

			]),

		]);

	}



	// ── B23 组件：依赖 apply 作用域的 j/hooks/T/btn ──

	// B24c: SSH 2FA 质询弹窗 —— 用户输入动态码回传引擎，连接继续握手

	function KbdintModal({ req }) {

		const [code, setCode] = useState("");

		const [busy, setBusy] = useState(false);

		// 已处理过的质询 id：本地关窗（WS 帧不会撤回，需自行记住）

		const [dismissedId, setDismissedId] = useState(null);

		useEffect(() => { setCode(""); setBusy(false); }, [req?.id]);

		if (!req || dismissedId === req.id) return null;

		const sendAnswer = async (answer) => {

			if (busy) return;

			setBusy(true);

			try {

				await fetch("/sched/ssh/2fa-answer", {

					method: "POST", headers: { "content-type": "application/json" },

					body: JSON.stringify({ id: req.id, answer }),

				});

			} catch { /* 引擎侧超时/过期会以连接失败形式呈现 */ }

			setDismissedId(req.id); // 无论成败，本地质询已了结 → 关窗

		};

		const submit = async () => {

			if (!code.trim() || busy) return;

			await sendAnswer({ kind: "code", code: code.trim() });

		};

		// 取消：通知引擎立即放弃本次握手，并本地关窗

		const cancel = async () => {

			await sendAnswer({ kind: "cancel" });

		};

		return j("div", { style: {

			position: "fixed", inset: 0, zIndex: 11000,

			background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center",

		} }, [

			jsxs2("div", { style: {

				background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))",

				border: `1px solid ${T.border2}`, borderRadius: 12, padding: 18,

				width: "min(400px, 92vw)", display: "flex", flexDirection: "column", gap: 10,

				boxShadow: "0 18px 60px rgba(0,0,0,.45)", color: T.label, fontFamily: T.font,

			} }, [

				jsxs2("div", { style: { display: "flex", gap: 8, alignItems: "center" } }, [

					j("b", { style: { fontSize: 14 } }, "SSH 双因子验证"),

					j("span", { style: { color: T.brand, fontWeight: 700, fontSize: 13 } }, req.alias),

				]),

				j("div", { style: { fontSize: 13, color: T.label2 } },

					`${req.prompt || "Verification code:"} —— 请输入验证器 App 当前动态码`),

				jsxs2("div", { style: { display: "flex", gap: 8 } }, [

					j("input", {

						autoFocus: true,

						value: code,

						onChange: (e) => setCode(e.target.value),

						onKeyDown: (e) => { if (e.key === "Enter") submit(); },

						placeholder: "动态码 / 验证码",

						style: { flex: 1, padding: "7px 10px", fontSize: 14, fontFamily: T.font,

							border: `1px solid ${T.border2}`, borderRadius: 8, outline: "none",

							color: T.label, background: "var(--dsw-alias-bg-base)" },

					}),

					j("button", { onClick: submit, disabled: !code.trim() || busy, style: btn(T.ok, !code.trim() || busy) },

						busy ? "\u63d0\u4ea4\u4e2d\u2026" : "\u786e\u8ba4"),

					j("button", { onClick: cancel, disabled: busy, title: "放弃本次连接", style: { ...ghostBtn, flexShrink: 0 } }, "\u53d6\u6d88"),

				]),

				j("div", { style: { fontSize: 13, color: T.label2 } }, "180 秒内未提交将自动放弃本次连接"),

			]),

		]);

	}



	function SshTab() {

		const [hosts, setHosts] = useState(null);

		const [busy, setBusy] = useState("");

		const [msg, setMsg] = useState("");

		const [confirmAlias, setConfirmAlias] = useState(null);

		const [termAlias, setTermAlias] = useState(null);



		const [binding, setBinding] = useState(null); // {alias, mode, sshEntry}

		const load = useCallback(async () => {

			try {

				const [h, b] = await Promise.all([

					fetch("/sched/ssh/hosts").then((r) => r.json()),

					fetch("/sched/ssh/binding").then((r) => r.json()),

				]);

				setHosts(h.hosts ?? []);

				setBinding(b);

			} catch { setHosts([]); }

		}, []);

		useEffect(() => { load(); }, [load]);



		// B24: 绑定/解绑 sched 主机（诚实反馈：主机必须可达；daemon 状态仅提示）

		const doBind = async (alias) => {

			setBusy("bind:" + alias);

			try {

				const r = await fetch("/sched/ssh/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias }) }).then((r) => r.json());

				if (r.ok) setMsg(`✅ ${alias} 已设为 SCHED 主机 (${r.latencyMs}ms) · daemon: ${r.probeText || "?"}`);

				else setMsg(`绑定失败: ${r.error}`);

				await load();

			} catch (e) { setMsg("绑定失败: " + e.message); }

			setBusy("");

		};

		const doUnbind = async () => {

			setBusy("unbind");

			try {

				await fetch("/sched/ssh/unbind", { method: "POST" });

				setMsg(`已解绑，回到 CLI 模式 (sshEntry: ${binding?.sshEntry ?? "?"})`);

				await load();

			} catch (e) { setMsg("解绑失败: " + e.message); }

			setBusy("");

		};



		const doImport = async () => {

			setBusy("import");

			try {

				const r = await fetch("/sched/ssh/import", { method: "POST" }).then((r) => r.json());

				setMsg(r.result ? `导入完成: 解析 ${r.result.parsed} / 新增 ${r.result.added} / 跳过 ${r.result.skipped}` : `失败: ${r.error}`);

				await load();

			} catch (e) { setMsg("失败: " + e.message); }

			setBusy("");

		};

		const doTest = async (alias) => {

			setBusy("test:" + alias);

			try {

				const r = await fetch("/sched/ssh/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias }) }).then((r) => r.json());

				setMsg(r.ok ? `${alias}: ok (${r.latencyMs}ms)` : `${alias}: 失败 — ${r.error ?? "unreachable"}`);

			} catch (e) { setMsg("失败: " + e.message); }

			setBusy("");

		};

		const doDelete = async (alias) => {

			setBusy("del:" + alias);

			try {

				await fetch(`/sched/ssh/hosts?alias=${encodeURIComponent(alias)}`, { method: "DELETE" });

				setConfirmAlias(null);

				await load();

			} catch (e) { setMsg("失败: " + e.message); }

			setBusy("");

		};



		if (termAlias) return j(SshTerminal, { alias: termAlias, onClose: () => { setTermAlias(null); } });



		return jsxs2("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, [

			// B24: SCHED 绑定状态条

			jsxs2("div", { style: { display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", background: binding?.mode === "engine" ? `color-mix(in srgb, ${T.ok} 10%, transparent)` : T.bgLayer, borderRadius: 10, border: `1px solid ${binding?.mode === "engine" ? `color-mix(in srgb, ${T.ok} 30%, transparent)` : T.border}` } }, [

				j("span", { style: { fontSize: 13, fontWeight: 700 } }, "SCHED"),

				j("span", {

					style: { fontSize: 13, color: binding?.mode === "engine" ? T.ok : T.label2, fontWeight: binding?.mode === "engine" ? 700 : 400 },

				}, binding?.mode === "engine"

					? `→ ${binding.alias}（引擎模式，连接池复用）`

					: `→ sshEntry ${binding?.sshEntry ?? "?"}（CLI 模式）`),

				j("span", { style: { flex: 1 } }),

				binding?.mode === "engine" && j("button", { onClick: doUnbind, disabled: !!busy, title: "回到传统 ssh CLI 模式", style: ghostBtn },

					busy === "unbind" ? "解绑中…" : "解绑"),

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

			hosts !== null && jsxs2("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, [

				...hosts.map((h) => {

					const boundHere = binding?.alias === h.alias;

					return jsxs2("div", {

						key: h.alias,

						style: {

							display: "flex", alignItems: "center", gap: 12,

							padding: "8px 12px", borderRadius: 10,

							border: `1px solid ${boundHere ? `color-mix(in srgb, ${T.ok} 35%, transparent)` : T.border}`,

							background: boundHere ? `color-mix(in srgb, ${T.ok} 7%, transparent)` : "transparent",

						},

					}, [

						// 左：身份区（一行一条 ssh 配置）

						j("span", { style: { fontWeight: 700, fontSize: 13, flexShrink: 0 } }, h.alias),

						boundHere && j("span", { style: { color: T.ok, fontWeight: 700, fontSize: 13, border: `1px solid ${T.ok}`, borderRadius: 999, padding: "1px 8px", flexShrink: 0 } }, "SCHED"),

						j("span", { style: { color: T.label2, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } }, [

							h.user !== "root" ? `${h.user}@${h.host}` : h.host,

							`:${h.port}`,

							h.auth === "key" ? (h.keyReady ? " · 🔑" : " · ⚠key缺失") : h.auth === "agent" ? " · agent" : " · 密码",

							(h.proxyJump && h.proxyJump.length > 0) ? ` · via ${h.proxyJump.join(">")}` : "",

							h.description ? ` · ${h.description}` : "",

						].join("")),

						// 右：操作区

						boundHere

							? j("span", { key: "sb", style: { color: T.ok, fontWeight: 700, fontSize: 13, flexShrink: 0 } }, "✔ 数据源")

							: j("button", { key: "bnd", onClick: () => doBind(h.alias), disabled: !!busy, title: "设为 sched 数据源主机（引擎模式，看板数据直连该机）", style: { ...ghostBtn, color: T.brand, borderColor: `color-mix(in srgb, ${T.brand} 45%, transparent)`, flexShrink: 0 } },

								busy === "bind:" + h.alias ? "绑定中…" : "设为SCHED"),

						j("button", { key: "o", onClick: () => setTermAlias(h.alias), title: "打开网页终端", style: { ...ghostBtn, flexShrink: 0 } }, "终端"),

						confirmAlias === h.alias

							? j("button", { key: "c", onClick: () => doDelete(h.alias), style: { ...btn(T.err), flexShrink: 0 } }, "确认删除")

							: j("button", { key: "t", onClick: () => doTest(h.alias), disabled: !!busy, title: "连通性测试", style: { ...ghostBtn, flexShrink: 0 } },

								busy === "test:" + h.alias ? "…" : "测试"),

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

	function SshTerminal({ alias, onClose }) {

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

				ws = new WebSocket(`${proto}${location.host}/sched/ws/ssh-terminal?alias=${encodeURIComponent(alias)}&cols=${term.cols}&rows=${term.rows}`);

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

			})();

			return () => {

				disposed = true;

				try { ro?.disconnect(); } catch { /* gone */ }

				try { ws?.close(); } catch { /* gone */ }

				try { term?.dispose(); } catch { /* gone */ }

			};

		}, [alias]);

		return jsxs2("div", { style: { display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 } }, [

			jsxs2("div", { style: { display: "flex", gap: 10, alignItems: "center" } }, [

				j("button", { onClick: onClose, style: backBtn, title: "返回主机列表" }, [

					j("span", { "aria-hidden": true, style: { fontSize: 15 } }, "\u2039"),

					j("span", null, "返回"),

				]),

				j("h3", { style: { ...boardTitleStyle, fontSize: 14 } }, `终端 · ${alias}`),

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



	// 任务按状态分类计数 → 分段条（红=出错 绿=成功 蓝=运行中 灰=排队/取消）

	function taskSegments(tasks) {

		const seg = { bad: 0, ok: 0, run: 0, off: 0 };

		for (const t of tasks) {

			if (["failed", "timed_out"].includes(t.status)) seg.bad++;

			else if (["done", "skip"].includes(t.status)) seg.ok++;

			else if (t.status === "running") seg.run++;

			else seg.off++;

		}

		return seg;

	}

	const SEG_COLOR = { bad: "#ef4444", ok: "#22c55e", run: "#3b82f6", off: "#9ca3af" };



	// B25/B25b: 离散任务段 —— 一段一任务, 颜色即状态。每行段数由中列实际

	// 宽度自适应决定 (flex wrap): 窗口宽 → 一行多段, 窗口窄 → 自动减段换行。

	// 超过 MAX_VISIBLE 段截断并显示 "+N"（168 任务全画会淹没列表）。

	const SEG_MAX_VISIBLE = 30;

	function TaskSegments({ tasks }) {

		if (!tasks || !tasks.length) return null;

		const colorOf = (st) =>

			["failed", "timed_out"].includes(st) ? SEG_COLOR.bad :

			["done", "skip"].includes(st) ? SEG_COLOR.ok :

			st === "running" ? SEG_COLOR.run : SEG_COLOR.off;

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

						background: colorOf(t.status), display: "inline-block",

						cursor: "default" },

				})),

			tasks.length > SEG_MAX_VISIBLE && j("span", {

				style: { fontSize: 12, color: T.label2, alignSelf: "center" },

			}, `+${tasks.length - SEG_MAX_VISIBLE}`),

		]);

	}



	function BatchRow({ b, jobsAll, runOp, setLogTask }) {

		const [open, setOpen] = useState(false);

		const tasks = (jobsAll ?? []).filter(

			(x) => x.batch === b.id,

		);

		const failedTasks = tasks.filter((x) => ["failed", "timed_out", "cancelled"].includes(x.status));

		const seg = taskSegments(tasks);



		return jsxs2("div", { style: { marginBottom: 10 } }, [

			jsxs2("div", { style: { ...GRID, alignItems: "start" }, onClick: () => setOpen(!open) }, [

				j("span", { style: { textAlign: "center", cursor: "pointer", lineHeight: "15px" } }, Badge({ s: b.status })),

				jsxs2("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer", lineHeight: "15px" }, onClick: (e) => { e.stopPropagation(); setOpen(!open); } }, [

				j("b", { style: { fontSize: 13 }, title: b.name }, b.name),

				b.project && j("span", { style: { fontSize: 11, color: T.label2, marginLeft: 6 } }, b.project),

			]),

				j(TaskSegments, { tasks }),

				j("span", { style: { fontSize: 12.5, color: T.label2, textAlign: "right", lineHeight: "15px" } }, b.progress ?? ""),

				j(ArmButton, { label: "cancel", confirmLabel: "cancel(取消任务!)", color: T.err, stopProp: true,

				onConfirm: () => runOp("cancel", b.name) }),

			]),

			open && jsxs2("div", { style: { marginTop: 6, marginLeft: 76, paddingLeft: 10, borderLeft: `2px solid ${T.border}` } }, [

				b.depends_on?.length > 0 && j("div", { style: { fontSize: 12, color: T.label2 } }, `依赖: ${b.depends_on.join(", ")}`),

				...tasks.filter((t) => ["failed", "timed_out", "cancelled"].includes(t.status)).map((t) =>

					jsxs2("div", { style: { fontSize: 13, marginLeft: 14, marginTop: 2, display: "flex", alignItems: "center" } }, [

						j("span", { style: { fontFamily: "monospace", cursor: "pointer", textDecoration: "underline", marginRight: 6 }, onClick: () => setLogTask(`${t.batch}:${t.task}`), title: "查看日志" }, t.task),

						Badge({ s: t.status }),

						t.retries != null && j("span", { style: { color: T.label2, marginRight: 4 } }, `retries=${t.retries}`),

						j("span", { style: { flex: 1 } }),

						j("button", { onClick: () => runOp("retry", `${t.batch}:${t.task}`), style: btn(T.brand) }, "retry"),

						j(ArmButton, { label: "resubmit", confirmLabel: "resubmit(删产物!)", color: T.warn, onConfirm: () => runOp("resubmit", `${t.batch}:${t.task}`) }),

					])),

			]),

		]);

	}



	function GpuRow({ g, runOp }) {

		return jsxs2("div", { style: { marginBottom: 6, display: "flex", alignItems: "center" } }, [

			Badge({ s: g.status }),

			j("span", { style: { fontFamily: "monospace", marginRight: 8 } }, `GPU${g.idx}`),

			g.job && j("span", { style: { fontSize: 12, marginRight: 8, color: T.label2, flex: 1 } }, g.job),

			g.quarantined && j("span", { style: { color: T.err, marginRight: 8, fontSize: 12 } }, "[quarantined]"),

			!g.job && g.status === "free" && j("span", { style: { flex: 1 } }),

			g.status === "unmanaged" && j(ArmButton, { label: "gpu-free 强制回收", confirmLabel: "确认回收?", color: T.warn,

				onConfirm: () => runOp("gpu-free", String(g.idx)) }),

			g.quarantined && j("button", { onClick: () => runOp("gpu-ok", String(g.idx)), style: btn(T.ok) }, "gpu-ok 解除隔离"),

		]);

	}



	function DaemonBar({ runOp }) {

		const [status, setStatus] = useState(null);      // 上次成功查询的状态文本（保留不清空）

		const [querying, setQuerying] = useState(true);  // 是否正在查询

		const [confirmStop, setConfirmStop] = useState(false);

		const [channel, setChannel] = useState(null);    // B24f: 生效通道 {alias, mode, sshEntry}

		const load = useCallback(() => {

			setQuerying(true);

			fetch("/sched/api/daemon").then((r) => r.json()).then((d) => {

				if (d.ok) setStatus(d.text);

				else setStatus((prev) => prev ?? ("查询失败: " + String(d.text ?? "").slice(0, 80)));

				setQuerying(false);

			}).catch(() => { setQuerying(false); }); // 失败保留上次值

			// 只读通道徽章：单一事实来源在 ssh tab 的绑定状态条，这里仅展示

			fetch("/sched/api/entry").then((r) => r.json()).then(setChannel).catch(() => {});

		}, []);

		useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

		const running = status != null && status.includes("运行中");

		return jsxs2("div", { style: { marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center" } }, [

			// B24f: 只读通道徽章 —— 连接控制唯一入口在 ssh tab

			j("span", {

				title: "\u8fde\u63a5\u901a\u9053\u5728 ssh \u9875\u7ba1\u7406",

				style: { fontSize: 13, padding: "2px 8px", borderRadius: 999, flexShrink: 0,

					color: channel?.mode === "engine" ? T.ok : T.label2,

					border: `1px solid ${channel?.mode === "engine" ? `color-mix(in srgb, ${T.ok} 35%, transparent)` : T.border}`,

					background: channel?.mode === "engine" ? `color-mix(in srgb, ${T.ok} 8%, transparent)` : "transparent",

					marginRight: 8, whiteSpace: "nowrap" },

			}, channel?.mode === "engine" ? `\u26a1 ${channel.alias}` :

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

					: j("button", { key: "s", onClick: async () => { await runOp("daemon-start"); setTimeout(load, 3000); }, style: btn(T.ok) }, "start"),

				running

					? (!confirmStop && j("button", { key: "x", onClick: () => setConfirmStop(true), style: btn(T.err) }, "stop"))

					: j("button", { key: "x", disabled: true, title: "未运行", style: btn(T.err, true) }, "stop"),

			]),

			confirmStop && j(TypedConfirm, {

				placeholder: "输入 stop 确认（会取消未完成任务）", color: T.err,

				onConfirm: async () => { await runOp("daemon-stop"); setConfirmStop(false); },

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

		// B19 调试: 追踪所有 detail 写入的调用栈 (临时)

		const setDetailT = (v, tag) => {

			console.log("[inc-detail写] tag=" + (tag || "?") + " val=" +

				JSON.stringify(v && v.id ? { id: v.id, loading: !!v.loading } : v),

				new Error().stack.split("\n").slice(2, 6).join("\n    "));

			setDetail(v);

		};



		const applyList = (incidents) => {

			setList(incidents);

			INC_CACHE = { list: incidents };

		};

		const applyDetail = (inc) => {

			console.log("[inc-detail写] tag=applyDetail id=" + inc.id,

				new Error().stack.split("\n").slice(2, 5).join("\n    "));

			setDetail(inc);

			INC_OPEN_ID = inc.id;

			INC_DETAIL = INC_DETAIL || {};

			INC_DETAIL[inc.id] = inc;

		};



		const openDetail = useCallback(async (id) => {

			const gen = ++INC_VIEW_GEN;

			setDetailT({ id, loading: true }, "view-loading");

			INC_OPEN_ID = id;

			try {

				const r = await fetch(`/sched/api/incidents?id=${id}`);

				const d = await r.json();

				const inc = JSON.parse(d.text).incident;

				// 先写模块缓存 (跨重挂载存活 —— 水合时可原样恢复展开态)

				INC_DETAIL = { ...(INC_DETAIL || {}), [inc.id]: inc };

				// UI 更新带代数守卫: 已收起/切换则只留缓存不改界面

				if (gen !== INC_VIEW_GEN || INC_OPEN_ID !== inc.id) return;

				setDetailT(inc, "applyDetail");

			} catch (e) { setDetailT({ id, error: String(e) }, "view-catch"); }

		}, []);



		const load = useCallback(async () => {

			try {

				const r = await fetch("/sched/api/incidents?limit=30");

				const d = await r.json();

				if (!d.ok) { setMsg("❌ " + (d.text || "").slice(0, 120)); return; }

				applyList(JSON.parse(d.text).incidents || []);

				setFrozenAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));

			} catch (e) { setMsg("❌ " + String(e)); }

		}, []);



		useEffect(() => { load(); }, [load]);

		// B19: 不在挂载时自动恢复展开详情 —— 外壳周期性重挂载会把已收起的

		// 详情反复"复活"(用户实测自动展开)。重进本页只看最新列表冻结态,

		// 详情需要时点行展开。



		if (!list) return j("div", { style: { color: T.label2, fontSize: 13 } },

			msg || (INC_CACHE ? "" : "loading…"));



		const p = detail && !detail.loading && !detail.error ? detail.payload || {} : null;

		// B19 调试: 展开态渲染打点 —— 若无写入日志却出现此行, 问题在渲染/水合层

		if (p && (!INC_DETAIL || !(INC_DETAIL[detail.id]))) {

			console.log("[inc] ⚠️ 渲染了展开态但模块缓存中无此条目 id=" + detail.id,

				"(水合丢失或外部写入)");

		}

		const failed = p ? p.failed || {} : {};

		const mem = p ? p.memory || {} : {};



		return jsxs2("div", { style: { fontSize: 13 } }, [

			jsxs2("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6,

				padding: "5px 8px", borderRadius: 6, background: T.bgLayer,

				border: `1px solid ${T.border}` } }, [

				j("span", { style: { color: T.warn } }, "⏸ 冻结"),

				j("span", { style: { color: T.label2 } },

					`快照时间 ${frozenAt || "…"} —— 阅读期间内容不变。点「刷新」或切走再回来获取最新。`),

				j("span", { style: { flex: 1 } }),

				j("button", { onClick: () => load(), style: btn(T.brand) }, "刷新"),

			]),

			list.length === 0 && j("div", { style: { color: T.label2 } },

				"暂无事故快照 (OOM/gpu_fault 发生时自动采集)"),

			list.map((r) => jsxs2("div", {

				key: r.id,

				onClick: () => openDetail(r.id),

				style: { display: "flex", gap: 8, padding: "4px 6px", cursor: "pointer",

					borderRadius: 4, background: detail && detail.id === r.id ? T.bgLayer : "transparent" },

			}, [

				j("span", { style: { width: 30, color: T.label2 } }, "#" + r.id),

				j("span", { style: { width: 130, color: T.label } }, r.ts),

				j("span", { style: { width: 70, color: r.kind === "oom" ? T.err : T.warn } }, r.kind),

				j("span", { style: { width: 36 } }, "gpu" + (r.gpu_idx ?? "-")),

				j("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },

					r.job_id),

			])),

			detail && !detail.loading && !detail.error && jsxs2("div", {

				style: { border: `1px solid ${T.border}`, borderRadius: 6, padding: 8, marginTop: 8 } }, [

				jsxs2("div", { style: { marginBottom: 4 } }, [

					j("span", { style: { fontWeight: 600, color: T.brand } },

						`#${detail.id} ${detail.kind} @ gpu${detail.gpu_idx ?? "-"}`),

					j("button", { onClick: () => { INC_VIEW_GEN++; setDetailT(null, "collapse"); INC_OPEN_ID = null; },

						style: { ...ghostBtn, marginLeft: 8 } }, "收起"),

				]),

				j("div", { style: { color: T.label2, fontSize: 12, marginBottom: 4 } },

					`${detail.ts} · job ${detail.job_id} · batch ${detail.batch_id}`),

				failed.dispatch_mode && j("div", {},

					`派发方式: ${failed.dispatch_mode} · 声明 ${failed.declared_vram_gib ?? "-"} GiB · 历史峰值 ${failed.profile_peak_gib ?? "-"}`),

				mem.packed_sum_gib !== undefined && j("div", {},

					`显存: cap=${mem.cap_gib ?? "?"} packed=${mem.packed_sum_gib} actual=${mem.actual_used_gib ?? "?"}${mem.degraded ? " [降级]" : ""}`),

				(mem.external_pids || []).length > 0 && jsxs2("div", { style: { color: T.warn } },

					["外部进程: ", ...(mem.external_pids || []).map((e) =>

						j("span", { key: e.pid }, `pid${e.pid}(${e.mem_mib ?? "?"}MiB) `))]),

				(p.co_runners || []).length > 0 && jsxs2("div", {}, [

					j("div", { style: { color: T.label2, marginTop: 4 } }, "同卡邻居:"),

					...p.co_runners.map((c) => j("div", { key: c.job_id, style: { paddingLeft: 10 } },

						`${c.task} [${c.status}] declared=${c.declared_vram_gib} peak=${c.profile_peak_gib} runtime=${c.runtime_sec}s`)),

				]),

				(detail.verdicts || []).length > 0 && jsxs2("div", { style: { marginTop: 6 } }, [

					j("div", { style: { color: T.warn, fontWeight: 600 } }, "判读假设:"),

					...detail.verdicts.map((v, i2) => j("div", { key: i2, style: { color: T.warn, paddingLeft: 10 } }, "? " + v)),

				]),

				p.log_excerpt && jsxs2("div", {}, [

					j("div", { style: { color: T.label2, marginTop: 6 } }, "日志摘录:"),

					j("pre", { style: { ...pre, maxHeight: 120, margin: "2px 0" } }, p.log_excerpt),

				]),

			]),

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

			fetch("/sched/api/config").then((r) => r.json()).then((d) => {

				if (!d.ok) { setMsg("❌ 加载失败: " + (d.text || "").slice(0, 120)); return; }

				const parsed = JSON.parse(d.text);

				CFG_CACHE = { cfg: parsed, text: d.text };

				setCfg(parsed);

				setCfgText(d.text);

				setMsg("");

			}).catch(() => setMsg("❌ 加载异常"));

		}, []);

		useEffect(() => {

			fetch("/sched/api/client-log", {

				method: "POST", headers: { "content-type": "application/json" },

				body: JSON.stringify({ kind: "lifecycle", detail: "config-mount ts=" + new Date().toISOString() + " cache=" + (CFG_CACHE ? "hit" : "miss"), ts: new Date().toISOString() }),

			}).catch(() => {});

			load();

		}, []);

		if (!cfg) return j("div", { style: { color: T.label2, fontSize: 13 } }, msg || "loading config…");



		const upd = (fn) => setCfg((c) => { const n = JSON.parse(JSON.stringify(c)); fn(n); return n; });



		async function save(patch) {

			setMsg("保存中…");

			try {

				const r = await fetch("/sched/api/config/set", {

					method: "POST", headers: { "Content-Type": "application/json" },

					body: JSON.stringify({ patch }),

				});

				const d = await r.json();

				setMsg((d.ok ? "✅ " : "❌ ") + (d.text || "").split("\n")[0]);

				if (d.ok) load();

			} catch (e) { setMsg("❌ " + e); }

		}



		const numInput = (value, onChange, style) => j("input", {

			value: value ?? "", onChange: (e) => onChange(e.target.value === "" ? null : Number(e.target.value)),

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

				j("input", { value: cfg.co_locate_safety ?? 0.7,

					onChange: (e) => upd((n) => { n.co_locate_safety = Number(e.target.value); }),

					style: { width: 50, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, fontSize: 13 } }),

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

			advanced && j("textarea", {

				value: cfgText, onChange: (e) => setCfgText(e.target.value),

				style: { width: "100%", minHeight: 200, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 6, fontSize: 13, fontFamily: "monospace", padding: 6 },

			}),

			msg && j("div", { style: { fontSize: 13, marginTop: 6, color: msg.startsWith("✅") ? T.ok : T.warn } }, msg),

		]);

	}



	function SubmitTab({ post, refreshSnap, setTab }) {

		const [text, setText] = useState("");

		const [preview, setPreview] = useState(null);

		const [msg, setMsg] = useState("");

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

				const r = await post("submit", { content: text });

				setMsg(r.ok ? `已提交：${String(r.text).slice(0, 160)}` : `失败：${String(r.text).slice(0, 160)}`);

				if (r.ok) { setPreview(null); setText(""); refreshSnap(); setTab("batches"); }

			} catch (e) { setMsg(String(e)); }

		};

		return jsxs2("div", {}, [

			j("textarea", {

				value: text, onChange: (e) => setText(e.target.value),

				placeholder: '粘贴 batch.json，例如 {"schema_version":1,"name":"my_batch","tasks":[{"id":"t1","cmd":["{VENV:k}","..."],"duration_min":5}]}（venv 别名见远端 config.venvs，当前为 k）',

				style: { width: "100%", height: 150, fontFamily: "monospace", fontSize: 13 },

			}),

			jsxs2("div", { style: { margin: "6px 0" } }, [

				j("button", { onClick: doDryRun, disabled: !text.trim(), style: btn(T.brand, !text.trim()) }, "① dry-run 预览"),

				j("button", { onClick: doSubmit, disabled: !(preview?.ok && text.trim()), style: btn(T.ok, !(preview?.ok && text.trim())) }, "② 确认提交"),

				j("span", { style: { fontSize: 13, marginLeft: 8 } }, msg),

			]),

			preview && j("pre", { style: { ...pre, maxHeight: 240, overflow: "auto" } }, preview.text),

		]);

	}



	function Dashboard({ onClose }) {

		const [stream] = useSchedStream();

		const [snap, refreshSnap] = useSnapshot("/sched/api/status", 20000);

		const [tab, setTab] = useState("batches");

		const [opMsg, setOpMsg] = useState("");

		const [logTask, setLogTask] = useState(null);

		const [projFilter, setProjFilter] = useState("");

		const raw = snap?.raw;

		const summary = snap?.summary;

		const projects = [...new Set((raw?.batches ?? []).map((b) => b.project).filter(Boolean))];
		const jobsAll = raw?.jobs;



		const runOp = async (op, id) => {

			const r = await post("op", { op, id });

			setOpMsg(`${op} ${id ?? ""}: ${r.ok ? "ok" : `fail (${r.error ?? r.code})`} ${r.text ? "— " + String(r.text).slice(0, 120) : ""}`);

			refreshSnap();

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

					j("select", {

						value: projFilter,

						onChange: (e) => setProjFilter(e.target.value),

						style: { background: "transparent", border: `1px solid ${T.border}`, color: T.label, borderRadius: 8, padding: "5px 8px", fontSize: 13, marginRight: 4 },

					}, [

						j("option", { value: "" }, "all projects"),

						...projects.map((pr) => j("option", { key: pr, value: pr }, pr)),

					]),

					...["batches", "gpus", "events", "submit", "config", "incidents", "ssh"].map((t) =>

						j("button", { key: t, onClick: () => setTab(t), style: tab === t ? btn(T.brand) : ghostBtn }, t)),

				]),

				// B24c: SSH 2FA 动态码弹窗（引擎质询桥接到看板）

				j(KbdintModal, { req: stream.kbdint }),

				opMsg && j("div", { style: { fontSize: 13, color: T.warn, marginBottom: 4 } }, opMsg),

				tab === "batches" && jsxs2("div", null, [

					j(DaemonBar, { runOp }),

					!summary && j("div", null, "loading…"),

					summary && j("pre", { style: { ...pre, maxHeight: 110, overflow: "auto" } }, summary.split("\njobs:")[0]),

					raw && jsxs2("div", {}, [

					jsxs2("div", { style: { fontSize: 13, color: T.label2, marginBottom: 6 } }, [

						j("span", { style: { marginRight: 10, color: "#ef4444" } }, "■ 红=出错"),

						j("span", { style: { marginRight: 10, color: "#22c55e" } }, "■ 绿=成功"),

						j("span", { style: { marginRight: 10, color: "#3b82f6" } }, "■ 蓝=运行中"),

						j("span", { style: { color: "#9ca3af" } }, "■ 灰=排队/取消"),

					]),

					(raw.batches ?? [])

						.filter((b) => !["done", "skip", "discarded"].includes(b.status))

						.filter((b) => !projFilter || b.project === projFilter)

						.map((b) => j(BatchRow, { key: b.id ?? b.name, b, jobsAll, runOp, setLogTask })),

				]),

				]),

				tab === "gpus" && jsxs2("div", { key: "tab-gpus" }, [

					raw && (raw.gpus ?? []).map((g) => j(GpuRow, { key: g.idx, g, runOp })),

					!raw && j("div", null, "loading…"),

				]),

				tab === "events" && j("pre", { key: "tab-events", style: { ...pre, maxHeight: "55vh", overflow: "auto" } }, stream.lines.join("\n") || "(no events yet)"),

				tab === "submit" && j(SubmitTab, { key: "tab-submit", post, refreshSnap, setTab }),

				tab === "config" && j(ConfigTab, { key: "tab-config" }),

				tab === "incidents" && j(IncidentsTab, { key: "tab-incidents" }),

				tab === "ssh" && j(SshTab, { key: "tab-ssh" }),

				logTask && j(LogViewer, { taskId: logTask, onClose: () => setLogTask(null) }),

			]),

		]);

	}

	// ── sidebar footer entry: button toggling the fullscreen dashboard ──────

	// ── settings card: 手风琴卡片 (收起=摘要行 / 展开=完整面板入口) ────────
	// ── settings card: 与 PluginSettingsCard 完全同构 (1:1 样式) ──────────
	function StatusCard() {
		const [open, setOpen] = useState(false);
		const [snap] = useSnapshot("/sched/api/status", 30000);
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

	// 面板开关控制器：纯 JS 非 React；视图显隐由 <html> data 属性驱动，
	// 对话子树保持挂载有状态，切换零成本。
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
		hide() { this.open = false; document.documentElement.removeAttribute(ACTIVE_ATTR); this.emit(); },
		toggle() { if (this.open) this.hide(); else this.show(); },
	};

	// 页面视图：centerCol 内追加 React 永不管理的容器 + 自建 root。
	// 外壳 reconciliation 不认识这个节点所以不会驱逐它；显隐纯 CSS。
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
				root.render(j(Dashboard, { onClose: () => panel.hide() }));
				console.log("[node-sched-ui] ✅ Dashboard mounted into container");
				setTimeout(() => {
					const html = container.innerHTML;
					console.log("[node-sched-ui] container innerHTML length:", html.length,
						"| first 200:", html.slice(0, 200));
				}, 100);
				try {
					fetch("/sched/api/client-log", {
						method: "POST", headers: { "content-type": "application/json" },
						body: JSON.stringify({ kind: "lifecycle", detail: "view-mounted ts=" + new Date().toISOString(), ts: new Date().toISOString() }),
					}).catch(() => {});
				} catch (_) {}
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
		document.addEventListener("click", onSidebarClick, true);

		disposersUI.push(() => {
			viewWaitObs.disconnect();
			document.removeEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate);
			document.removeEventListener("click", onSidebarClick);
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
			try {
				fetch("/sched/api/client-log", {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ kind, detail: String(detail).slice(0, 2000), ts: new Date().toISOString() }),
				}).catch(() => {});
			} catch (_) {}
		};
		window.addEventListener("error", (e) => report("js-error", e.message + " @ " + (e.filename || "") + ":" + e.lineno));
		window.addEventListener("unhandledrejection", (e) => report("unhandled-rejection", e.reason && (e.reason.stack || e.reason.message) || String(e.reason)));
	}

	const disposeSettings = cctx.slots.inject(SLOT_SETTINGS, () =>
		cctx.slots.register({ name: SLOT_SETTINGS, id: NS, order: 90 }, StatusCard));
	disposersUI.push(disposeSettings);
	return () => { for (const d of disposersUI) { try { d?.(); } catch (_) {} } };
}

export { name, inject, apply };
