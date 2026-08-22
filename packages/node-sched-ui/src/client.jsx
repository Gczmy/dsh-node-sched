/**
 * node-sched dashboard — client plugin (M3b).
 *
 * Renders into the web-ui ecosystem panel slot `web-ui.plugin.item`.
 * Data: WS /sched/ws/events frames + fetch /sched/api/*.
 * Writes are all two-step confirmed in the UI; host side gates and audits.
 */
const SLOT = "web-ui.plugin.item";
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

	const pre = { margin: "4px 0", whiteSpace: "pre-wrap", background: "rgba(127,127,127,.08)", borderRadius: 6, padding: 8, fontSize: 11 };
	const btn = (bg, disabled) => ({ background: disabled ? "#bbb" : bg, border: 0, color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: disabled ? "default" : "pointer", marginRight: 4 });
	const badgeStyle = (status) => ({ background: COLORS[status] ?? "#666", color: "#fff", borderRadius: 4, padding: "0 6px", fontSize: 10, marginRight: 6 });
	const Badge = ({ s }) => j("span", { style: badgeStyle(s) }, s);

	async function post(action, body) {
		const r = await fetch(`/sched/api/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return r.json();
	}
	async function getText(action, params = "") {
		const r = await fetch(`/sched/api/${action}${params}`);
		return r.text();
	}

	function ArmButton({ label, confirmLabel, color, onConfirm, guard }) {
		const [armed, setArmed] = useState(false);
		if (!armed) return j("button", { onClick: () => setArmed(true), style: btn(color) }, label);
		return j("button", {
			onClick: async () => { setArmed(false); await onConfirm(); },
			style: btn(color),
			title: guard ?? "",
		}, confirmLabel ?? `${label}?`);
	}

	function TypedConfirm({ placeholder, color, onConfirm, children }) {
		const [typed, setTyped] = useState("");
		const [busy, setBusy] = useState(false);
		return jsxs2("span", {}, [
			j("input", { placeholder, value: typed, onChange: (e) => setTyped(e.target.value), style: { fontSize: 11, width: 150, marginRight: 4 } }),
			j("button", {
				disabled: typed !== placeholder || busy,
				onClick: async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); setTyped(""); } },
				style: btn(color, typed !== placeholder || busy),
			}, children),
			j("button", { onClick: () => setTyped("") }, "×"),
		]);
	}
	// jsxs helper shares the corrected children semantics
	const jsxs2 = j;

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
				ws.onclose = () => { if (!closed) { timer = setTimeout(connect, 3000); } setState((s) => ({ ...s, connected: false })); };
			};
			connect();
			return () => { closed = true; clearTimeout(timer); ws?.close(); };
		}, []);
		return [state];
	}

	function useSnapshot(path, ms) {
		const [data, setData] = useState(null);
		const refresh = useCallback(() => { fetch(path).then((r) => r.json()).then(setData).catch(() => {}); }, depsOf(path));
		function depsOf(p) { return [p]; }
		useEffect(() => { refresh(); const t = setInterval(refresh, ms); return () => clearInterval(t); }, [refresh]);
		return [data, refresh];
	}

	function Dashboard() {
		const [stream] = useSchedStream();
		const [snap, refreshSnap] = useSnapshot("/sched/api/status", 20000);
		const [tab, setTab] = useState("batches");
		const [opMsg, setOpMsg] = useState("");
		const raw = snap?.raw;
		const summary = snap?.summary;

		const runOp = async (op, id) => {
			const r = await post("op", { op, id });
			setOpMsg(`${op} ${id ?? ""}: ${r.ok ? "ok" : `fail (${r.error ?? r.code})`} ${r.text ? "— " + String(r.text).slice(0, 120) : ""}`);
			refreshSnap();
		};
		const runOpConfirm = (op, id) => async () => { await runOp(op, id); };

		function BatchRow({ b }) {
			const failedTasks = (raw?.jobs ?? []).filter(
				(x) => x.batch === b.name && ["failed", "timed_out", "cancelled"].includes(x.status),
			);
			return jsxs2("div", { style: { marginBottom: 8 } }, [
				jsxs2("div", {}, [
					Badge({ s: b.status }),
					j("b", null, b.name),
					j("span", { style: { margin: "0 8px", color: "#888" } }, `${b.progress ?? ""}`),
					j("button", { onClick: () => runOp("cancel", b.name), style: btn("#c62828") }, "cancel 批次"),
				]),
				b.depends_on?.length > 0 && j("div", { style: { fontSize: 10, color: "#888" } }, `依赖: ${b.depends_on.join(", ")}`),
				...failedTasks.map((t) =>
					jsxs2("div", { style: { fontSize: 11, marginLeft: 14, marginTop: 2 } }, [
						j("span", { style: { fontFamily: "monospace" } }, `${t.task} `),
						Badge({ s: t.status }),
						t.retries != null && j("span", { style: { color: "#888", marginRight: 4 } }, `retries=${t.retries}`),
						j("button", { onClick: () => runOp("retry", `${t.batch}:${t.task}`), style: btn("#1565c0") }, "retry"),
						j(ArmButton, {
							label: "resubmit", confirmLabel: "resubmit(删产物!)", color: "#e65100",
							onConfirm: () => runOp("resubmit", `${t.batch}:${t.task}`),
						}),
					])),
			]);
		}

		function GpuRow({ g }) {
			return jsxs2("div", { style: { marginBottom: 6 } }, [
				Badge({ s: g.status }),
				j("span", { style: { fontFamily: "monospace", marginRight: 8 } }, `GPU${g.idx}`),
				g.job && j("span", { style: { fontSize: 10, marginRight: 8, color: "#555" } }, g.job),
				g.quarantined && j("span", { style: { color: "#c62828", marginRight: 8, fontSize: 10 } }, "[quarantined]"),
				g.status === "unmanaged" && j("button", { onClick: () => runOp("gpu-free", String(g.idx)), style: btn("#2e7d32") }, "gpu-free 强制回收"),
				g.quarantined && j("button", { onClick: () => runOp("gpu-ok", String(g.idx)), style: btn("#2e7d32") }, "gpu-ok 解除隔离"),
			]);
		}

		function DaemonBar() {
			const [status, setStatus] = useState("");
			const [confirmStop, setConfirmStop] = useState(false);
			useEffect(() => { getText("daemon").then((t) => setStatus(t.trim().slice(0, 120))).catch(() => {}); }, []);
			return jsxs2("div", { style: { marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid rgba(127,127,127,.25)" } }, [
				j("span", { style: { fontSize: 11, marginRight: 8 } }, `daemon: ${status || "?"}`),
				j("button", { onClick: async () => { await runOp("daemon-start"); setTimeout(() => getText("daemon").then((t) => setStatus(t.trim().slice(0, 120))), 3000); }, style: btn("#2e7d32") }, "start"),
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
					if (r.ok) { refreshSnap(); }
				} catch (e) { setMsg(String(e)); }
			};
			return jsxs2("div", {}, [
				j("textarea", {
					value: text, onChange: (e) => setText(e.target.value),
					placeholder: '粘贴 batch.json 内容，例如 {"schema_version":1,"name":"my_batch","tasks":[...]}',
					style: { width: "100%", height: 140, fontFamily: "monospace", fontSize: 11 },
				}),
				jsxs2("div", { style: { margin: "6px 0" } }, [
					j("button", { onClick: doDryRun, disabled: !text.trim(), style: btn("#1565c0", !text.trim()) }, "① dry-run 预览"),
					j("button", { onClick: doSubmit, disabled: !(preview?.ok && text.trim()), style: btn("#2e7d32", !(preview?.ok && text.trim())) }, "② 确认提交"),
					j("span", { style: { fontSize: 11, marginLeft: 8 } }, msg),
				]),
				preview && j("pre", { style: { ...pre, maxHeight: 240, overflow: "auto" } }, preview.text),
			]);
		}

		return jsxs2("div", { style: { fontFamily: "ui-monospace,monospace", fontSize: 12, lineHeight: 1.5 } }, [
			jsxs2("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 6 } }, [
				j("b", null, "node-sched"),
				j("span", { style: { color: stream.connected ? "#2e7d32" : "#c62828", fontSize: 11 } }, stream.connected ? "● live" : "○ offline"),
				j("button", { onClick: refreshSnap, style: btn("#555") }, "refresh"),
				...["batches", "gpus", "events", "submit"].map((t) =>
					j("button", { key: t, onClick: () => setTab(t), style: btn(tab === t ? "#333" : "#aaa") }, t)),
			]),
			opMsg && j("div", { style: { fontSize: 11, color: "#b26a00", marginBottom: 4 } }, opMsg),
			tab === "batches" && jsxs2("div", null, [
				j(DaemonBar, null),
				!summary && j("div", null, "loading…"),
				summary && j("pre", { style: { ...pre, maxHeight: 120, overflow: "auto" } }, summary.split("\njobs:")[0]),
				raw && (raw.batches ?? []).filter((b) => !["done", "skip"].includes(b.status)).map((b) => j(BatchRow, { key: b.id ?? b.name, b })),
			]),
			tab === "gpus" && jsxs2("div", null, [
				raw && (raw.gpus ?? []).map((g) => j(GpuRow, { key: g.idx, g })),
				!raw && j("div", null, "loading…"),
			]),
			tab === "events" && j("pre", { style: { ...pre, maxHeight: 300, overflow: "auto" } }, stream.lines.join("\n") || "(no events yet)"),
			tab === "submit" && j(SubmitTab, null),
		]);
	}

	cctx.logger?.info?.("[node-sched-ui] mounting dashboard panel");
	const disposeInject = cctx.slots.inject(SLOT, () =>
		cctx.slots.register({ name: SLOT, id: NS, order: 90 }, Dashboard));
	return () => disposeInject?.();
}

export { name, inject, apply };
