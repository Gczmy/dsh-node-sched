import test from "node:test";
import assert from "node:assert/strict";
import { disposeRecord } from "../lib/ssh-engine.js";

function record(onEnd, inFlight) {
	return {
		client: { end: onEnd },
		hops: [],
		idleAt: Date.now(),
		pinned: false,
		broken: false,
		inFlight,
		disposed: false,
		closed: false,
	};
}

test("disposeRecord defers closing an in-flight connection", () => {
	let ended = 0;
	const current = record(() => { ended += 1; }, 1);
	const engine = { pool: new Map([["node", current]]), acquireQueue: new Map(), aliasGeneration: new Map(), acquireActive: new Map() };

	disposeRecord(engine, "node");
	assert.equal(engine.pool.has("node"), false);
	assert.equal(current.disposed, true);
	assert.equal(ended, 0);

	current.inFlight = 0;
	disposeRecord(engine, "node", current);
	assert.equal(ended, 1);
	assert.equal(current.closed, true);
});

test("disposeRecord force-closes an in-flight connection during teardown", () => {
	let ended = 0;
	const current = record(() => { ended += 1; }, 1);
	const engine = { pool: new Map([["node", current]]), acquireQueue: new Map(), aliasGeneration: new Map(), acquireActive: new Map() };

	disposeRecord(engine, "node", undefined, { force: true });
	assert.equal(ended, 1);
	assert.equal(current.closed, true);
});

test("disposeRecord closes an idle connection immediately", () => {
	let ended = 0;
	const current = record(() => { ended += 1; }, 0);
	const engine = { pool: new Map([["node", current]]), acquireQueue: new Map(), aliasGeneration: new Map(), acquireActive: new Map() };
	disposeRecord(engine, "node");
	assert.equal(ended, 1);
	assert.equal(current.closed, true);
});
