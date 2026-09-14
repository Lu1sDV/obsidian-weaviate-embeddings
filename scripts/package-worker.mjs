import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const target = "release/local-semantic-search";
await rm(target, { recursive: true, force: true });
await mkdir(`${target}/runtime`, { recursive: true });
for (const file of ["manifest.json", "styles.css"]) await cp(file, `${target}/${file}`);
for (const file of ["main.js", "embedding-worker.js"]) await cp(`dist/${file}`, `${target}/${file}`);
const runtime = "node_modules/onnxruntime-web/dist";
await cp(`${runtime}/ort-wasm-simd-threaded.jsep.mjs`, `${target}/runtime/ort-wasm-simd-threaded.jsep.mjs`);
await cp(`${runtime}/ort-wasm-simd-threaded.jsep.wasm`, `${target}/runtime/ort-wasm-simd-threaded.jsep.wasm`);
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
await writeFile(`${target}/versions.json`, JSON.stringify({ [manifest.version]: manifest.minAppVersion }, null, 2));
