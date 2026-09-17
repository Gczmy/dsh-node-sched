import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transform } from "esbuild";
import * as contracts from "../src/ui-contracts.js";

const clientCode = readFile(new URL("../src/client.jsx", import.meta.url), "utf8")
	.then((source) => transform(source, { format: "cjs", loader: "jsx" }))
	.then((result) => result.code);

// Execute the actual plugin with the 0.1.6 slot contract: main is keyed,
// panel-list/settings entries use ids, and root props supply usePanelInfo.
// The hook harness commits effects and their cleanups without a browser/SSH.
async function createHarness({ ready = false, declared = true } = {}) {
	let current;
	const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
	const react = {
		useState(initial) {
			const owner = current;
			const index = owner.cursor++;
			const cell = owner.cells[index] ??= { value: typeof initial === "function" ? initial() : initial };
			return [cell.value, (next) => { cell.value = typeof next === "function" ? next(cell.value) : next; }];
		},
		useRef(value) {
			return (current.cells[current.cursor++] ??= { current: value });
		},
		useEffect(effect, deps) {
			const cell = current.cells[current.cursor++] ??= {};
			if (sameDeps(cell.deps, deps)) return;
			current.effects.push(() => { cell.cleanup?.(); cell.cleanup = effect(); cell.deps = deps; });
		},
		useCallback(callback, deps) {
			const cell = current.cells[current.cursor++] ??= {};
			if (!sameDeps(cell.deps, deps)) { cell.value = callback; cell.deps = deps; }
			return cell.value;
		},
		memo: (component) => component,
	};
	const renderComponent = (component, props) => {
		const owner = {
			cells: [], cursor: 0, effects: [], tree: null,
			render() {
				this.cursor = 0; this.effects = []; current = this;
				this.tree = component(props);
				current = null;
				for (const effect of this.effects) effect();
				return this.tree;
			},
			unmount() { for (const cell of this.cells) cell.cleanup?.(); this.cells = []; this.tree = null; },
		};
		owner.render();
		return owner;
	};
	const calls = { restore: [], cancel: 0, disposed: 0, requests: [], navigation: [] };
	let gate;
	class AuthGate {
		constructor() { gate = this; this.state = { status: ready ? "ready" : "locked", hasTrustedDevice: false }; this.listeners = new Set(); }
		snapshot() { return this.state; }
		subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
		restore(options) { calls.restore.push(options); return Promise.resolve(); }
		cancelPending() { calls.cancel++; }
		dispose() { calls.disposed++; }
		isReady() { return this.state.status === "ready"; }
		webSocketProtocols() { return ["sched-auth", "test-token"]; }
		authorizedFetch(input) {
			calls.requests.push(input);
			return Promise.resolve({ ok: true, json: async () => ({ ok: true, raw: { gpus: [], batches: [], jobs: [] } }) });
		}
	}
	const styles = new Map();
	const events = new Map();
	const timers = new Map();
	let nextTimer = 0;
	const sockets = [];
	class Socket {
		static OPEN = 1;
		constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
		close() { this.closed = true; }
		send() {}
	}
	const sandbox = {
		exports: {}, module: { exports: {} },
		require(id) {
			if (id === "react") return react;
			if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
			if (id === "./auth-gate.js") return { BrowserAuthGate: AuthGate, IndexedDbTrustedDeviceStore: class {} };
			if (id === "./ui-contracts.js") return {
				...contracts,
				createIndexedDbRequestStore: () => ({
					claim: async () => "test-request",
					claimOperation: async (_key, op, entity) => contracts.buildOperationRequest(op, entity, "test-request"),
					complete: async () => {},
				}),
			};
			throw new Error(`Unexpected client dependency: ${id}`);
		},
		document: {
			getElementById: (id) => styles.get(id),
			createElement: (tag) => { assert.equal(tag, "style"); return {}; },
			head: { appendChild: (element) => styles.set(element.id, element) },
		},
		window: {
			addEventListener: (name, fn) => events.set(name, fn),
			removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); },
		},
		location: { protocol: "http:", host: "localhost" }, WebSocket: Socket,
		fetch: () => { throw new Error("Unexpected unauthenticated request"); },
		setInterval: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
		clearInterval: (id) => timers.delete(id),
		setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
		clearTimeout: (id) => timers.delete(id),
		URLSearchParams, AbortController, TextEncoder, console,
	};
	vm.runInNewContext(await clientCode, sandbox);
	const plugin = sandbox.module.exports;
	assert.deepEqual([...plugin.inject], ["slots", "layout"]);
	const kinds = new Map(declared ? [["main", "keyed"], ["sidebar.panellist", "list"], ["settings.section", "list"]] : []);
	const entries = new Map();
	const watchers = new Set();
	let activePanelId = null;
	let mainRoot;
	const usePanelInfo = (selector) => selector({ activePanelId });
	const layout = {
		selectPanel(id) {
			assert.ok(id === null || entries.has(`main:${id}`), `unregistered main panel: ${id}`);
			calls.navigation.push(id);
			mainRoot?.unmount(); mainRoot = null;
			activePanelId = id;
			if (id !== null) mainRoot = renderComponent(entries.get(`main:${id}`).component, { usePanelInfo });
		},
	};
	const slots = {
		inject(name, install) {
			const watcher = { name, install, cleanup: null };
			watchers.add(watcher);
			if (kinds.has(name)) watcher.cleanup = install();
			return () => { watchers.delete(watcher); watcher.cleanup?.(); };
		},
		register(options, component) {
			const kind = kinds.get(options.name);
			assert.ok(kind, `slot not declared: ${options.name}`);
			const key = kind === "keyed" ? options.key : options.id;
			assert.ok(key, `${kind} entry requires ${kind === "keyed" ? "key" : "id"}`);
			const address = `${options.name}:${key}`;
			assert.ok(!entries.has(address), `duplicate entry ${address}`);
			entries.set(address, { options, component });
			return () => {
				if (options.name === "main" && activePanelId === key) layout.selectPanel(null);
				entries.delete(address);
			};
		},
	};
	const dispose = plugin.apply({ slots, layout }, {});
	return {
		calls, entries, events, styles, timers, sockets, gate, layout, dispose, renderComponent,
		get mainRoot() { return mainRoot; },
		declare(name, kind) {
			kinds.set(name, kind);
			for (const watcher of [...watchers]) if (watcher.name === name) watcher.cleanup = watcher.install();
		},
	};
}

