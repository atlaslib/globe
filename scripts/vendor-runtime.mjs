import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const nodeModules = join(root, "node_modules");

const files = [
  ["@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js", "vendor/duckdb-browser-eh.worker.js"],
  ["@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js", "vendor/duckdb-browser-mvp.worker.js"],
  ["@duckdb/duckdb-wasm/dist/duckdb-eh.wasm", "vendor/duckdb-eh.wasm"],
  ["@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm", "vendor/duckdb-mvp.wasm"],
  ["globe.gl/dist/globe.gl.min.js", "vendor/globe.gl.min.js"],
];

for (const [sourcePath, destinationPath] of files) {
  const source = join(nodeModules, sourcePath);
  const destination = join(root, destinationPath);
  await access(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

await build({
  entryPoints: [join(nodeModules, "@duckdb/duckdb-wasm/dist/duckdb-browser.mjs")],
  outfile: join(root, "vendor/duckdb-browser.mjs"),
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
});

console.log(`Prepared ${files.length + 1} pinned runtime files in vendor/.`);
