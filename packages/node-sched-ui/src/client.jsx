/**
 * node-sched dashboard — client plugin (M4).
 *
 * Two surfaces:
 *  - `sidebar.footer.action`: entry button toggling a fullscreen dashboard
 *    overlay (fixed positioning escapes the sidebar layout).
 *  - `web-ui.plugin.item`: compact status card in Settings → Web UI 插件.
 *
 * Data: WS /sched/ws/events frames + fetch /sched/api/*.
 * Writes are all two-step confirmed in the UI; host side gates and audits.
 */
const SLOT_FOOTER = "sidebar.footer.action";
const SLOT_SETTINGS = "web-ui.plugin.item";
const NS = "nodesched";

const name = "@zzc/dsh-node-sched-ui";

const inject = ["slots"];

const COLORS = {
	done: "#2e7d32", skip: "#2e7d32", free: "#2e7d32", active: "#1565c0", running: "#1565c0", assigned: "#1565c0",
	pending: "#6a1b9a", waiting_dep: "#6a1b9a", queued: "#6a1b9a",
	blocked: "#b26a00", releasing: "#b26a00",
	failed: "#c62828", cancelled: "#546e7a", timed_out: "#c62828", interrupted: "#ad1457", unmanaged: "#c62828",
};

function apply(cctx, config) {
	const { useEffect, useState, useCallback } = require("react");
	const { jsx: _jsx } = require("react/jsx-runtime");
	const j = (tag, props, ...kids) => {
		const p = { ...(props ?? {}) };
		if (kids.length === 1) p.children = kids[0];
		else if (kids.length > 1) p.children = kids;
		return _jsx(tag, p);
	};

	// ── styles ──────────────────────────────────────────────────────────────
	const pre = { margin: "4px 0", whiteSpace: "pre-wrap", background: "rgba(127,127,127,.08)", borderRadius: 6, padding: 8, fontSize: 11 };
	const btn = (bg, disabled) => ({ background: disabled ? "#bbb" : bg, border: 0, color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: disabled ? "default" : "pointer", marginRight: 4 });
	const badge = (s) => ({ background: COLORS[s] ?? "#666", color: "#fff", borderRadius: 4, padding: "0 6px", fontSize: 10, marginRight: 6 });
	const overlayStyle = {
		position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.45)",
		display: "flex", alignItems: "center", justifyContent: "center",
	};
	const panelStyle = {
		background: "var(--ds-bg, #fff)", color: "inherit", borderRadius: 10, padding: 14,
		width: "min(920px, 94vw)", maxHeight: "88vh", overflow: "auto",
		boxShadow: "0 12px 48px rgba(0,0,0,.35)", fontFamily: "ui-monospace,monospace", fontSize: 12, lineHeight: 1.5,
	};
	const bar = (pct) => ({ height: 6, background: "rgba(127,127,127,.2)", borderRadius: 3, overflow: "hidden", flex: 1, margin: "0 8px" });
	const barFill = (pct) => ({ height: "100%", width: `${Math.max(0, Math.min(100, pct))}%`, background: "#1565c0" });

	const Badge = ({ s }) => j("span", { style: badge(s) }, s);

	async function post(action, body) {
		const r = await fetch(`/sched/api/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return r.json();
	}
	async function getText(action, params = "") {
		const r = await fetch(`/sched/api/${action}${params}`);
		return r.text();
	}

	function ArmButton({ label, confirmLabel, color, onConfirm }) {
		const [armed, setArmed] = useState(false);
		if (!armed) return j("button", { onClick: () => setArmed(true), style: btn(color) }, label);
		return j("button", { onClick: async () => { setArmed(false); await onConfirm(); }, style: btn(color) }, confirmLabel ?? `${label}?`);
	}

	function TypedConfirm({ placeholder, color, onConfirm, children }) {
		const [typed, setTyped] = useState("");
		return j("span", {}, [
			j("input", { placeholder, value: typed, onChange: (e) => setTyped(e.target.value), style: { fontSize: 11, width: 150, marginRight: 4 } }),
			j("button", { disabled: typed !== placeholder, onClick: async () => { await onConfirm(); setTyped(""); }, style: btn(color, typed !== placeholder) }, children),
			j("button", { onClick: () => setTyped("") }, "×"),
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
			j("span", { style: { fontSize: 10, color: "#888" } }, p),
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
					j("button", { onClick: onClose, style: btn("#555") }, "×"),
				]),
				j("pre", { style: { ...pre, maxHeight: "60vh", overflow: "auto" } }, text),
			]),
		]);
	}

	function Dashboard({ onClose }) {
		const [stream] = useSchedStream();
		const [snap, refreshSnap] = useSnapshot("/sched/api/status", 20000);
		const [tab, setTab] = useState("batches");
		const [opMsg, setOpMsg] = useState("");
		const [logTask, setLogTask] = useState(null);
		const raw = snap?.raw;
		const summary = snap?.summary;

		const runOp = async (op, id) => {
			const r = await post("op", { op, id });
			setOpMsg(`${op} ${id ?? ""}: ${r.ok ? "ok" : `fail (${r.error ?? r.code})`} ${r.text ? "— " + String(r.text).slice(0, 120) : ""}`);
			refreshSnap();
		};

		function BatchRow({ b }) {
			const failedTasks = (raw?.jobs ?? []).filter(
				(x) => x.batch === b.name && ["failed", "timed_out", "cancelled"].includes(x.status),
			);
			return jsxs2("div", { style: { marginBottom: 10 } }, [
				jsxs2("div", { style: { display: "flex", alignItems: "center" } }, [
					Badge({ s: b.status }),
					j("b", null, b.name),
					j(ProgressBar, { p: b.progress }),
					j("button", { onClick: () => runOp("cancel", b.name), style: btn("#c62828") }, "cancel"),
				]),
				b.depends_on?.length > 0 && j("div", { style: { fontSize: 10, color: "#888" } }, `依赖: ${b.depends_on.join(", ")}`),
				...failedTasks.map((t) =>
					jsxs2("div", { style: { fontSize: 11, marginLeft: 14, marginTop: 2, display: "flex", alignItems: "center" } }, [
						j("span", { style: { fontFamily: "monospace", cursor: "pointer", textDecoration: "underline", marginRight: 6 }, onClick: () => setLogTask(`${t.batch}:${t.task}`), title: "查看日志" }, t.task),
						Badge({ s: t.status }),
						t.retries != null && j("span", { style: { color: "#888", marginRight: 4 } }, `retries=${t.retries}`),
						j("button", { onClick: () => runOp("retry", `${t.batch}:${t.task}`), style: btn("#1565c0") }, "retry"),
						j(ArmButton, { label: "resubmit", confirmLabel: "resubmit(删产物!)", color: "#e65100", onConfirm: () => runOp("resubmit", `${t.batch}:${t.task}`) }),
					])),
			]);
		}

		function GpuRow({ g }) {
			return jsxs2("div", { style: { marginBottom: 6, display: "flex", alignItems: "center" } }, [
				Badge({ s: g.status }),
				j("span", { style: { fontFamily: "monospace", marginRight: 8 } }, `GPU${g.idx}`),
				g.job && j("span", { style: { fontSize: 10, marginRight: 8, color: "#555", flex: 1 } }, g.job),
				g.quarantined && j("span", { style: { color: "#c62828", marginRight: 8, fontSize: 10 } }, "[quarantined]"),
				!g.job && g.status === "free" && j("span", { style: { flex: 1 } }),
				g.status === "unmanaged" && j("button", { onClick: () => runOp("gpu-free", String(g.idx)), style: btn("#2e7d32") }, "gpu-free 强制回收"),
				g.quarantined && j("button", { onClick: () => runOp("gpu-ok", String(g.idx)), style: btn("#2e7d32") }, "gpu-ok 解除隔离"),
			]);
		}

		function DaemonBar() {
			const [status, setStatus] = useState("");
			const [confirmStop, setConfirmStop] = useState(false);
			const load = useCallback(() => { getText("daemon").then((t) => setStatus(t.trim().slice(0, 120))).catch(() => {}); }, []);
			useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
			return jsxs2("div", { style: { marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid rgba(127,127,127,.25)", display: "flex", alignItems: "center" } }, [
				j("span", { style: { fontSize: 11, marginRight: 8, flex: 1 } }, `daemon: ${status || "?"}`),
				j("button", { onClick: async () => { await runOp("daemon-start"); setTimeout(load, 3000); }, style: btn("#2e7d32") }, "start"),
				!confirmStop && j("button", { onClick: () => setConfirmStop(true), style: btn("#c62828") }, "stop"),
				confirmStop && j(TypedConfirm, {
					placeholder: "输入 stop 确认（会取消未完成任务）", color: "#c62828",
					onConfirm: async () => { await runOp("daemon-stop"); setConfirmStop(false); },
				}, "确认 stop"),
			]);
		}

		function SubmitTab() {
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
					style: { width: "100%", height: 150, fontFamily: "monospace", fontSize: 11 },
				}),
				jsxs2("div", { style: { margin: "6px 0" } }, [
					j("button", { onClick: doDryRun, disabled: !text.trim(), style: btn("#1565c0", !text.trim()) }, "① dry-run 预览"),
					j("button", { onClick: doSubmit, disabled: !(preview?.ok && text.trim()), style: btn("#2e7d32", !(preview?.ok && text.trim())) }, "② 确认提交"),
					j("span", { style: { fontSize: 11, marginLeft: 8 } }, msg),
				]),
				preview && j("pre", { style: { ...pre, maxHeight: 240, overflow: "auto" } }, preview.text),
			]);
		}

		return j("div", { style: overlayStyle, onClick: onClose }, [
			jsxs2("div", { style: panelStyle, onClick: (e) => e.stopPropagation() }, [
				jsxs2("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } }, [
					j("b", null, "node-sched"),
					j("span", { style: { color: stream.connected ? "#2e7d32" : "#c62828", fontSize: 11 } }, stream.connected ? "● live" : "○ offline"),
					j("button", { onClick: refreshSnap, style: btn("#555") }, "refresh"),
					...["batches", "gpus", "events", "submit"].map((t) =>
						j("button", { key: t, onClick: () => setTab(t), style: btn(tab === t ? "#333" : "#aaa") }, t)),
					j("span", { style: { flex: 1 } }),
					j("button", { onClick: onClose, style: btn("#555") }, "×"),
				]),
				opMsg && j("div", { style: { fontSize: 11, color: "#b26a00", marginBottom: 4 } }, opMsg),
				tab === "batches" && jsxs2("div", null, [
					j(DaemonBar, null),
					!summary && j("div", null, "loading…"),
					summary && j("pre", { style: { ...pre, maxHeight: 110, overflow: "auto" } }, summary.split("\njobs:")[0]),
					raw && (raw.batches ?? []).filter((b) => !["done", "skip"].includes(b.status)).map((b) => j(BatchRow, { key: b.id ?? b.name, b })),
				]),
				tab === "gpus" && jsxs2("div", null, [
					raw && (raw.gpus ?? []).map((g) => j(GpuRow, { key: g.idx, g })),
					!raw && j("div", null, "loading…"),
				]),
				tab === "events" && j("pre", { style: { ...pre, maxHeight: "55vh", overflow: "auto" } }, stream.lines.join("\n") || "(no events yet)"),
				tab === "submit" && j(SubmitTab, null),
				logTask && j(LogViewer, { taskId: logTask, onClose: () => setLogTask(null) }),
			]),
		]);
	}

	// ── sidebar footer entry: button toggling the fullscreen dashboard ──────
	function FooterEntry(props) {
		const [open, setOpen] = useState(false);
		return jsxs2("span", {}, [
			j("button", {
				onClick: () => setOpen(true),
				title: "node-sched GPU/CPU 调度看板",
				style: { ...btn("#333"), width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 12 },
			}, "⚡ sched 看板"),
			open && j(Dashboard, { onClose: () => { setOpen(false); } }),
		]);
	}

	// ── settings card: compact status + entry hint ──────────────────────────
	function StatusCard() {
		const [snap] = useSnapshot("/sched/api/status", 30000);
		const raw = snap?.raw;
		const gpus = (raw?.gpus ?? []).map((g) => `${g.idx}:${g.status}`).join(" ");
		const active = (raw?.batches ?? []).filter((b) => !["done", "skip"].includes(b.status)).length;
		return jsxs2("div", { style: { fontFamily: "ui-monospace,monospace", fontSize: 11, lineHeight: 1.6 } }, [
			jsxs2("div", {}, [
				j("b", null, "node-sched"),
				j("span", { style: { margin: "0 6px", color: "#888" } }, "GPU"),
				gpus || "?",
			]),
			j("div", { style: { color: "#888" } }, `活跃/阻塞批次: ${active}；点侧栏底部「⚡ sched 看板」打开完整面板`),
		]);
	}

	cctx.logger?.info?.("[node-sched-ui] mounting footer entry + settings card");
	const disposeFooter = cctx.slots.inject(SLOT_FOOTER, () =>
		cctx.slots.register({ name: SLOT_FOOTER, id: NS }, FooterEntry));
	const disposeSettings = cctx.slots.inject(SLOT_SETTINGS, () =>
		cctx.slots.register({ name: SLOT_SETTINGS, id: NS, order: 90 }, StatusCard));
	return () => { disposeFooter?.(); disposeSettings?.(); };
}

export { name, inject, apply };
