import * as duckdb from "@duckdb/duckdb-wasm";
import Worker from "web-worker";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const distribution = dirname(fileURLToPath(import.meta.resolve("@duckdb/duckdb-wasm")));
const expectedRelations = [
  "drifter_loopers",
  "atlantic_storms",
  "country_boundaries",
  "earthquakes",
  "tsunami_events",
  "tsunami_runups",
  "us_tornado_tracks",
  "major_rivers",
  "theme_parks_landmarks",
  "global_chains",
];
const showcaseIds = [
  "theme_parks",
  "heritage_landmarks",
  "mcdonalds",
  "starbucks",
  "ikea",
  "earthquakes",
  "major_rivers",
  "tsunamis",
  "atlantic_storms",
  "ocean_loops",
];
const relationFiles = new Map([
  ["drifter_loopers", "drifter-loopers.csv"],
  ["atlantic_storms", "atlantic-storms.csv"],
  ["country_boundaries", "country-boundaries.csv"],
  ["earthquakes", "earthquakes.parquet"],
  ["tsunami_events", "tsunami-events.parquet"],
  ["tsunami_runups", "tsunami-runups.parquet"],
  ["us_tornado_tracks", "us-tornado-tracks.parquet"],
  ["major_rivers", "major-rivers.parquet"],
  ["theme_parks_landmarks", "theme-parks-landmarks.parquet"],
  ["global_chains", "global-chains.parquet"],
]);

const bundle = await duckdb.selectBundle({
  mvp: {
    mainModule: join(distribution, "duckdb-mvp.wasm"),
    mainWorker: join(distribution, "duckdb-node-mvp.worker.cjs"),
  },
  eh: {
    mainModule: join(distribution, "duckdb-eh.wasm"),
    mainWorker: join(distribution, "duckdb-node-eh.worker.cjs"),
  },
});
const worker = new Worker(bundle.mainWorker);
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);

