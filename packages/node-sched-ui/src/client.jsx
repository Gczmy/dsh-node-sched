/**
 * node-sched dashboard — client plugin (M3, full-route edition).
 *
 * Renders into the web-ui ecosystem panel slot `web-ui.plugin.item`
 * (provided by @linxin666/dsh-client-ui-web-ui-settings, which the profile
 * installs). Data: WS /sched/ws/events frames + fetch /sched/api/*.
 * Writes (cancel/retry) are two-step confirmed in the UI; the host side
 * gates and audits them.
 */
const SLOT = "web-ui.plugin.item";
const NS = "nodesched";

const inject = [];

function apply(cctx, config) {
	const { useEffect, useState, useCallback } = require("react");
	const { jsx: _jsx, jsxs } = require("react/jsx-runtime");
	// keep reference shape explicit for readability
	const j = (tag, props, ...kids) => _jsx(tag, props, ...kids);

	function useSchedStream() {
		const [state, setState] = useState({ summary: null, lines: [], connected: false });
		useEffect(() => {
			let ws;
			let closed = false;
			const connect = () => {
				ws = new WebSocket(`ws://${location.host}/sched/ws/events`);
				ws.onopen = () => setState((s) => ({ ...s, connected: true }));
				ws.onmessage = (e) => {
					const m = JSON.parse(e.data);
					setState((s) =>
						m.type === "status"
							? { ...s, summary: m.summary ?? s.summary }
							: { ...s, lines: [...s.lines.slice(-500), m.line] },
					);
				};
				ws.onclose = () => {
					if (!closed) setTimeout(connect, 3000);
					setState((s) => ({ ...s, connected: false }));
				};
			};
			connect();
			return () => { closed = true; ws?.close(); };
		}, []);
		return [state, setState];
	}

	function useSnapshot(path, deps = []) {
		const [data, setData] = useState(null);
		const refresh = useCallback(() => {
			fetch(path).then((r) => r.json()).then(setData).catch(() => {});
		}, deps);
		useEffect(() => {
			refresh();
			const t = setInterval(refresh, 15000);
			return () => clearInterval(t);
		}, [refresh]);
		return [data, refresh];
	}

	async function post(action, body) {
		const r = await fetch(`/sched/api/${action}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return r.json();
	}

	// ── components ──────────────────────────────────────────────────────────

	function Badge({ status }) {
		const color = { done: "#2e7d32", active: "#1565c0", running: "#1565c0", blocked: "#b26a00", failed: "#c62828", free: "#2e7d32", assigned: "#1565c0", releasing: "#b26a00", unmanaged: "#c62828" }[status] ?? "#666";
		return j("span", { style: { background: color, color: "#fff", borderRadius: 4, padding: "1px 6px", fontSize: 11, marginRight: 6 } }, status);
	}

	function CancelButton({ id, onDone }) {
		const [arming, setArming] = useState(false);
		const [typed, setTyped] = useState("");
		if (!arming) {
			return j("button", { onClick: () => setArming(true), style: btn("#c62828") }, "cancel");
		}
		return jsxs("span", {}, [
			j("input", {
				placeholder: `输入 ${id} 确认`,
				value: typed,
				onChange: (e) => setTyped(e.target.value),
				style: { fontSize: 11, width: 130, marginRight: 4 },
			}),
			j("button", {
				disabled: typed !== id,
				onClick: async () => { await post("cancel", { id }); setArming(false); setTyped(""); onDone?.(); },
				style: btn(typed === id ? "#c62828" : "#999"),
			}, "确认取消"),
			j("button", { onClick: () => setArming(false) }, "×"),
		]);
	}

	function btn(bg) {
		return { background: bg, border: 0, color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer", marginRight: 4 };
	}

	function Dashboard() {
		const [stream] = useSchedStream();
		const [snap, refreshSnap] = useSnapshot("/sched/api/status");
		const [gpus] = useSnapshot("/sched/api/gpus");
		const [tab, setTab] = useState("batches");
		const summary = snap?.summary;

		return jsxs("div", { style: { fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 } }, [
			jsxs("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 6 } }, [
				j("b", null, "node-sched"),
				j("span", { style: { color: stream.connected ? "#2e7d32" : "#c62828", fontSize: 11 } },
					stream.connected ? "● live" : "○ offline"),
				j("button", { onClick: refreshSnap, style: btn("#555") }, "refresh"),
				...["batches", "gpus", "events"].map((t) =>
					j("button", { key: t, onClick: () => setTab(t), style: btn(tab === t ? "#333" : "#aaa") }, t)),
			]),
			tab === "batches" && jsxs("div", null, [
				!summary && j("div", null, "loading…"),
				summary && j("pre", { style: pre }, summary),
			]),
			tab === "gpus" && j("pre", { style: pre }, gpus?.text ?? "loading…"),
			tab === "events" && j("pre", { style: { ...pre, maxHeight: 260, overflow: "auto" } },
				stream.lines.join("\n") || "(no events yet)"),
		]);
	}

	const pre = { margin: 0, whiteSpace: "pre-wrap", background: "rgba(127,127,127,.08)", borderRadius: 6, padding: 8 };

	cctx.logger?.info?.("[node-sched-ui] mounting dashboard panel");
	const disposeInject = cctx.slots.inject(SLOT, () =>
		cctx.slots.register({
			name: SLOT,
			id: NS,
			order: 90,
		}, Dashboard),
	);
	return () => disposeInject?.();
}

export { inject, apply };
