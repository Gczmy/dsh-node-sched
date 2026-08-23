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

// packages/node-sched-ui/src/client.jsx
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
  const { useEffect, useState, useCallback } = require("react");
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
  function ArmButton({ label, confirmLabel, color, onConfirm }) {
    const [armed, setArmed] = useState(false);
    if (!armed) return j("button", { onClick: () => setArmed(true), style: btn(color) }, label);
    return j("button", { onClick: async () => {
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
          j("button", { onClick: (e) => {
            e.stopPropagation();
            runOp("cancel", b.name);
          }, style: btn(T.err) }, "cancel")
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
        g.status === "unmanaged" && j("button", { onClick: () => runOp("gpu-free", String(g.idx)), style: btn(T.ok) }, "gpu-free \u5F3A\u5236\u56DE\u6536"),
        g.quarantined && j("button", { onClick: () => runOp("gpu-ok", String(g.idx)), style: btn(T.ok) }, "gpu-ok \u89E3\u9664\u9694\u79BB")
      ]);
    }
    function DaemonBar() {
      const [status, setStatus] = useState("");
      const [confirmStop, setConfirmStop] = useState(false);
      const load = useCallback(() => {
        getText("daemon").then((t) => setStatus(t.trim().slice(0, 120))).catch(() => {
        });
      }, []);
      useEffect(() => {
        load();
        const t = setInterval(load, 3e4);
        return () => clearInterval(t);
      }, [load]);
      return jsxs2("div", { style: { marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center" } }, [
        j("span", { style: { fontSize: 11, marginRight: 8, flex: 1 } }, `daemon: ${status || "?"}`),
        j("button", { onClick: async () => {
          await runOp("daemon-start");
          setTimeout(load, 3e3);
        }, style: btn(T.ok) }, "start"),
        !confirmStop && j("button", { onClick: () => setConfirmStop(true), style: btn(T.err) }, "stop"),
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
          ...["batches", "gpus", "events", "submit"].map((t) => j("button", { key: t, onClick: () => setTab(t), style: tab === t ? btn(T.brand) : ghostBtn }, t)),
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
        tab === "gpus" && jsxs2("div", null, [
          raw && (raw.gpus ?? []).map((g) => j(GpuRow, { key: g.idx, g })),
          !raw && j("div", null, "loading\u2026")
        ]),
        tab === "events" && j("pre", { style: { ...pre, maxHeight: "55vh", overflow: "auto" } }, stream.lines.join("\n") || "(no events yet)"),
        tab === "submit" && j(SubmitTab, null),
        logTask && j(LogViewer, { taskId: logTask, onClose: () => setLogTask(null) })
      ])
    ]);
  }
  function FooterEntry(props) {
    const [open, setOpen] = useState(false);
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
    const gpus = (raw?.gpus ?? []).map((g) => `${g.idx}:${g.status}`).join(" ");
    const active = (raw?.batches ?? []).filter((b) => !["done", "skip"].includes(b.status)).length;
    return jsxs2("div", { style: { fontFamily: "ui-monospace,monospace", fontSize: 11, lineHeight: 1.6 } }, [
      jsxs2("div", {}, [
        j("b", null, "node-sched"),
        j("span", { style: { margin: "0 6px", color: T.label2 } }, "GPU"),
        gpus || "?"
      ]),
      j("div", { style: { color: T.label2 } }, `\u6D3B\u8DC3/\u963B\u585E\u6279\u6B21: ${active}\uFF1B\u70B9\u4FA7\u680F\u5E95\u90E8\u300C\u26A1 sched \u770B\u677F\u300D\u6253\u5F00\u5B8C\u6574\u9762\u677F`)
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
