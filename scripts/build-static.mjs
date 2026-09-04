import { constants } from "node:zlib";
import { blake3 } from "@noble/hashes/blake3";
import { cp, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "out");
const cloudflareMaxAssetBytes = 25 * 1024 * 1024;

const rootFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "webmcp.js",
  "LICENSE",
  "DATA_LICENSES.md",
  "THIRD_PARTY_NOTICES.md",
];

const dataFiles = [
  "sources.json",
  "bootstrap-scene.json",
  "drifter-loopers.csv",
  "atlantic-storms.csv",
  "country-boundaries.csv",
  "earthquakes.parquet",
  "tsunami-events.parquet",
  "tsunami-runups.parquet",
  "us-tornado-tracks.parquet",
  "major-rivers.parquet",
  "global-chains.parquet",
  "theme-parks-landmarks.parquet",
];

const vendorFiles = [
  "duckdb-browser.mjs",
  "duckdb-browser-eh.worker.js",
  "duckdb-browser-mvp.worker.js",
  "duckdb-browser-compressed.worker.js",
  "globe.gl.min.js",
];

const wasmFiles = ["duckdb-eh.wasm", "duckdb-mvp.wasm"];

async function copy(relativePath) {
  const destination = join(output, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, relativePath), destination);
}

async function compressWasm(fileName) {
  const source = await readFile(join(root, "vendor", fileName));
  const compressed = gzipSync(source, {
    level: constants.Z_BEST_COMPRESSION,
  });
  if (!gunzipSync(compressed).equals(source)) throw new Error(`${fileName} failed compression verification.`);
  const destination = join(output, "vendor", `${fileName}.gz`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, compressed);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}

async function fingerprintFiles(files) {
  const hash = blake3.create({ dkLen: 32 });
  for (const file of [...files].sort()) {
    hash.update(new TextEncoder().encode(relative(output, file)));
    hash.update(new Uint8Array([0]));
    hash.update(await readFile(file));
    hash.update(new Uint8Array([0]));
  }
  return Buffer.from(hash.digest()).toString("hex");
}

function versionIndexAssets(html, buildId) {
  const replacements = [
    ["styles.css", `styles.css?v=${buildId}`],
    ["app.js", `app.js?v=${buildId}`],
    ["vendor/globe.gl.min.js", `vendor/globe.gl.min.js?v=${buildId}`],
    ["assets/textures/earth-night-poster.jpg", `assets/textures/earth-night-poster.jpg?v=${buildId}`],
  ];
  let result = html
    .replace('<meta name="atlas-build" content="development" />', `<meta name="atlas-build" content="${buildId}" />`)
    .replaceAll("?v=development", `?v=${buildId}`);
  for (const [source, versioned] of replacements) result = result.replaceAll(`"${source}"`, `"${versioned}"`);
  return result;
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of rootFiles) await copy(file);
for (const file of dataFiles) await copy(join("data", file));
await cp(join(root, "data", "showcases"), join(output, "data", "showcases"), { recursive: true });
for (const file of vendorFiles) await copy(join("vendor", file));
await cp(join(root, "assets", "datasets"), join(output, "assets", "datasets"), { recursive: true });
await cp(join(root, "assets", "textures"), join(output, "assets", "textures"), { recursive: true });
await copy(join("assets", "og-preview-watercolor-v2.jpg"));
await cp(join(root, "third_party"), join(output, "third_party"), { recursive: true });
for (const file of wasmFiles) await compressWasm(file);

const outputStylesPath = join(output, "styles.css");
const outputStyles = await readFile(outputStylesPath, "utf8");
const placeholderRelativePath = "assets/textures/earth-night-placeholder.jpg";
const placeholderBase64 = (await readFile(join(root, placeholderRelativePath))).toString("base64");
const inlinedStyles = outputStyles.replaceAll(placeholderRelativePath, `data:image/jpeg;base64,${placeholderBase64}`);
if (inlinedStyles === outputStyles) throw new Error("Could not inline the first-paint globe poster in CSS.");
await writeFile(outputStylesPath, inlinedStyles);
await rm(join(output, placeholderRelativePath));

const outputIndexPath = join(output, "index.html");

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const builtAt = new Date().toISOString();
const contentBlake3 = await fingerprintFiles(await listFiles(output));
const buildId = `b3-${contentBlake3.slice(0, 12)}`;

const unversionedIndex = await readFile(outputIndexPath, "utf8");
const versionedIndex = versionIndexAssets(unversionedIndex, buildId);
if (versionedIndex === unversionedIndex || versionedIndex.includes('content="development"')) throw new Error("Could not stamp the production HTML with its build ID.");
await writeFile(outputIndexPath, versionedIndex);

const outputWebMcpPath = join(output, "webmcp.js");
const outputWebMcp = await readFile(outputWebMcpPath, "utf8");
const versionedWebMcp = outputWebMcp.replace('from "./app.js";', `from "./app.js?v=${buildId}";`);
if (versionedWebMcp === outputWebMcp) throw new Error("Could not version WebMCP's app module import.");
await writeFile(outputWebMcpPath, versionedWebMcp);

await writeFile(join(output, "version.json"), `${JSON.stringify({
  app: "Atlas",
  version: packageJson.version,
  buildId,
  builtAt,
  contentBlake3,
}, null, 2)}\n`);

await writeFile(join(output, "_headers"), `/*
  Permissions-Policy: tools=(self)
  Origin-Agent-Cluster: ?1
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Atlas-Build: ${buildId}

/version.json
  Cache-Control: no-store
  Content-Type: application/json; charset=utf-8

/assets/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/data/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/vendor/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/app.js
  Cache-Control: public, max-age=3600, stale-while-revalidate=86400

/webmcp.js
  Cache-Control: public, max-age=3600, stale-while-revalidate=86400

/styles.css
  Cache-Control: public, max-age=3600, stale-while-revalidate=86400

/vendor/duckdb-eh.wasm.gz
  Content-Type: application/gzip
  Cache-Control: public, max-age=31536000, immutable, no-transform

/vendor/duckdb-mvp.wasm.gz
  Content-Type: application/gzip
  Cache-Control: public, max-age=31536000, immutable, no-transform
`);

const files = await listFiles(output);
const oversized = [];
let totalBytes = 0;
for (const file of files) {
  const { size } = await stat(file);
  totalBytes += size;
  if (size > cloudflareMaxAssetBytes) oversized.push(`${relative(output, file)} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
}
if (oversized.length) throw new Error(`Cloudflare Pages' 25 MiB asset limit is exceeded by: ${oversized.join(", ")}`);
if (files.length > 1000) throw new Error(`The output has ${files.length} files; dashboard drag-and-drop accepts at most 1,000.`);

console.log(`Created out/ with ${files.length} files (${(totalBytes / 1024 / 1024).toFixed(1)} MiB).`);
console.log(`Atlas build: ${buildId} (${builtAt})`);
console.log("DuckDB-Wasm assets are bundled as .wasm.gz files for in-browser decompression.");
