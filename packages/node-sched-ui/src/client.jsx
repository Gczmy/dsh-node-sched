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

function apply(cctx, config) {
	const { useEffect, useState, useCallback, useRef, memo } = require("react");

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
	const pre = { margin: "4px 0", whiteSpace: "pre-wrap", background: T.bgLayer, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, fontSize: 11.5, color: T.label };
	// 柔和按钮：状态色 12% 底纹 + 同色文字，双主题自动柔和（不再用高饱和实底）
	const btn = (color = T.brand, disabled) => {
		if (disabled) {
			return { background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label2, borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "default", marginRight: 4 };
		}
		return {
			background: `color-mix(in srgb, ${color} 12%, transparent)`,
			border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
			color, borderRadius: 6, padding: "3px 10px", fontSize: 11,
			cursor: "pointer", marginRight: 4, transition: "background .15s",
		};
	};
	const ghostBtn = { background: "transparent", border: `1px solid ${T.border}`, color: T.label, borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer", marginRight: 4 };
		const badge = (s) => {
		const c = COLORS[s] ?? T.label2;
		return {
			background: `color-mix(in srgb, ${c} 13%, transparent)`,
			border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
			color: c, borderRadius: 999, padding: "0 7px", fontSize: 10, marginRight: 6,
		};
	};
	const overlayStyle = {
		position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.45)",
		backdropFilter: "blur(2px)",
		display: "flex", alignItems: "center", justifyContent: "center",
	};
	const panelStyle = {
		background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))",
		color: T.label, border: `1px solid var(--dsw-alias-border-l2, ${T.border})`, borderRadius: 12, padding: 16,
		width: "min(960px, 94vw)", maxHeight: "88vh", overflow: "auto",
		boxShadow: "0 18px 60px rgba(0,0,0,.45)", fontFamily: T.font, fontSize: 12, lineHeight: 1.55,
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
			j("input", { placeholder, value: typed, onChange: (e) => setTyped(e.target.value), style: { fontSize: 11, width: 150, marginRight: 4 } }),
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
			j("span", { style: { fontSize: 10, color: T.label2 } }, p),
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

		const runOp = async (op, id) => {
			const r = await post("op", { op, id });
			setOpMsg(`${op} ${id ?? ""}: ${r.ok ? "ok" : `fail (${r.error ?? r.code})`} ${r.text ? "— " + String(r.text).slice(0, 120) : ""}`);
			refreshSnap();
		};

		// 批次行网格：徽章 | 名称 | 分段进度条 | 计数 | cancel —— 固定列宽对齐
		const GRID = {
			display: "grid",
			gridTemplateColumns: "76px minmax(120px, 1.1fr) minmax(160px, 1.6fr) 56px 84px",
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

		function SegmentedBar({ seg }) {
			const total = seg.bad + seg.ok + seg.run + seg.off;
			if (!total) return null;
			return j("span", { style: bar() }, ["bad", "ok", "run", "off"].map((k) =>
				j("span", { key: k, style: { height: "100%", width: `${(seg[k] / total) * 100}%`, background: SEG_COLOR[k], display: "inline-block" } }),
			));
		}

		function BatchRow({ b }) {
			const [open, setOpen] = useState(false);
			const tasks = (raw?.jobs ?? []).filter(
				(x) => x.batch === b.id,
			);
			const failedTasks = tasks.filter((x) => ["failed", "timed_out", "cancelled"].includes(x.status));
			const seg = taskSegments(tasks);

			return jsxs2("div", { style: { marginBottom: 10 } }, [
				jsxs2("div", { style: GRID, onClick: () => setOpen(!open) }, [
					j("span", { style: { textAlign: "center", cursor: "pointer" } }, Badge({ s: b.status })),
					jsxs2("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }, onClick: (e) => { e.stopPropagation(); setOpen(!open); } }, [
					j("b", { style: { fontSize: 11.5 }, title: b.name }, b.name),
					b.project && j("span", { style: { fontSize: 9, color: T.label2, marginLeft: 6 } }, b.project),
				]),
					j(SegmentedBar, { seg: taskSegments(tasks) }),
					j("span", { style: { fontSize: 10.5, color: T.label2, textAlign: "right" } }, b.progress ?? ""),
					j(ArmButton, { label: "cancel", confirmLabel: "cancel(取消任务!)", color: T.err, stopProp: true,
					onConfirm: () => runOp("cancel", b.name) }),
				]),
				open && jsxs2("div", { style: { marginTop: 6, marginLeft: 76, paddingLeft: 10, borderLeft: `2px solid ${T.border}` } }, [
					b.depends_on?.length > 0 && j("div", { style: { fontSize: 10, color: T.label2 } }, `依赖: ${b.depends_on.join(", ")}`),
					...tasks.filter((t) => ["failed", "timed_out", "cancelled"].includes(t.status)).map((t) =>
						jsxs2("div", { style: { fontSize: 11, marginLeft: 14, marginTop: 2, display: "flex", alignItems: "center" } }, [
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

		function GpuRow({ g }) {
			return jsxs2("div", { style: { marginBottom: 6, display: "flex", alignItems: "center" } }, [
				Badge({ s: g.status }),
				j("span", { style: { fontFamily: "monospace", marginRight: 8 } }, `GPU${g.idx}`),
				g.job && j("span", { style: { fontSize: 10, marginRight: 8, color: T.label2, flex: 1 } }, g.job),
				g.quarantined && j("span", { style: { color: T.err, marginRight: 8, fontSize: 10 } }, "[quarantined]"),
				!g.job && g.status === "free" && j("span", { style: { flex: 1 } }),
				g.status === "unmanaged" && j(ArmButton, { label: "gpu-free 强制回收", confirmLabel: "确认回收?", color: T.warn,
					onConfirm: () => runOp("gpu-free", String(g.idx)) }),
				g.quarantined && j("button", { onClick: () => runOp("gpu-ok", String(g.idx)), style: btn(T.ok) }, "gpu-ok 解除隔离"),
			]);
		}

		function EntrySwitch() {
			const [entry, setEntry] = useState(null);
			const [note, setNote] = useState("");
			useEffect(() => {
				fetch("/sched/api/entry").then((r) => r.json())
					.then((d) => setEntry(d.entry || "?")).catch(() => setEntry("?"));
			}, []);
			const pick = async (target) => {
				if (target === entry) return;
				setNote("切换中…");
				try {
					const r = await fetch("/sched/api/entry", {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ entry: target }),
					});
					const d = await r.json();
					setEntry(d.entry || target);
					setNote(d.probeText ? `探测: ${d.probeText}` : "已切换");
				} catch (e) { setNote("❌ " + String(e)); }
			};
			const seg = (label) => j("button", {
				onClick: () => pick(label),
				style: entry === label ? btn(T.brand) : ghostBtn,
			}, label);
			return jsxs2("span", { style: { display: "inline-flex", alignItems: "center", gap: 4,
				marginRight: 10, fontSize: 11 } }, [
				j("span", { style: { color: T.label2 } }, "入口"),
				seg("HPDC"),
				seg("HPDC_outside"),
				note && j("span", { style: { color: T.label2, marginLeft: 4 } }, note),
			]);
		}

		function DaemonBar() {
			const [status, setStatus] = useState(null);      // 上次成功查询的状态文本（保留不清空）
			const [querying, setQuerying] = useState(true);  // 是否正在查询
			const [confirmStop, setConfirmStop] = useState(false);
			const load = useCallback(() => {
				setQuerying(true);
				fetch("/sched/api/daemon").then((r) => r.json()).then((d) => {
					if (d.ok) setStatus(d.text);
					else setStatus((prev) => prev ?? ("查询失败: " + String(d.text ?? "").slice(0, 80)));
					setQuerying(false);
				}).catch(() => { setQuerying(false); }); // 失败保留上次值
			}, []);
			useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
			const running = status != null && status.includes("运行中");
			return jsxs2("div", { style: { marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center" } }, [
				jsxs2("span", { style: { fontSize: 11, marginRight: 8, flex: 1 } }, [
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

			if (!list) return j("div", { style: { color: T.label2, fontSize: 11 } },
				msg || (INC_CACHE ? "" : "loading…"));

			const p = detail && !detail.loading && !detail.error ? detail.payload || {} : null;
			// B19 调试: 展开态渲染打点 —— 若无写入日志却出现此行, 问题在渲染/水合层
			if (p && (!INC_DETAIL || !(INC_DETAIL[detail.id]))) {
				console.log("[inc] ⚠️ 渲染了展开态但模块缓存中无此条目 id=" + detail.id,
					"(水合丢失或外部写入)");
			}
			const failed = p ? p.failed || {} : {};
			const mem = p ? p.memory || {} : {};

			return jsxs2("div", { style: { fontSize: 11 } }, [
				jsxs2("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
					padding: "5px 8px", borderRadius: 6, background: T.bgLayer,
					border: `1px solid ${T.border}` } }, [
					j(EntrySwitch, null),
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
					j("div", { style: { color: T.label2, fontSize: 10, marginBottom: 4 } },
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
				msg && j("div", { style: { color: T.err, fontSize: 11 } }, msg),
			]);
		});


		function ConfigTab() {
			const [cfgText, setCfgText] = useState("");   // 原始 JSON 文本 (可编辑, 高级模式)
			const [cfg, setCfg] = useState(null);          // 解析后的工作副本
			const [msg, setMsg] = useState("");
			const [advanced, setAdvanced] = useState(false);

			const load = useCallback(() => {
				fetch("/sched/api/config").then((r) => r.json()).then((d) => {
					if (!d.ok) { setMsg("❌ 加载失败: " + (d.text || "").slice(0, 120)); return; }
					setCfg(JSON.parse(d.text));
					setCfgText(d.text);
					setMsg("");
				}).catch(() => setMsg("❌ 加载异常"));
			}, []);
			useEffect(() => { load(); }, []);

			if (!cfg) return j("div", { style: { color: T.label2, fontSize: 11 } }, msg || "loading config…");

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
				style: { ...style, width: 52, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, padding: "2px 4px", fontSize: 11 },
			});
			const secTitle = (t) => j("div", { style: { fontSize: 11, color: T.brand, margin: "8px 0 4px", fontWeight: 600 } }, t);
			const rowStyle = { display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11, flexWrap: "wrap" };

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
					style: { background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, fontSize: 11 },
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

			return jsxs2("div", { style: { fontSize: 11 } }, [
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
						style: { width: 50, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, fontSize: 11 } }),
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
					style: { width: "100%", minHeight: 200, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 6, fontSize: 11, fontFamily: "monospace", padding: 6 },
				}),
				msg && j("div", { style: { fontSize: 11, marginTop: 6, color: msg.startsWith("✅") ? T.ok : T.warn } }, msg),
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
					j("button", { onClick: doDryRun, disabled: !text.trim(), style: btn(T.brand, !text.trim()) }, "① dry-run 预览"),
					j("button", { onClick: doSubmit, disabled: !(preview?.ok && text.trim()), style: btn(T.ok, !(preview?.ok && text.trim())) }, "② 确认提交"),
					j("span", { style: { fontSize: 11, marginLeft: 8 } }, msg),
				]),
				preview && j("pre", { style: { ...pre, maxHeight: 240, overflow: "auto" } }, preview.text),
			]);
		}

		return j("div", { style: overlayStyle, onClick: onClose }, [
			jsxs2("div", { style: panelStyle, onClick: (e) => e.stopPropagation() }, [
				jsxs2("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } }, [
					j("b", null, "node-sched"),
					j("span", { style: { color: stream.connected ? T.ok : T.err, fontSize: 11 } }, stream.connected ? "● live" : "○ offline"),
					j("button", { onClick: refreshSnap, style: ghostBtn }, "refresh"),
					j("select", {
						value: projFilter,
						onChange: (e) => setProjFilter(e.target.value),
						style: { background: "transparent", border: `1px solid ${T.border}`, color: T.label, borderRadius: 6, padding: "3px 6px", fontSize: 11, marginRight: 4 },
					}, [
						j("option", { value: "" }, "all projects"),
						...projects.map((pr) => j("option", { key: pr, value: pr }, pr)),
					]),
					...["batches", "gpus", "events", "submit", "config", "incidents"].map((t) =>
						j("button", { key: t, onClick: () => setTab(t), style: tab === t ? btn(T.brand) : ghostBtn }, t)),
					j("span", { style: { flex: 1 } }),
					j("button", { onClick: onClose, style: ghostBtn }, "×"),
				]),
				opMsg && j("div", { style: { fontSize: 11, color: T.warn, marginBottom: 4 } }, opMsg),
				tab === "batches" && jsxs2("div", null, [
					j(DaemonBar, null),
					!summary && j("div", null, "loading…"),
					summary && j("pre", { style: { ...pre, maxHeight: 110, overflow: "auto" } }, summary.split("\njobs:")[0]),
					raw && jsxs2("div", {}, [
					jsxs2("div", { style: { fontSize: 10, color: T.label2, marginBottom: 6 } }, [
						j("span", { style: { marginRight: 10, color: "#ef4444" } }, "■ 红=出错"),
						j("span", { style: { marginRight: 10, color: "#22c55e" } }, "■ 绿=成功"),
						j("span", { style: { marginRight: 10, color: "#3b82f6" } }, "■ 蓝=运行中"),
						j("span", { style: { color: "#9ca3af" } }, "■ 灰=排队/取消"),
					]),
					(raw.batches ?? [])
						.filter((b) => !["done", "skip"].includes(b.status))
						.filter((b) => !projFilter || b.project === projFilter)
						.map((b) => j(BatchRow, { key: b.id ?? b.name, b })),
				]),
				]),
				tab === "gpus" && jsxs2("div", { key: "tab-gpus" }, [
					raw && (raw.gpus ?? []).map((g) => j(GpuRow, { key: g.idx, g })),
					!raw && j("div", null, "loading…"),
				]),
				tab === "events" && j("pre", { key: "tab-events", style: { ...pre, maxHeight: "55vh", overflow: "auto" } }, stream.lines.join("\n") || "(no events yet)"),
				tab === "submit" && j(SubmitTab, { key: "tab-submit" }),
				tab === "config" && j(ConfigTab, { key: "tab-config" }),
				tab === "incidents" && j(IncidentsTab, { key: "tab-incidents" }),
				logTask && j(LogViewer, { taskId: logTask, onClose: () => setLogTask(null) }),
			]),
		]);
	}

	// ── sidebar footer entry: button toggling the fullscreen dashboard ──────
	function FooterEntry(props) {
		const [open, setOpen] = useState(false);
		useEffect(() => {
			const h = () => setOpen(true);
			window.addEventListener("nodesched-open", h);
			return () => window.removeEventListener("nodesched-open", h);
		}, []);
		return jsxs2("span", {}, [
			j("button", {
				onClick: () => setOpen(true),
				title: "node-sched GPU/CPU 调度看板",
				style: { ...ghostBtn, width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 12 },
			}, "⚡ sched 看板"),
			open && j(Dashboard, { onClose: () => { setOpen(false); } }),
		]);
	}

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
			margin: "0 16px", paddingBottom: 8,
		};

		const act = batches.filter((b) => b.status === "active").length;
		const blk = batches.filter((b) => b.status === "blocked").length;
		const done = batches.filter((b) => ["done", "skip"].includes(b.status)).length;
		const gpuColor = { free: "#22c55e", assigned: "#3b82f6",
			releasing: "#eab308", unmanaged: "#f97316", quarantined: "#ef4444" };

		return jsxs2("div", { style: stCard }, [
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
						padding: "2px 6px", fontSize: 11,
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
	function FooterEntry(props) {
		const [open, setOpen] = useState(false);
		useEffect(() => {
			const h = () => setOpen(true);
			window.addEventListener("nodesched-open", h);
			return () => window.removeEventListener("nodesched-open", h);
		}, []);
		return jsxs2("span", {}, [
			j("button", {
				onClick: () => setOpen(true),
				title: "node-sched GPU/CPU 调度看板",
				style: { ...ghostBtn, width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 12 },
			}, "⚡ sched 看板"),
			open && j(Dashboard, { onClose: () => { setOpen(false); } }),
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
