// esbuild wrapper: bundle src/client.jsx into the dsh browser ModuleLoader format.
// The harness client runtime supplies shared externals through the factory's
// `require` (verified against @linxin666/dsh-client-ui-task-board lib/client.js).
import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";

const id = "@zzc/dsh-node-sched-ui";
mkdirSync(new URL("../packages/node-sched-ui/lib/", import.meta.url), { recursive: true });

await esbuild.build({
	entryPoints: [new URL("../packages/node-sched-ui/src/client.jsx", import.meta.url).pathname],
	outfile: new URL("../packages/node-sched-ui/lib/client.js", import.meta.url).pathname,
	bundle: true,
	format: "cjs",
	minify: false,
	sourcemap: "external",
	jsx: "automatic",
	external: [
		"react",
		"react/jsx-runtime",
		"react-dom/client",
		"@deepseek-ai/dsh-client-runtime/client",
	],
	banner: {
		js: [
			`window.__ModuleLoader__.load({`,
			`\tid: ${JSON.stringify(id)},`,
			`\tfactory: (require) => {`,
			`\t\tvar module = { exports: {} };`,
			`\t\tvar exports = module.exports;`,
		].join("\n"),
	},
	footer: {
		js: "\t\treturn module.exports;\n\t}\n});",
	},
});

console.log("client bundle built");
