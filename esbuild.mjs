import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";
const shared = {
  bundle: true,
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
};
const main = await esbuild.context({
  ...shared,
  entryPoints: ["src/main.ts"],
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", ...builtins],
  format: "cjs",
  platform: "browser",
  outfile: "dist/main.js",
});
const worker = await esbuild.context({
  ...shared,
  entryPoints: ["src/embedding-worker.ts"],
  conditions: ["browser", "default"],
  format: "esm",
  platform: "browser",
  outfile: "dist/embedding-worker.js",
  define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
});
if (production) {
  await Promise.all([main.rebuild(), worker.rebuild()]);
  await Promise.all([main.dispose(), worker.dispose()]);
} else {
  await Promise.all([main.watch(), worker.watch()]);
}
