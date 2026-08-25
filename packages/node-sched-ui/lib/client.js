window.__ModuleLoader__.load({
	id: "@zzc/dsh-node-sched-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.jsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var SLOT_FOOTER = "sidebar.footer.action";
var SLOT_SETTINGS = "web-ui.plugin.item";
var NS = "nodesched";
var name = "@zzc/dsh-node-sched-ui";
var inject = ["slots"];
var T = {
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
  onFill: "var(--dsw-alias-bg-base)"
  // 实底上的文字：明色主题→白、暗色主题→深
};
var COLORS = {
  done: T.ok,
  skip: T.ok,
  free: T.ok,
  active: T.ok,
  running: T.brand,
  assigned: "#3b82f6",
  blocked: T.label2,
  releasing: T.warn,
  failed: T.err,
  timed_out: T.err,
  unmanaged: T.err,
  cancelled: T.label2,
  interrupted: T.err,
  pending: T.label2,
  waiting_dep: T.warn,
  queued: T.label2
};
function apply(cctx, config) {
  const { useEffect, useState, useCallback, useRef, memo } = require("react");
  let INC_CACHE = null;
  let INC_OPEN_ID = null;
  let INC_DETAIL = null;
  let INC_VIEW_GEN = 0;
  const { jsx: _jsx } = require("react/jsx-runtime");
  const j = (tag, props, ...kids) => {
    const p = { ...props ?? {} };
    if (kids.length === 1) p.children = kids[0];
    else if (kids.length > 1) p.children = kids;
    return _jsx(tag, p);
  };
  const jsxs2 = j;
  const pre = { margin: "4px 0", whiteSpace: "pre-wrap", background: T.bgLayer, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, fontSize: 11.5, color: T.label };
  const btn = (color = T.brand, disabled) => {
    if (disabled) {
      return { background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label2, borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "default", marginRight: 4 };
    }
    return {
      background: `color-mix(in srgb, ${color} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
      color,
      borderRadius: 6,
      padding: "3px 10px",
      fontSize: 11,
      cursor: "pointer",
      marginRight: 4,
      transition: "background .15s"
    };
  };
  const ghostBtn = { background: "transparent", border: `1px solid ${T.border}`, color: T.label, borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer", marginRight: 4 };
  const badge = (s) => {
    const c = COLORS[s] ?? T.label2;
    return {
      background: `color-mix(in srgb, ${c} 13%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
      color: c,
      borderRadius: 999,
      padding: "0 7px",
      fontSize: 10,
      marginRight: 6
    };
  };
  const overlayStyle = {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    background: "rgba(0,0,0,.45)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  };
  const panelStyle = {
    background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))",
    color: T.label,
    border: `1px solid var(--dsw-alias-border-l2, ${T.border})`,
    borderRadius: 12,
    padding: 16,
    width: "min(960px, 94vw)",
    maxHeight: "88vh",
    overflow: "auto",
    boxShadow: "0 18px 60px rgba(0,0,0,.45)",
    fontFamily: T.font,
    fontSize: 12,
    lineHeight: 1.55
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
    const guard = (e) => {
      if (stopProp) e.stopPropagation();
    };
    if (!armed) return j("button", { onClick: (e) => {
      guard(e);
      setArmed(true);
    }, style: btn(color) }, label);
    return j("button", { onClick: async (e) => {
      guard(e);
      setArmed(false);
      await onConfirm();
    }, style: btn(color) }, confirmLabel ?? `${label}?`);
  }
  function TypedConfirm({ placeholder, color, onConfirm, children }) {
    const [typed, setTyped] = useState("");
    return j("span", {}, [
      j("input", { placeholder, value: typed, onChange: (e) => setTyped(e.target.value), style: { fontSize: 11, width: 150, marginRight: 4 } }),
      j("button", { disabled: typed !== placeholder, onClick: async () => {
        await onConfirm();
        setTyped("");
      }, style: btn(color, typed !== placeholder) }, children),
      j("button", { onClick: () => setTyped(""), style: ghostBtn }, "\xD7")
    ]);
  }
  function useSchedStream() {
    const [state, setState] = useState({ lines: [], connected: false });
    useEffect(() => {
      let ws;
      let closed = false;
      let timer;
      const connect = () => {
        ws = new WebSocket(`ws://${location.host}/sched/ws/events`);
        ws.onopen = () => setState((s) => ({ ...s, connected: true }));
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === "log") setState((s) => ({ ...s, lines: [...s.lines.slice(-400), m.line] }));
        };
        ws.onclose = () => {
          if (!closed) timer = setTimeout(connect, 3e3);
          setState((s) => ({ ...s, connected: false }));
        };
      };
      connect();
      return () => {
        closed = true;
        clearTimeout(timer);
        ws?.close();
      };
    }, []);
    return [state];
  }
  function useSnapshot(path, ms) {
    const [data, setData] = useState(null);
    const refresh = useCallback(() => {
      fetch(path).then((r) => r.json()).then(setData).catch(() => {
      });
    }, [path]);
    useEffect(() => {
      refresh();
      const t = setInterval(refresh, ms);
      return () => clearInterval(t);
    }, [refresh]);
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
      j("span", { style: bar() }, j("span", { style: barFill(pp.done / pp.total * 100) })),
      j("span", { style: { fontSize: 10, color: T.label2 } }, p)
    ]);
  }
  function LogViewer({ taskId, onClose }) {
    const [text, setText] = useState("loading\u2026");
    useEffect(() => {
      let alive = true;
      const load = () => getText("log", `?task=${encodeURIComponent(taskId)}&lines=400`).then((t2) => {
        if (alive) setText(t2 || "(empty log)");
      }).catch((e) => {
        if (alive) setText(String(e));
      });
      load();
      const t = setInterval(load, 5e3);
      return () => {
        alive = false;
        clearInterval(t);
      };
    }, [taskId]);
    return jsxs2("div", { style: { position: "fixed", inset: 0, zIndex: 1e4, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center" } }, [
      jsxs2("div", { style: { ...panelStyle, width: "min(860px, 92vw)" }, onClick: (e) => e.stopPropagation() }, [
        jsxs2("div", { style: { display: "flex", alignItems: "center", marginBottom: 6 } }, [
          j("b", null, `log: ${taskId}`),
          j("span", { style: { flex: 1 } }),
          j("button", { onClick: onClose, style: ghostBtn }, "\xD7")
        ]),
        j("pre", { style: { ...pre, maxHeight: "60vh", overflow: "auto" } }, text)
      ])
    ]);
  }
  function Dashboard({ onClose }) {
    const [stream] = useSchedStream();
    const [snap, refreshSnap] = useSnapshot("/sched/api/status", 2e4);
    const [tab, setTab] = useState("batches");
    const [opMsg, setOpMsg] = useState("");
    const [logTask, setLogTask] = useState(null);
    const [projFilter, setProjFilter] = useState("");
    const raw = snap?.raw;
    const summary = snap?.summary;
    const projects = [...new Set((raw?.batches ?? []).map((b) => b.project).filter(Boolean))];
    const runOp = async (op, id) => {
      const r = await post("op", { op, id });
      setOpMsg(`${op} ${id ?? ""}: ${r.ok ? "ok" : `fail (${r.error ?? r.code})`} ${r.text ? "\u2014 " + String(r.text).slice(0, 120) : ""}`);
      refreshSnap();
    };
    const GRID = {
      display: "grid",
      gridTemplateColumns: "76px minmax(120px, 1.1fr) minmax(160px, 1.6fr) 56px 84px",
      gap: "0 12px",
      alignItems: "center"
    };
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
      return j("span", { style: bar() }, ["bad", "ok", "run", "off"].map(
        (k) => j("span", { key: k, style: { height: "100%", width: `${seg[k] / total * 100}%`, background: SEG_COLOR[k], display: "inline-block" } })
      ));
    }
    function BatchRow({ b }) {
      const [open, setOpen] = useState(false);
      const tasks = (raw?.jobs ?? []).filter(
        (x) => x.batch === b.id
      );
      const failedTasks = tasks.filter((x) => ["failed", "timed_out", "cancelled"].includes(x.status));
      const seg = taskSegments(tasks);
      return jsxs2("div", { style: { marginBottom: 10 } }, [
        jsxs2("div", { style: GRID, onClick: () => setOpen(!open) }, [
          j("span", { style: { textAlign: "center", cursor: "pointer" } }, Badge({ s: b.status })),
          jsxs2("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }, onClick: (e) => {
            e.stopPropagation();
            setOpen(!open);
          } }, [
            j("b", { style: { fontSize: 11.5 }, title: b.name }, b.name),
            b.project && j("span", { style: { fontSize: 9, color: T.label2, marginLeft: 6 } }, b.project)
          ]),
          j(SegmentedBar, { seg: taskSegments(tasks) }),
          j("span", { style: { fontSize: 10.5, color: T.label2, textAlign: "right" } }, b.progress ?? ""),
          j(ArmButton, {
            label: "cancel",
            confirmLabel: "cancel(\u53D6\u6D88\u4EFB\u52A1!)",
            color: T.err,
            stopProp: true,
            onConfirm: () => runOp("cancel", b.name)
          })
        ]),
        open && jsxs2("div", { style: { marginTop: 6, marginLeft: 76, paddingLeft: 10, borderLeft: `2px solid ${T.border}` } }, [
          b.depends_on?.length > 0 && j("div", { style: { fontSize: 10, color: T.label2 } }, `\u4F9D\u8D56: ${b.depends_on.join(", ")}`),
          ...tasks.filter((t) => ["failed", "timed_out", "cancelled"].includes(t.status)).map((t) => jsxs2("div", { style: { fontSize: 11, marginLeft: 14, marginTop: 2, display: "flex", alignItems: "center" } }, [
            j("span", { style: { fontFamily: "monospace", cursor: "pointer", textDecoration: "underline", marginRight: 6 }, onClick: () => setLogTask(`${t.batch}:${t.task}`), title: "\u67E5\u770B\u65E5\u5FD7" }, t.task),
            Badge({ s: t.status }),
            t.retries != null && j("span", { style: { color: T.label2, marginRight: 4 } }, `retries=${t.retries}`),
            j("span", { style: { flex: 1 } }),
            j("button", { onClick: () => runOp("retry", `${t.batch}:${t.task}`), style: btn(T.brand) }, "retry"),
            j(ArmButton, { label: "resubmit", confirmLabel: "resubmit(\u5220\u4EA7\u7269!)", color: T.warn, onConfirm: () => runOp("resubmit", `${t.batch}:${t.task}`) })
          ]))
        ])
      ]);
    }
    function GpuRow({ g }) {
      return jsxs2("div", { style: { marginBottom: 6, display: "flex", alignItems: "center" } }, [
        Badge({ s: g.status }),
        j("span", { style: { fontFamily: "monospace", marginRight: 8 } }, `GPU${g.idx}`),
        g.job && j("span", { style: { fontSize: 10, marginRight: 8, color: T.label2, flex: 1 } }, g.job),
        g.quarantined && j("span", { style: { color: T.err, marginRight: 8, fontSize: 10 } }, "[quarantined]"),
        !g.job && g.status === "free" && j("span", { style: { flex: 1 } }),
        g.status === "unmanaged" && j(ArmButton, {
          label: "gpu-free \u5F3A\u5236\u56DE\u6536",
          confirmLabel: "\u786E\u8BA4\u56DE\u6536?",
          color: T.warn,
          onConfirm: () => runOp("gpu-free", String(g.idx))
        }),
        g.quarantined && j("button", { onClick: () => runOp("gpu-ok", String(g.idx)), style: btn(T.ok) }, "gpu-ok \u89E3\u9664\u9694\u79BB")
      ]);
    }
    function EntrySwitch() {
      const [entry, setEntry] = useState(null);
      const [note, setNote] = useState("");
      useEffect(() => {
        fetch("/sched/api/entry").then((r) => r.json()).then((d) => setEntry(d.entry || "?")).catch(() => setEntry("?"));
      }, []);
      const pick = async (target) => {
        if (target === entry) return;
        setNote("\u5207\u6362\u4E2D\u2026");
        try {
          const r = await fetch("/sched/api/entry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entry: target })
          });
          const d = await r.json();
          setEntry(d.entry || target);
          setNote(d.probeText ? `\u63A2\u6D4B: ${d.probeText}` : "\u5DF2\u5207\u6362");
        } catch (e) {
          setNote("\u274C " + String(e));
        }
      };
      const seg = (label) => j("button", {
        onClick: () => pick(label),
        style: entry === label ? btn(T.brand) : ghostBtn
      }, label);
      return jsxs2("span", { style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        marginRight: 10,
        fontSize: 11
      } }, [
        j("span", { style: { color: T.label2 } }, "\u5165\u53E3"),
        seg("HPDC"),
        seg("HPDC_outside"),
        note && j("span", { style: { color: T.label2, marginLeft: 4 } }, note)
      ]);
    }
    function DaemonBar() {
      const [status, setStatus] = useState(null);
      const [querying, setQuerying] = useState(true);
      const [confirmStop, setConfirmStop] = useState(false);
      const load = useCallback(() => {
        setQuerying(true);
        fetch("/sched/api/daemon").then((r) => r.json()).then((d) => {
          if (d.ok) setStatus(d.text);
          else setStatus((prev) => prev ?? "\u67E5\u8BE2\u5931\u8D25: " + String(d.text ?? "").slice(0, 80));
          setQuerying(false);
        }).catch(() => {
          setQuerying(false);
        });
      }, []);
      useEffect(() => {
        load();
        const t = setInterval(load, 3e4);
        return () => clearInterval(t);
      }, [load]);
      const running = status != null && status.includes("\u8FD0\u884C\u4E2D");
      return jsxs2("div", { style: { marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center" } }, [
        jsxs2("span", { style: { fontSize: 11, marginRight: 8, flex: 1 } }, [
          j(
            "span",
            { style: { color: running ? T.ok : status ? T.err : T.label2 } },
            `daemon: ${status ?? ""}`
          ),
          querying && j("span", { style: { color: T.label2 } }, " \u2026\u7B49\u5F85\u67E5\u8BE2")
        ]),
        // B14: 状态联动 —— 运行中禁用 start, 未运行禁用 stop
        ...status === null ? [j("span", { key: "dw", style: btn(T.label2, true) }, "\u2026")] : [
          running ? j("button", { key: "s", disabled: true, title: "\u5DF2\u5728\u8FD0\u884C", style: btn(T.ok, true) }, "start") : j("button", { key: "s", onClick: async () => {
            await runOp("daemon-start");
            setTimeout(load, 3e3);
          }, style: btn(T.ok) }, "start"),
          running ? !confirmStop && j("button", { key: "x", onClick: () => setConfirmStop(true), style: btn(T.err) }, "stop") : j("button", { key: "x", disabled: true, title: "\u672A\u8FD0\u884C", style: btn(T.err, true) }, "stop")
        ],
        confirmStop && j(TypedConfirm, {
          placeholder: "\u8F93\u5165 stop \u786E\u8BA4\uFF08\u4F1A\u53D6\u6D88\u672A\u5B8C\u6210\u4EFB\u52A1\uFF09",
          color: T.err,
          onConfirm: async () => {
            await runOp("daemon-stop");
            setConfirmStop(false);
          }
        }, "\u786E\u8BA4 stop")
      ]);
    }
    const IncidentsTab = memo(function IncidentsTab2() {
      const [list, setList] = useState(INC_CACHE ? INC_CACHE.list : null);
      const [frozenAt, setFrozenAt] = useState(INC_CACHE ? INC_CACHE.frozenAt : "");
      const [detail, setDetail] = useState(
        INC_OPEN_ID && INC_DETAIL && INC_DETAIL[INC_OPEN_ID] ? { ...INC_DETAIL[INC_OPEN_ID], id: INC_OPEN_ID } : null
      );
      const [msg, setMsg] = useState("");
      const setDetailT = (v, tag) => {
        console.log(
          "[inc-detail\u5199] tag=" + (tag || "?") + " val=" + JSON.stringify(v && v.id ? { id: v.id, loading: !!v.loading } : v),
          new Error().stack.split("\n").slice(2, 6).join("\n    ")
        );
        setDetail(v);
      };
      const applyList = (incidents) => {
        setList(incidents);
        INC_CACHE = { list: incidents };
      };
      const applyDetail = (inc) => {
        console.log(
          "[inc-detail\u5199] tag=applyDetail id=" + inc.id,
          new Error().stack.split("\n").slice(2, 5).join("\n    ")
        );
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
          INC_DETAIL = { ...INC_DETAIL || {}, [inc.id]: inc };
          if (gen !== INC_VIEW_GEN || INC_OPEN_ID !== inc.id) return;
          setDetailT(inc, "applyDetail");
        } catch (e) {
          setDetailT({ id, error: String(e) }, "view-catch");
        }
      }, []);
      const load = useCallback(async () => {
        try {
          const r = await fetch("/sched/api/incidents?limit=30");
          const d = await r.json();
          if (!d.ok) {
            setMsg("\u274C " + (d.text || "").slice(0, 120));
            return;
          }
          applyList(JSON.parse(d.text).incidents || []);
          setFrozenAt((/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false }));
        } catch (e) {
          setMsg("\u274C " + String(e));
        }
      }, []);
      useEffect(() => {
        load();
      }, [load]);
      if (!list) return j(
        "div",
        { style: { color: T.label2, fontSize: 11 } },
        msg || (INC_CACHE ? "" : "loading\u2026")
      );
      const p = detail && !detail.loading && !detail.error ? detail.payload || {} : null;
      if (p && (!INC_DETAIL || !INC_DETAIL[detail.id])) {
        console.log(
          "[inc] \u26A0\uFE0F \u6E32\u67D3\u4E86\u5C55\u5F00\u6001\u4F46\u6A21\u5757\u7F13\u5B58\u4E2D\u65E0\u6B64\u6761\u76EE id=" + detail.id,
          "(\u6C34\u5408\u4E22\u5931\u6216\u5916\u90E8\u5199\u5165)"
        );
      }
      const failed = p ? p.failed || {} : {};
      const mem = p ? p.memory || {} : {};
      return jsxs2("div", { style: { fontSize: 11 } }, [
        jsxs2("div", { style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
          padding: "5px 8px",
          borderRadius: 6,
          background: T.bgLayer,
          border: `1px solid ${T.border}`
        } }, [
          j(EntrySwitch, null),
          j("span", { style: { color: T.warn } }, "\u23F8 \u51BB\u7ED3"),
          j(
            "span",
            { style: { color: T.label2 } },
            `\u5FEB\u7167\u65F6\u95F4 ${frozenAt || "\u2026"} \u2014\u2014 \u9605\u8BFB\u671F\u95F4\u5185\u5BB9\u4E0D\u53D8\u3002\u70B9\u300C\u5237\u65B0\u300D\u6216\u5207\u8D70\u518D\u56DE\u6765\u83B7\u53D6\u6700\u65B0\u3002`
          ),
          j("span", { style: { flex: 1 } }),
          j("button", { onClick: () => load(), style: btn(T.brand) }, "\u5237\u65B0")
        ]),
        list.length === 0 && j(
          "div",
          { style: { color: T.label2 } },
          "\u6682\u65E0\u4E8B\u6545\u5FEB\u7167 (OOM/gpu_fault \u53D1\u751F\u65F6\u81EA\u52A8\u91C7\u96C6)"
        ),
        list.map((r) => jsxs2("div", {
          key: r.id,
          onClick: () => openDetail(r.id),
          style: {
            display: "flex",
            gap: 8,
            padding: "4px 6px",
            cursor: "pointer",
            borderRadius: 4,
            background: detail && detail.id === r.id ? T.bgLayer : "transparent"
          }
        }, [
          j("span", { style: { width: 30, color: T.label2 } }, "#" + r.id),
          j("span", { style: { width: 130, color: T.label } }, r.ts),
          j("span", { style: { width: 70, color: r.kind === "oom" ? T.err : T.warn } }, r.kind),
          j("span", { style: { width: 36 } }, "gpu" + (r.gpu_idx ?? "-")),
          j(
            "span",
            { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            r.job_id
          )
        ])),
        detail && !detail.loading && !detail.error && jsxs2("div", {
          style: { border: `1px solid ${T.border}`, borderRadius: 6, padding: 8, marginTop: 8 }
        }, [
          jsxs2("div", { style: { marginBottom: 4 } }, [
            j(
              "span",
              { style: { fontWeight: 600, color: T.brand } },
              `#${detail.id} ${detail.kind} @ gpu${detail.gpu_idx ?? "-"}`
            ),
            j("button", {
              onClick: () => {
                INC_VIEW_GEN++;
                setDetailT(null, "collapse");
                INC_OPEN_ID = null;
              },
              style: { ...ghostBtn, marginLeft: 8 }
            }, "\u6536\u8D77")
          ]),
          j(
            "div",
            { style: { color: T.label2, fontSize: 10, marginBottom: 4 } },
            `${detail.ts} \xB7 job ${detail.job_id} \xB7 batch ${detail.batch_id}`
          ),
          failed.dispatch_mode && j(
            "div",
            {},
            `\u6D3E\u53D1\u65B9\u5F0F: ${failed.dispatch_mode} \xB7 \u58F0\u660E ${failed.declared_vram_gib ?? "-"} GiB \xB7 \u5386\u53F2\u5CF0\u503C ${failed.profile_peak_gib ?? "-"}`
          ),
          mem.packed_sum_gib !== void 0 && j(
            "div",
            {},
            `\u663E\u5B58: cap=${mem.cap_gib ?? "?"} packed=${mem.packed_sum_gib} actual=${mem.actual_used_gib ?? "?"}${mem.degraded ? " [\u964D\u7EA7]" : ""}`
          ),
          (mem.external_pids || []).length > 0 && jsxs2(
            "div",
            { style: { color: T.warn } },
            ["\u5916\u90E8\u8FDB\u7A0B: ", ...(mem.external_pids || []).map((e) => j("span", { key: e.pid }, `pid${e.pid}(${e.mem_mib ?? "?"}MiB) `))]
          ),
          (p.co_runners || []).length > 0 && jsxs2("div", {}, [
            j("div", { style: { color: T.label2, marginTop: 4 } }, "\u540C\u5361\u90BB\u5C45:"),
            ...p.co_runners.map((c) => j(
              "div",
              { key: c.job_id, style: { paddingLeft: 10 } },
              `${c.task} [${c.status}] declared=${c.declared_vram_gib} peak=${c.profile_peak_gib} runtime=${c.runtime_sec}s`
            ))
          ]),
          (detail.verdicts || []).length > 0 && jsxs2("div", { style: { marginTop: 6 } }, [
            j("div", { style: { color: T.warn, fontWeight: 600 } }, "\u5224\u8BFB\u5047\u8BBE:"),
            ...detail.verdicts.map((v, i2) => j("div", { key: i2, style: { color: T.warn, paddingLeft: 10 } }, "? " + v))
          ]),
          p.log_excerpt && jsxs2("div", {}, [
            j("div", { style: { color: T.label2, marginTop: 6 } }, "\u65E5\u5FD7\u6458\u5F55:"),
            j("pre", { style: { ...pre, maxHeight: 120, margin: "2px 0" } }, p.log_excerpt)
          ])
        ]),
        msg && j("div", { style: { color: T.err, fontSize: 11 } }, msg)
      ]);
    });
    function ConfigTab() {
      const [cfgText, setCfgText] = useState("");
      const [cfg, setCfg] = useState(null);
      const [msg, setMsg] = useState("");
      const [advanced, setAdvanced] = useState(false);
      const load = useCallback(() => {
        fetch("/sched/api/config").then((r) => r.json()).then((d) => {
          if (!d.ok) {
            setMsg("\u274C \u52A0\u8F7D\u5931\u8D25: " + (d.text || "").slice(0, 120));
            return;
          }
          setCfg(JSON.parse(d.text));
          setCfgText(d.text);
          setMsg("");
        }).catch(() => setMsg("\u274C \u52A0\u8F7D\u5F02\u5E38"));
      }, []);
      useEffect(() => {
        load();
      }, []);
      if (!cfg) return j("div", { style: { color: T.label2, fontSize: 11 } }, msg || "loading config\u2026");
      const upd = (fn) => setCfg((c) => {
        const n = JSON.parse(JSON.stringify(c));
        fn(n);
        return n;
      });
      async function save(patch) {
        setMsg("\u4FDD\u5B58\u4E2D\u2026");
        try {
          const r = await fetch("/sched/api/config/set", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ patch })
          });
          const d = await r.json();
          setMsg((d.ok ? "\u2705 " : "\u274C ") + (d.text || "").split("\n")[0]);
          if (d.ok) load();
        } catch (e) {
          setMsg("\u274C " + e);
        }
      }
      const numInput = (value, onChange, style) => j("input", {
        value: value ?? "",
        onChange: (e) => onChange(e.target.value === "" ? null : Number(e.target.value)),
        style: { ...style, width: 52, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, padding: "2px 4px", fontSize: 11 }
      });
      const secTitle = (t) => j("div", { style: { fontSize: 11, color: T.brand, margin: "8px 0 4px", fontWeight: 600 } }, t);
      const rowStyle = { display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11, flexWrap: "wrap" };
      const projects2 = cfg.projects || {};
      const projRows = Object.entries(projects2).map(([name2, pj]) => jsxs2("div", { key: name2, style: rowStyle }, [
        j("span", { style: { width: 80, color: T.label } }, name2),
        j("span", { style: { color: T.label2 } }, "\u914D\u989D"),
        numInput(pj.gpu_quota, (v) => upd((n) => {
          if (v === null) delete n.projects[name2].gpu_quota;
          else n.projects[name2].gpu_quota = v;
        })),
        j("span", { style: { color: T.label2 } }, "\u4F18\u5148\u7EA7"),
        numInput(pj.priority ?? 0, (v) => upd((n) => {
          n.projects[name2].priority = v ?? 0;
        })),
        j("span", { style: { color: T.label2 } }, "\u5355\u5361\u4E0A\u9650"),
        numInput(pj.max_jobs, (v) => upd((n) => {
          if (v === null) delete n.projects[name2].max_jobs;
          else n.projects[name2].max_jobs = v;
        })),
        j("select", {
          value: pj.colocate === void 0 ? "" : String(pj.colocate),
          onChange: (e) => upd((n) => {
            const v = e.target.value;
            if (v === "") delete n.projects[name2].colocate;
            else n.projects[name2].colocate = v === "true";
          }),
          style: { background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, fontSize: 11 }
        }, [
          j("option", { value: "" }, "colocate\u8DDF\u968F\u5168\u5C40"),
          j("option", { value: "true" }, "\u5141\u8BB8\u5171\u4EAB"),
          j("option", { value: "false" }, "\u7981\u7528(\u72EC\u5360)")
        ]),
        j("span", { style: { color: T.label2 } }, "\u4EB2\u548C\u5361 " + JSON.stringify(pj.gpu_affinity || []))
      ]));
      const buildProjectsPatch = () => {
        const patch = {};
        for (const [name2, pj] of Object.entries(cfg.projects || {})) {
          patch.projects = patch.projects || {};
          patch.projects[name2] = {};
          for (const k of ["gpu_quota", "priority", "max_jobs"]) {
            if (pj[k] !== void 0 && pj[k] !== null) patch.projects[name2][k] = pj[k];
          }
          if (pj.colocate !== void 0) patch.projects[name2].colocate = pj.colocate;
        }
        return { projects: patch.projects };
      };
      const cl = cfg.co_locate;
      const clPatch = () => ({ co_locate: !!cl, co_locate_safety: Number(cfg.co_locate_safety ?? 0.7), co_locate_max_jobs: Number(cfg.co_locate_max_jobs ?? 3) });
      const nf = cfg.notify || {};
      const evOn = (e) => Array.isArray(nf.on) && nf.on.includes(e);
      const fileOn = !!(nf.file && nf.file.enabled);
      const notifyPatch = () => ({
        notify: {
          on: ["batch_done", "batch_blocked"].filter((e, i) => [e === "batch_done" ? evOn("batch_done") : true, e === "batch_blocked" ? evOn("batch_blocked") : true][i] !== false || evOn(e)),
          file: { ...nf.file || {}, enabled: fileOn }
        }
      });
      return jsxs2("div", { style: { fontSize: 11 } }, [
        secTitle("\u9879\u76EE\u53C2\u6570\uFF08\u53CC\u9879\u76EE\u5171\u4EAB\u914D\u7F6E \u2014 \u4FDD\u5B58\u5F71\u54CD\u4E24\u4E2A\u4EE3\u7406\uFF09"),
        jsxs2("div", { style: rowStyle }, [
          j("span", { style: { color: T.err } }, "\u26A0\uFE0F \u4FDD\u5B58\u9700\u4E8C\u6B21\u786E\u8BA4\uFF1B\u51B7\u952E(node/state_dir/gpus \u5361\u96C6)\u4EC5\u53EF\u8BFB\uFF0C\u53D8\u66F4\u987B ssh \u91CD\u542F daemon")
        ]),
        projRows,
        j(ArmButton, {
          label: "\u4FDD\u5B58\u9879\u76EE\u53C2\u6570",
          confirmLabel: "\u786E\u8BA4\u4FDD\u5B58?",
          color: T.brand,
          onConfirm: () => save(buildProjectsPatch())
        }),
        secTitle("co-location \u5168\u5C40"),
        jsxs2("div", { style: rowStyle }, [
          j("label", { style: { color: T.label } }, [
            j("input", { type: "checkbox", checked: !!cl, onChange: (e) => upd((n) => {
              n.co_locate = e.target.checked;
            }) }),
            " \u542F\u7528\u5171\u4EAB\u88C5\u7BB1"
          ]),
          j("span", { style: { color: T.label2 } }, "safety"),
          j("input", {
            value: cfg.co_locate_safety ?? 0.7,
            onChange: (e) => upd((n) => {
              n.co_locate_safety = Number(e.target.value);
            }),
            style: { width: 50, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 4, fontSize: 11 }
          }),
          j("span", { style: { color: T.label2 } }, "\u6BCF\u5361\u4E0A\u9650"),
          numInput(cfg.co_locate_max_jobs ?? 3, (v) => upd((n) => {
            if (v !== null) n.co_locate_max_jobs = v;
          })),
          j(ArmButton, { label: "\u4FDD\u5B58", confirmLabel: "\u786E\u8BA4\u4FDD\u5B58?", color: T.brand, onConfirm: () => save(clPatch()) })
        ]),
        secTitle("\u901A\u77E5"),
        jsxs2("div", { style: rowStyle }, [
          j("label", { style: { color: T.label } }, [
            j("input", {
              type: "checkbox",
              checked: evOn("batch_done"),
              onChange: (e) => upd((n) => {
                n.notify = n.notify || {};
                n.notify.on = n.notify.on || [];
                n.notify.on = e.target.checked ? [.../* @__PURE__ */ new Set([...n.notify.on, "batch_done"])] : n.notify.on.filter((x) => x !== "batch_done");
              })
            }),
            " batch_done"
          ]),
          j("label", { style: { color: T.label, marginRight: 10 } }, [
            j("input", {
              type: "checkbox",
              checked: evOn("batch_blocked"),
              onChange: (e) => upd((n) => {
                n.notify = n.notify || {};
                n.notify.on = n.notify.on || [];
                n.notify.on = e.target.checked ? [.../* @__PURE__ */ new Set([...n.notify.on, "batch_blocked"])] : n.notify.on.filter((x) => x !== "batch_blocked");
              })
            }),
            " batch_blocked"
          ]),
          j("label", { style: { color: T.label, marginRight: 10 } }, [
            j("input", {
              type: "checkbox",
              checked: fileOn,
              onChange: (e) => upd((n) => {
                n.notify = n.notify || {};
                n.notify.file = { ...n.notify.file || {}, enabled: e.target.checked };
              })
            }),
            " file \u6E20\u9053"
          ]),
          j(ArmButton, { label: "\u4FDD\u5B58\u901A\u77E5\u8BBE\u7F6E", confirmLabel: "\u786E\u8BA4\u4FDD\u5B58?", color: T.brand, onConfirm: () => save(notifyPatch()) })
        ]),
        secTitle("\u51B7\u952E\uFF08\u53EA\u8BFB\uFF09"),
        jsxs2("div", { style: { ...rowStyle, color: T.label2 } }, [
          j("span", {}, `node=${cfg.node} \xB7 user=${cfg.user} \xB7 gpus=${JSON.stringify(cfg.gpus)}`)
        ]),
        jsxs2("div", { style: rowStyle }, [
          j("button", { onClick: () => setAdvanced(!advanced), style: ghostBtn }, advanced ? "\u6536\u8D77\u9AD8\u7EA7\u6A21\u5F0F" : "\u9AD8\u7EA7\u6A21\u5F0F (\u539F\u59CB JSON)"),
          advanced && j(ArmButton, {
            label: "\u4FDD\u5B58\u5B8C\u6574 JSON",
            confirmLabel: "\u786E\u8BA4\u4FDD\u5B58\u5168\u90E8?",
            color: T.warn,
            onConfirm: async () => {
              try {
                JSON.parse(cfgText);
              } catch (e) {
                setMsg("\u274C JSON \u89E3\u6790\u5931\u8D25");
                return;
              }
              upd(() => {
              });
              await save(JSON.parse(cfgText));
            }
          })
        ]),
        advanced && j("textarea", {
          value: cfgText,
          onChange: (e) => setCfgText(e.target.value),
          style: { width: "100%", minHeight: 200, background: T.bgLayer, border: `1px solid ${T.border}`, color: T.label, borderRadius: 6, fontSize: 11, fontFamily: "monospace", padding: 6 }
        }),
        msg && j("div", { style: { fontSize: 11, marginTop: 6, color: msg.startsWith("\u2705") ? T.ok : T.warn } }, msg)
      ]);
    }
    function SubmitTab() {
      const [text, setText] = useState("");
      const [preview, setPreview] = useState(null);
      const [msg, setMsg] = useState("");
      const doDryRun = async () => {
        setPreview(null);
        setMsg("dry-run \u4E2D\u2026");
        try {
          const r = await post("dryrun", { content: text });
          setPreview(r);
          setMsg(r.ok ? "\u9884\u89C8\u901A\u8FC7\uFF0C\u53EF\u63D0\u4EA4" : "\u9884\u89C8\u5931\u8D25");
        } catch (e) {
          setMsg(String(e));
        }
      };
      const doSubmit = async () => {
        setMsg("\u63D0\u4EA4\u4E2D\u2026");
        try {
          const r = await post("submit", { content: text });
          setMsg(r.ok ? `\u5DF2\u63D0\u4EA4\uFF1A${String(r.text).slice(0, 160)}` : `\u5931\u8D25\uFF1A${String(r.text).slice(0, 160)}`);
          if (r.ok) {
            setPreview(null);
            setText("");
            refreshSnap();
            setTab("batches");
          }
        } catch (e) {
          setMsg(String(e));
        }
      };
      return jsxs2("div", {}, [
        j("textarea", {
          value: text,
          onChange: (e) => setText(e.target.value),
          placeholder: '\u7C98\u8D34 batch.json\uFF0C\u4F8B\u5982 {"schema_version":1,"name":"my_batch","tasks":[{"id":"t1","cmd":["{VENV:k}","..."],"duration_min":5}]}\uFF08venv \u522B\u540D\u89C1\u8FDC\u7AEF config.venvs\uFF0C\u5F53\u524D\u4E3A k\uFF09',
          style: { width: "100%", height: 150, fontFamily: "monospace", fontSize: 11 }
        }),
        jsxs2("div", { style: { margin: "6px 0" } }, [
          j("button", { onClick: doDryRun, disabled: !text.trim(), style: btn(T.brand, !text.trim()) }, "\u2460 dry-run \u9884\u89C8"),
          j("button", { onClick: doSubmit, disabled: !(preview?.ok && text.trim()), style: btn(T.ok, !(preview?.ok && text.trim())) }, "\u2461 \u786E\u8BA4\u63D0\u4EA4"),
          j("span", { style: { fontSize: 11, marginLeft: 8 } }, msg)
        ]),
        preview && j("pre", { style: { ...pre, maxHeight: 240, overflow: "auto" } }, preview.text)
      ]);
    }
    return j("div", { style: overlayStyle, onClick: onClose }, [
      jsxs2("div", { style: panelStyle, onClick: (e) => e.stopPropagation() }, [
        jsxs2("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } }, [
          j("b", null, "node-sched"),
          j("span", { style: { color: stream.connected ? T.ok : T.err, fontSize: 11 } }, stream.connected ? "\u25CF live" : "\u25CB offline"),
          j("button", { onClick: refreshSnap, style: ghostBtn }, "refresh"),
          j("select", {
            value: projFilter,
            onChange: (e) => setProjFilter(e.target.value),
            style: { background: "transparent", border: `1px solid ${T.border}`, color: T.label, borderRadius: 6, padding: "3px 6px", fontSize: 11, marginRight: 4 }
          }, [
            j("option", { value: "" }, "all projects"),
            ...projects.map((pr) => j("option", { key: pr, value: pr }, pr))
          ]),
          ...["batches", "gpus", "events", "submit", "config", "incidents"].map((t) => j("button", { key: t, onClick: () => setTab(t), style: tab === t ? btn(T.brand) : ghostBtn }, t)),
          j("span", { style: { flex: 1 } }),
          j("button", { onClick: onClose, style: ghostBtn }, "\xD7")
        ]),
        opMsg && j("div", { style: { fontSize: 11, color: T.warn, marginBottom: 4 } }, opMsg),
        tab === "batches" && jsxs2("div", null, [
          j(DaemonBar, null),
          !summary && j("div", null, "loading\u2026"),
          summary && j("pre", { style: { ...pre, maxHeight: 110, overflow: "auto" } }, summary.split("\njobs:")[0]),
          raw && jsxs2("div", {}, [
            jsxs2("div", { style: { fontSize: 10, color: T.label2, marginBottom: 6 } }, [
              j("span", { style: { marginRight: 10, color: "#ef4444" } }, "\u25A0 \u7EA2=\u51FA\u9519"),
              j("span", { style: { marginRight: 10, color: "#22c55e" } }, "\u25A0 \u7EFF=\u6210\u529F"),
              j("span", { style: { marginRight: 10, color: "#3b82f6" } }, "\u25A0 \u84DD=\u8FD0\u884C\u4E2D"),
              j("span", { style: { color: "#9ca3af" } }, "\u25A0 \u7070=\u6392\u961F/\u53D6\u6D88")
            ]),
            (raw.batches ?? []).filter((b) => !["done", "skip"].includes(b.status)).filter((b) => !projFilter || b.project === projFilter).map((b) => j(BatchRow, { key: b.id ?? b.name, b }))
          ])
        ]),
        tab === "gpus" && jsxs2("div", { key: "tab-gpus" }, [
          raw && (raw.gpus ?? []).map((g) => j(GpuRow, { key: g.idx, g })),
          !raw && j("div", null, "loading\u2026")
        ]),
        tab === "events" && j("pre", { key: "tab-events", style: { ...pre, maxHeight: "55vh", overflow: "auto" } }, stream.lines.join("\n") || "(no events yet)"),
        tab === "submit" && j(SubmitTab, { key: "tab-submit" }),
        tab === "config" && j(ConfigTab, { key: "tab-config" }),
        tab === "incidents" && j(IncidentsTab, { key: "tab-incidents" }),
        logTask && j(LogViewer, { taskId: logTask, onClose: () => setLogTask(null) })
      ])
    ]);
  }
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
        title: "node-sched GPU/CPU \u8C03\u5EA6\u770B\u677F",
        style: { ...ghostBtn, width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 12 }
      }, "\u26A1 sched \u770B\u677F"),
      open && j(Dashboard, { onClose: () => {
        setOpen(false);
      } })
    ]);
  }
  function StatusCard() {
    const [open, setOpen] = useState(false);
    const [snap] = useSnapshot("/sched/api/status", 3e4);
    const raw = snap?.raw;
    const gpus = raw?.gpus ?? [];
    const batches = raw?.batches ?? [];
    const stColor = {
      free: "#22c55e",
      assigned: "#3b82f6",
      releasing: "#eab308",
      unmanaged: "#f97316",
      quarantined: "#ef4444"
    };
    const act = batches.filter((b) => b.status === "active").length;
    const blk = batches.filter((b) => b.status === "blocked").length;
    const done = batches.filter((b) => ["done", "skip"].includes(b.status)).length;
    const freeN = gpus.filter((g) => g.status === "free").length;
    return jsxs2("div", { style: {
      border: `1px solid ${T.border}`,
      borderRadius: 8,
      background: T.bgLayer,
      fontSize: 11,
      overflow: "hidden"
    } }, [
      // 收起态摘要行 (点击整行切换)
      jsxs2("div", {
        onClick: () => setOpen(!open),
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          cursor: "pointer",
          userSelect: "none"
        }
      }, [
        j("span", { style: { color: T.brand } }, "\u26A1"),
        j("span", { style: { fontWeight: 700 } }, "node-sched \u8C03\u5EA6\u5668"),
        j(
          "span",
          { style: { color: freeN > 0 ? "#22c55e" : T.label2 } },
          `${freeN}/${gpus.length || "?"} GPU \u7A7A\u95F2`
        ),
        (act > 0 || blk > 0) && j(
          "span",
          { style: { color: T.label2 } },
          `\u6D3B\u8DC3 ${act}\xB7 \u963B\u585E ${blk}`
        ),
        j("span", { style: { flex: 1 } }),
        j("span", { style: { color: T.label2, fontSize: 10 } }, open ? "\u25BE" : "\u25B8")
      ]),
      // 展开态: GPU 彩片 + 批次统计 + 打开面板按钮
      open && jsxs2("div", { style: { padding: "0 12px 10px" } }, [
        jsxs2(
          "div",
          { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 } },
          gpus.map((g) => jsxs2("span", { key: g.idx, style: {
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            padding: "2px 6px",
            color: stColor[g.status] || T.label2
          } }, [
            j("span", { style: { marginRight: 4, color: T.label } }, "GPU" + g.idx),
            g.status
          ]))
        ),
        jsxs2("div", { style: { display: "flex", alignItems: "center" } }, [
          j(
            "span",
            { style: { color: T.label2 } },
            `\u6279\u6B21: \u6D3B\u8DC3 ${act} \xB7 \u963B\u585E ${blk} \xB7 \u5B8C\u6210 ${done}`
          ),
          j("span", { style: { flex: 1 } }),
          j("button", {
            onClick: () => window.dispatchEvent(new CustomEvent("nodesched-open")),
            style: btn(T.brand)
          }, "\u6253\u5F00\u9762\u677F")
        ])
      ])
    ]);
  }
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
        title: "node-sched GPU/CPU \u8C03\u5EA6\u770B\u677F",
        style: { ...ghostBtn, width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 12 }
      }, "\u26A1 sched \u770B\u677F"),
      open && j(Dashboard, { onClose: () => {
        setOpen(false);
      } })
    ]);
  }
  function StatusCard() {
    const [snap] = useSnapshot("/sched/api/status", 3e4);
    const raw = snap?.raw;
    const gpus = raw?.gpus ?? [];
    const batches = raw?.batches ?? [];
    const stColor = {
      free: "#22c55e",
      assigned: "#3b82f6",
      releasing: "#eab308",
      unmanaged: "#f97316",
      quarantined: "#ef4444"
    };
    const act = batches.filter((b) => b.status === "active").length;
    const blk = batches.filter((b) => b.status === "blocked").length;
    const done = batches.filter((b) => ["done", "skip"].includes(b.status)).length;
    const openPanel = () => window.dispatchEvent(new CustomEvent("nodesched-open"));
    return jsxs2("div", { style: {
      border: `1px solid ${T.border}`,
      borderRadius: 8,
      padding: "10px 12px",
      background: T.bgLayer,
      fontSize: 11,
      fontFamily: "ui-monospace,monospace"
    } }, [
      jsxs2("div", { style: { display: "flex", alignItems: "center", marginBottom: 8 } }, [
        j(
          "span",
          { style: { fontWeight: 700, color: T.brand, fontSize: 12 } },
          "\u26A1 node-sched \u8C03\u5EA6\u5668"
        ),
        j("span", { style: { flex: 1 } }),
        j("button", { onClick: openPanel, style: btn(T.brand) }, "\u6253\u5F00\u9762\u677F")
      ]),
      jsxs2(
        "div",
        { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 } },
        gpus.map((g) => jsxs2("span", { key: g.idx, style: {
          border: `1px solid ${T.border}`,
          borderRadius: 4,
          padding: "2px 6px",
          color: stColor[g.status] || T.label2
        } }, [
          j("span", { style: { marginRight: 4, color: T.label } }, "GPU" + g.idx),
          g.status
        ]))
      ),
      jsxs2(
        "div",
        { style: { color: T.label2 } },
        `\u6D3B\u8DC3 ${act} \xB7 \u963B\u585E ${blk} \xB7 \u5B8C\u6210 ${done}`
      )
    ]);
  }
  cctx.logger?.info?.("[node-sched-ui] mounting footer entry + settings card");
  const disposeFooter = cctx.slots.inject(SLOT_FOOTER, () => cctx.slots.register({ name: SLOT_FOOTER, id: NS }, FooterEntry));
  const disposeSettings = cctx.slots.inject(SLOT_SETTINGS, () => cctx.slots.register({ name: SLOT_SETTINGS, id: NS, order: 90 }, StatusCard));
  return () => {
    disposeFooter?.();
    disposeSettings?.();
  };
}
		return module.exports;
	}
});
