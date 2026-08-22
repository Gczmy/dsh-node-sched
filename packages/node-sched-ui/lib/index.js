/**
 * @zzc/dsh-node-sched-ui — dsh client plugin (placeholder).
 *
 * Will own the sched dashboard: overview page (daemon heartbeat / batch
 * cards / GPU lamps), batch detail table, GPU panel, log stream viewer,
 * and submit forms (dry-run first). Contributions register through
 * @deepseek-ai/dsh-client-ui-slots; data arrives via host RPC + WS frames.
 *
 * M1: empty plugin so the profile composition and load contract are proven.
 */

const name = "node-sched-ui";

const inject = [];

function apply(ctx) {
	ctx.logger?.info?.("[node-sched-ui] loaded (placeholder, dashboard pending M3)");
	return () => {};
}

export { name, inject, apply };
export default { name, inject, apply };