function elements(tree, predicate) {
	if (!tree || typeof tree !== "object") return [];
	if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
	return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

test("DSH 0.1.6 slots register a keyed panel and a glyph-only sidebar item without starting auth", async () => {
	const h = await createHarness({ declared: false });
	assert.equal(h.entries.size, 0);
	h.declare("main", "keyed");
	assert.ok(h.entries.has("main:sched"));
	h.declare("sidebar.panellist", "list");
	h.declare("settings.section", "list");
	assert.equal(h.entries.size, 3);
	const sidebar = h.entries.get("sidebar.panellist:sched");
	assert.equal(sidebar.options.label, "sched 看板");
	const glyph = h.renderComponent(sidebar.component, { size: 18, active: true }).tree;
	assert.equal(glyph.type, "svg");
	assert.equal(glyph.props.width, 18);
	assert.equal(elements(glyph, (el) => el.type === "button").length, 0);
	assert.equal(h.calls.restore.length, 0);
	assert.equal(h.calls.requests.length, 0);
	h.dispose();
	assert.equal(h.entries.size, 0);
	assert.equal(h.events.size, 0);
	assert.equal(h.calls.disposed, 1);
});

test("host session/Logo navigation unmounts the selected dashboard and cancels pending authentication", async () => {
	const h = await createHarness();
	h.layout.selectPanel("sched");
	assert.equal(h.calls.restore.length, 1);
	assert.equal(h.mainRoot.tree.props.children.type.name, "AuthenticationRequiredView");
	assert.equal(h.calls.requests.length, 0);
	const previousRoot = h.mainRoot;
	// ui-workspace.startSession (including the Logo action) commits this transition.
	h.layout.selectPanel(null);
	assert.equal(h.mainRoot, null);
	assert.equal(previousRoot.tree, null);
	assert.ok(h.calls.cancel > 0);
	assert.equal(h.gate.listeners.size, 0);
	assert.equal(h.entries.has("main:sched"), true);
	h.dispose();
});

test("a retained but inactive main component stays dormant and removes its dashboard subtree", async () => {
	const h = await createHarness({ ready: true });
	const entry = h.entries.get("main:sched");
	const root = h.renderComponent(entry.component, { usePanelInfo: (selector) => selector({ activePanelId: null }) });
	assert.equal(root.tree, null);
	assert.equal(h.calls.restore.length, 0);
	assert.equal(h.calls.requests.length, 0);
	root.unmount();
	h.dispose();
});

test("settings section opens the registered panel directly and closes the settings shell", async () => {
	const h = await createHarness();
	const entry = h.entries.get("settings.section:nodesched");
	assert.equal(entry.options.label, "sched 调度器");
	let closed = 0;
	const settings = h.renderComponent(entry.component, { close: () => { closed++; } });
	const header = elements(settings.tree, (el) => el.type === "button")[0];
	header.props.onClick();
	settings.render();
	const open = elements(settings.tree, (el) => el.type === "button" && el.props.children === "打开面板")[0];
	assert.ok(open);
	assert.equal(h.calls.requests.length, 0);
	open.props.onClick();
	assert.equal(closed, 1);
	assert.equal(h.calls.navigation.at(-1), "sched");
	assert.ok(h.mainRoot.tree);
	settings.unmount();
	h.dispose();
});

test("rendered dashboard button recipes expose classes as props and preserve legal CSS only", async () => {
	const h = await createHarness({ ready: true });
	h.layout.selectPanel("sched");
	const child = h.mainRoot.tree.props.children;
	assert.equal(child.type.name, "Dashboard");
	const dashboard = h.renderComponent(child.type, child.props);
	const buttons = elements(dashboard.tree, (el) => el.type === "button");
	assert.ok(buttons.length >= 8);
	for (const button of buttons) {
		if (!button.props.style?.["--ns-btn-hover"]) continue;
		assert.ok(button.props.className.includes("nsBtn"));
		assert.equal(Object.hasOwn(button.props.style, "className"), false);
	}
	const tabs = buttons.filter((button) => button.props.className?.includes("nsTab"));
	assert.ok(tabs.some((button) => button.props.className.includes("nsTabOn")));
	assert.ok(tabs.some((button) => !button.props.className.includes("nsTabOn")));
	assert.ok(h.timers.size > 0);
	assert.equal(h.sockets.length, 1);
	dashboard.unmount();
	assert.equal(h.timers.size, 0);
	assert.equal(h.sockets[0].closed, true);
	h.layout.selectPanel(null);
	h.dispose();
});