try {
  const sources = JSON.parse(await readFile(join(project, "data/sources.json"), "utf8"));
  const relations = sources.map((source) => source.relation);
  if (JSON.stringify(relations) !== JSON.stringify(expectedRelations)) {
    throw new Error(`Unexpected open-data catalog: ${relations.join(", ")}`);
  }

  const indexHtml = await readFile(join(project, "index.html"), "utf8");
  const openingSceneMatch = indexHtml.match(/const OPENING_SCENE_IDS = (\[[^;]+\]);/);
  const openingSceneIds = openingSceneMatch ? JSON.parse(openingSceneMatch[1]) : [];
  if (JSON.stringify(openingSceneIds) !== JSON.stringify(showcaseIds)) {
    throw new Error("The randomized opening-scene list does not match the generated showcases.");
  }

  const bootstrap = JSON.parse(await readFile(join(project, "data/bootstrap-scene.json"), "utf8"));
  if (
    bootstrap.version !== 2
    || bootstrap.defaultSceneId !== "theme_parks"
    || bootstrap.scene?.id !== "theme_parks"
    || bootstrap.scenes?.length !== 1
    || bootstrap.scene?.layers?.length !== 1
    || bootstrap.results?.length !== 1
  ) {
    throw new Error("The bootstrap scene contract is invalid.");
  }

  for (const showcaseId of showcaseIds) {
    const snapshot = JSON.parse(await readFile(join(project, `data/showcases/${showcaseId}.json`), "utf8"));
    const scene = snapshot.scenes?.[0];
    const resultIds = new Set(snapshot.results?.map((result) => result.id));
    if (
      snapshot.version !== 2
      || snapshot.defaultSceneId !== showcaseId
      || scene?.id !== showcaseId
      || scene.layers?.length !== 1
      || snapshot.results?.length !== 1
      || scene.layers.some((layer) => !resultIds.has(layer.resultId))
    ) {
      throw new Error(`Showcase snapshot ${showcaseId} is invalid.`);
    }
    for (const result of snapshot.results) {
      if (!result.rows?.length || result.rowCount !== result.rows.length || !result.columns?.length) {
        throw new Error(`Showcase result ${result.id || "unknown"} is invalid.`);
      }
    }
  }

  for (const source of sources) {
    if (!source.description || !source.image || !source.license || !source.sourceUrl) {
      throw new Error(`${source.relation} is missing catalog or provenance metadata.`);
    }
    await stat(join(project, source.image.replace(/^\.\//, "")));
    const data = await readFile(join(project, "data", relationFiles.get(source.relation)));
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== source.sha256) throw new Error(`${source.relation} does not match its bundled SHA-256 digest.`);
  }

  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  for (const file of ["drifter-loopers.csv", "atlantic-storms.csv", "country-boundaries.csv"]) {
    await db.registerFileURL(file, join(project, "data", file), duckdb.DuckDBDataProtocol.NODE_FS, true);
  }
  for (const file of [
    "earthquakes",
    "tsunami-events",
    "tsunami-runups",
    "us-tornado-tracks",
    "major-rivers",
    "global-chains",
    "theme-parks-landmarks",
  ]) {
    await db.registerFileURL(`${file}.parquet`, join(project, `data/${file}.parquet`), duckdb.DuckDBDataProtocol.NODE_FS, true);
  }

  const conn = await db.connect();
  await conn.query(`CREATE TABLE drifter_loopers AS
    SELECT CAST(id AS VARCHAR) AS id, latitude, longitude, period, persist, radius, drogue, t, u, v,
      TIMESTAMP '1979-01-01' + t * INTERVAL 1 DAY AS observed_at
    FROM read_csv_auto('drifter-loopers.csv', header = true)`);
  await conn.query(`CREATE TABLE atlantic_storms AS
    SELECT sid, season, name, CAST(iso_time AS TIMESTAMP) AS iso_time, nature,
      latitude, longitude, wind_kts, pressure_mb
    FROM read_csv_auto('atlantic-storms.csv', header = true)`);
  await conn.query(`CREATE TABLE country_boundaries AS SELECT * FROM read_csv_auto('country-boundaries.csv', header = true)`);
  await conn.query(`CREATE TABLE earthquakes AS SELECT * EXCLUDE (observed_at), CAST(observed_at AS TIMESTAMP) AS observed_at FROM read_parquet('earthquakes.parquet')`);
  await conn.query(`CREATE TABLE tsunami_events AS SELECT * FROM read_parquet('tsunami-events.parquet')`);
  await conn.query(`CREATE TABLE tsunami_runups AS SELECT * FROM read_parquet('tsunami-runups.parquet')`);
  await conn.query(`CREATE TABLE us_tornado_tracks AS SELECT * EXCLUDE (observed_at), CAST(observed_at AS TIMESTAMP) AS observed_at FROM read_parquet('us-tornado-tracks.parquet')`);
  await conn.query(`CREATE TABLE major_rivers AS SELECT * FROM read_parquet('major-rivers.parquet')`);
  await conn.query(`CREATE TABLE global_chains AS SELECT * FROM read_parquet('global-chains.parquet')`);
  await conn.query(`CREATE TABLE theme_parks_landmarks AS SELECT * FROM read_parquet('theme-parks-landmarks.parquet')`);

  const coverage = await conn.query(`SELECT
    (SELECT count(*) FROM drifter_loopers) AS drifter_rows,
    (SELECT count(*) FROM atlantic_storms) AS storm_rows,
    (SELECT count(*) FROM country_boundaries) AS countries,
    (SELECT count(*) FROM earthquakes) AS earthquakes,
    (SELECT min(year) FROM earthquakes) AS first_earthquake_year,
    (SELECT count(*) FROM tsunami_events) AS tsunami_events,
    (SELECT count(*) FROM tsunami_runups) AS tsunami_runups,
    (SELECT count(DISTINCT tornado_id) FROM us_tornado_tracks) AS tornadoes,
    (SELECT count(DISTINCT name) FROM major_rivers) AS rivers,
    (SELECT count(*) FROM global_chains) AS chain_locations,
    (SELECT count(DISTINCT brand) FROM global_chains) AS chain_brands,
    (SELECT count(*) FROM theme_parks_landmarks) AS parks_landmarks`);
  const row = coverage.toArray()[0];

  if (Number(row.drifter_rows) < 2_000 || Number(row.storm_rows) < 15_000 || Number(row.countries) !== 241) {
    throw new Error("Ocean, storm, or boundary coverage is unexpectedly small.");
  }
  if (Number(row.earthquakes) < 14_000 || Number(row.first_earthquake_year) !== 1900) {
    throw new Error("Earthquake coverage is unexpectedly small.");
  }
  if (Number(row.tsunami_events) < 3_000 || Number(row.tsunami_runups) < 35_000 || Number(row.tornadoes) < 60_000) {
    throw new Error("Tsunami or tornado coverage is unexpectedly small.");
  }
  if (Number(row.rivers) < 100 || Number(row.chain_brands) !== 8 || Number(row.parks_landmarks) < 1_000) {
    throw new Error("River or place coverage is unexpectedly small.");
  }

  console.log(JSON.stringify({
    relations: sources.length,
    showcaseSnapshots: showcaseIds.length,
    drifterRows: Number(row.drifter_rows),
    stormRows: Number(row.storm_rows),
    countryBoundaries: Number(row.countries),
    earthquakes: Number(row.earthquakes),
    tsunamiEvents: Number(row.tsunami_events),
    tsunamiRunups: Number(row.tsunami_runups),
    tornadoes: Number(row.tornadoes),
    riverNames: Number(row.rivers),
    chainLocations: Number(row.chain_locations),
    chainBrands: Number(row.chain_brands),
    parksAndLandmarks: Number(row.parks_landmarks),
  }));

  await conn.close();
} finally {
  await db.terminate();
  worker.terminate();
}
