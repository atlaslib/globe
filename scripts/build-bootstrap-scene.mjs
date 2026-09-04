import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const duckdbEntry = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
const duckdb = require(duckdbEntry);
const duckdbDist = dirname(duckdbEntry);
const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = join(root, "data");
const showcaseDir = join(dataDir, "showcases");
const resultLimit = 25_000;

function extractDeclaration(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Could not extract ${start}.`);
  return source.slice(startIndex, endIndex);
}

const appSource = await readFile(join(root, "app.js"), "utf8");
const examplesDeclaration = extractDeclaration(appSource, "const examples =", "\n\nconst interestingScenes =");
const scenesDeclaration = extractDeclaration(appSource, "const interestingScenes =", "\n\nconst DEFAULT_SCENE_ID");
const defaultSceneDeclaration = extractDeclaration(appSource, "const DEFAULT_SCENE_ID =", "\n\nexport const state");
const datasetsDeclaration = extractDeclaration(appSource, "const BUILT_IN_DATASET_DEFINITIONS =", "\n\nfunction prepareBuiltInDatasets");
const { interestingScenes, datasetDefinitions, defaultSceneId } = new Function(`${examplesDeclaration}\n${scenesDeclaration}\n${defaultSceneDeclaration}\n${datasetsDeclaration}\nreturn { interestingScenes, datasetDefinitions: BUILT_IN_DATASET_DEFINITIONS, defaultSceneId: DEFAULT_SCENE_ID };`)();

function toPlainValue(value, type = "") {
  if (/timestamp/i.test(type) && (typeof value === "number" || typeof value === "bigint")) {
    let milliseconds = Number(value);
    if (Math.abs(milliseconds) > 1e17) milliseconds /= 1e6;
    else if (Math.abs(milliseconds) > 1e14) milliseconds /= 1e3;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (value && ArrayBuffer.isView(value)) return [...value];
  return value;
}

function tablePayload(table) {
  const fields = table.schema.fields;
  const columns = fields.map((field) => field.name);
  return {
    columns,
    schema: fields.map((field) => ({ name: field.name, type: String(field.type) })),
    rows: table.toArray().map((row) => Object.fromEntries(fields.map((field) => [
      field.name,
      toPlainValue(row[field.name], String(field.type)),
    ]))),
  };
}

const bundles = {
  mvp: {
    mainModule: join(duckdbDist, "duckdb-mvp.wasm"),
    mainWorker: join(duckdbDist, "duckdb-node-mvp.worker.cjs"),
  },
};
const database = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await database.instantiate(() => {});
for (const definition of datasetDefinitions) {
  database.registerFileBuffer(definition.file, await readFile(join(dataDir, definition.file)));
}

const connection = database.connect();
for (const definition of datasetDefinitions) connection.query(definition.createSql);

await rm(showcaseDir, { recursive: true, force: true });
await mkdir(showcaseDir, { recursive: true });
const catalogSources = JSON.parse(await readFile(join(dataDir, "sources.json"), "utf8"));
const snapshotDate = catalogSources.map((source) => source.retrieved).filter(Boolean).sort().at(-1);
const generatedAt = new Date(`${snapshotDate}T00:00:00.000Z`).toISOString();
let totalRows = 0;
for (const showcase of interestingScenes) {
  const results = showcase.queries.map((query) => {
    const id = `bootstrap_${showcase.id}_${query.id}`;
    let payload;
    try {
      payload = tablePayload(connection.query(`SELECT * FROM (${query.sql}) AS showcase_query LIMIT ${resultLimit}`));
    } catch (error) {
      throw new Error(`Could not build ${showcase.id}/${query.id}: ${error.message}`);
    }
    totalRows += payload.rows.length;
    return {
      id,
      relation: `_${id}`,
      title: query.title,
      sql: query.sql,
      ...payload,
      rowCount: payload.rows.length,
      truncated: payload.rows.length === resultLimit,
      sources: datasetDefinitions.filter((definition) => new RegExp(`(^|[^a-z0-9_])${definition.relation}([^a-z0-9_]|$)`, "i").test(query.sql)).map((definition) => definition.relation),
      durationMs: 0,
      actor: "app bootstrap",
    };
  });
  const resultIds = new Map(showcase.queries.map((query, index) => [query.id, results[index].id]));
  const scene = {
    id: showcase.id,
    headline: showcase.headline,
    subheadline: showcase.subheadline,
    layers: showcase.layers.map(({ queryId, ...layer }) => ({ ...layer, resultId: resultIds.get(queryId) })),
    camera: showcase.camera || { fit: "none" },
  };
  const output = { version: 2, generatedAt, defaultSceneId: showcase.id, scene, scenes: [scene], results };
  await writeFile(join(showcaseDir, `${showcase.id}.json`), `${JSON.stringify(output)}\n`);
  if (showcase.id === defaultSceneId) await writeFile(join(dataDir, "bootstrap-scene.json"), `${JSON.stringify(output)}\n`);
}
connection.close();

console.log(`Created ${interestingScenes.length} showcase snapshots with ${totalRows} rows.`);
