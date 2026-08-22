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
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var SLOT = "web-ui.plugin.item";
var NS = "nodesched";
var inject = [];
function apply(cctx, config) {
  const { useEffect, useState, useCallback } = require("react");
  const { jsx: _jsx, jsxs } = require("react/jsx-runtime");
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
          setState(
            (s) => m.type === "status" ? { ...s, summary: m.summary ?? s.summary } : { ...s, lines: [...s.lines.slice(-500), m.line] }
          );
        };
        ws.onclose = () => {
          if (!closed) setTimeout(connect, 3e3);
          setState((s) => ({ ...s, connected: false }));
        };
      };
      connect();
      return () => {
        closed = true;
        ws?.close();
      };
    }, []);
    return [state, setState];
  }
  function useSnapshot(path, deps = []) {
    const [data, setData] = useState(null);
    const refresh = useCallback(() => {
      fetch(path).then((r) => r.json()).then(setData).catch(() => {
      });
    }, deps);
    useEffect(() => {
      refresh();
      const t = setInterval(refresh, 15e3);
      return () => clearInterval(t);
    }, [refresh]);
    return [data, refresh];
  }
  async function post(action, body) {
    const r = await fetch(`/sched/api/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return r.json();
  }
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
        placeholder: `\u8F93\u5165 ${id} \u786E\u8BA4`,
        value: typed,
        onChange: (e) => setTyped(e.target.value),
        style: { fontSize: 11, width: 130, marginRight: 4 }
      }),
      j("button", {
        disabled: typed !== id,
        onClick: async () => {
          await post("cancel", { id });
          setArming(false);
          setTyped("");
          onDone?.();
        },
        style: btn(typed === id ? "#c62828" : "#999")
      }, "\u786E\u8BA4\u53D6\u6D88"),
      j("button", { onClick: () => setArming(false) }, "\xD7")
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
        j(
          "span",
          { style: { color: stream.connected ? "#2e7d32" : "#c62828", fontSize: 11 } },
          stream.connected ? "\u25CF live" : "\u25CB offline"
        ),
        j("button", { onClick: refreshSnap, style: btn("#555") }, "refresh"),
        ...["batches", "gpus", "events"].map((t) => j("button", { key: t, onClick: () => setTab(t), style: btn(tab === t ? "#333" : "#aaa") }, t))
      ]),
      tab === "batches" && jsxs("div", null, [
        !summary && j("div", null, "loading\u2026"),
        summary && j("pre", { style: pre }, summary)
      ]),
      tab === "gpus" && j("pre", { style: pre }, gpus?.text ?? "loading\u2026"),
      tab === "events" && j(
        "pre",
        { style: { ...pre, maxHeight: 260, overflow: "auto" } },
        stream.lines.join("\n") || "(no events yet)"
      )
    ]);
  }
  const pre = { margin: 0, whiteSpace: "pre-wrap", background: "rgba(127,127,127,.08)", borderRadius: 6, padding: 8 };
  cctx.logger?.info?.("[node-sched-ui] mounting dashboard panel");
  const disposeInject = cctx.slots.inject(
    SLOT,
    () => cctx.slots.register({
      name: SLOT,
      id: NS,
      order: 90
    }, Dashboard)
  );
  return () => disposeInject?.();
}
	return module.exports;
});
