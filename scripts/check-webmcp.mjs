import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(project, "webmcp.js"), "utf8");
const expected = [
  "inspect_workspace",
  "inspect_relation",
  "load_dataset",
  "execute_sql",
  "render_globe_scene",
  "present_result",
];
const registered = [...source.matchAll(/name:\s*"([a-z_]+)"/g)].map((match) => match[1]);

if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new Error(`Unexpected tool list: ${registered.join(", ")}`);
if (!source.includes("document.modelContext.registerTool")) throw new Error("Current registerTool API is missing.");
if (/navigator\.(modelContext|webmcp)|provideContext/.test(source)) throw new Error("A stale WebMCP API is present.");
for (const required of ["inputSchema", "annotations", "AbortController", "{ signal }"]) {
  if (!source.includes(required)) throw new Error(`WebMCP contract marker is missing: ${required}`);
}
if (!source.includes('maxItems: 8') || !source.includes('"all-layers"')) throw new Error("Scene limits or camera schema are missing.");
if (!source.includes('required: ["headline", "subheadline", "layers"]')) throw new Error("Scene headline and subheadline are not required.");
if (!source.includes('altitude: { type: "string"')) throw new Error("Physical altitude encoding is missing from the globe scene schema.");
if (!source.includes('"polygons"') || !source.includes('geometry: { type: "string"')) throw new Error("Polygon scene support is missing.");

console.log(JSON.stringify({ tools: registered, currentApi: true }));
