const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const BUILD_ID = document.querySelector('meta[name="atlas-build"]')?.content || "development";

function assetUrl(path) {
  const url = new URL(path, import.meta.url);
  if (BUILD_ID !== "development") url.searchParams.set("v", BUILD_ID);
  return url;
}

const COLORS = ["#62cce1", "#a9cc63", "#ee8869", "#b394e8", "#63d2aa", "#ee7287"];
const PAGE_SIZE = 10;
const RESULT_ROW_LIMIT = 25_000;
const EARTH_RADIUS_KM = 6371;
const DEFAULT_GLOBE_VIEW = { lat: 18, lng: 145, altitude: 2.15 };
const MIN_SURFACE_FIT_ALTITUDE = 1.6;
const MAX_SURFACE_FIT_ALTITUDE = 3;
const LAYER_TYPES = ["points", "paths", "rings", "polygons"];
const CAMERA_FITS = ["all-layers", "active-layer", "none"];
const BOOTSTRAP_SCENE_URL = assetUrl("./data/bootstrap-scene.json");
const FIRST_GLOBE_MAX_WAIT_MS = 1500;

let resolveFirstInteractiveGlobe;
const firstInteractiveGlobePromise = new Promise((resolve) => {
  resolveFirstInteractiveGlobe = resolve;
});
const firstGlobeStartupGate = Promise.race([
  firstInteractiveGlobePromise,
  new Promise((resolve) => setTimeout(resolve, FIRST_GLOBE_MAX_WAIT_MS)),
]);
let engineInitializationPromise = null;

function markPerformance(name) {
  if (typeof performance?.mark === "function") performance.mark(name);
}

markPerformance("atlas:app-module");
const embeddedBootstrapScene = $("#bootstrap-scene")?.textContent.trim();
function loadFallbackBootstrapScene() {
  if (embeddedBootstrapScene) return Promise.resolve(JSON.parse(embeddedBootstrapScene));
  return fetch(BOOTSTRAP_SCENE_URL, { cache: "force-cache" }).then((response) => {
      if (!response.ok) throw new Error(`Could not load the bootstrap scene (${response.status}).`);
      return response.json();
    });
}
const bootstrapScenePromise = window.__atlasOpeningScenePromise
  ? window.__atlasOpeningScenePromise.catch((error) => {
      console.warn("The randomized opening scene was unavailable; using the fallback scene.", error);
      return loadFallbackBootstrapScene();
    })
  : loadFallbackBootstrapScene();

export const VISUALIZATION_CAPABILITIES = {
  sceneTool: "render_globe_scene",
  layerTypes: LAYER_TYPES,
  encodingRoles: ["latitude", "longitude", "altitude", "geometry", "group", "order", "label", "size"],
  styleProperties: ["color", "opacity", "width", "radius", "animate"],
  cameraFits: CAMERA_FITS,
  maxLayers: 8,
};

const examples = {
  loops: {
    headline: "Persistent North Atlantic loops",
    subheadline: "Long-lived drifter loops point to persistent circulation in the North Atlantic.",
    layerType: "rings",
    sql: `SELECT
  id,
  round(avg(latitude), 3) AS latitude,
  round(avg(longitude), 3) AS longitude,
  round(max(persist), 1) AS persistence_days,
  round(median(radius) / 1000, 1) AS radius_km,
  count(*) AS observations
FROM drifter_loopers
WHERE drogue = 1
GROUP BY id
ORDER BY persistence_days DESC
LIMIT 24`,
  },
  storms: {
    headline: "Recent Atlantic storm tracks",
    subheadline: "Named cyclones traced through time using their wind and pressure observations.",
    layerType: "paths",
    sql: `SELECT
  sid,
  name,
  iso_time,
  latitude,
  longitude,
  wind_kts,
  pressure_mb
FROM atlantic_storms
WHERE season >= 2023 AND name <> 'UNNAMED'
ORDER BY sid, iso_time`,
  },
  join: {
    headline: "Loop observations near storm tracks",
    subheadline: "Drifter positions within 500 km of a storm track on approximately the same day.",
    layerType: "points",
    sql: `WITH encounters AS (
  SELECT
    l.id,
    s.name AS storm,
    l.observed_at,
    l.latitude,
    l.longitude,
    round(111.2 * sqrt(
      pow(l.latitude - s.latitude, 2) +
      pow((l.longitude - s.longitude) * cos(radians(l.latitude)), 2)
    ), 1) AS distance_km
  FROM drifter_loopers l
  JOIN atlantic_storms s
    ON abs(date_diff('day', l.observed_at, s.iso_time)) <= 1
   AND abs(l.latitude - s.latitude) < 5
   AND abs(l.longitude - s.longitude) < 7
)
SELECT * FROM encounters
WHERE distance_km <= 500
ORDER BY distance_km
LIMIT 200`,
  },
  countries: {
    headline: "Country boundaries",
    subheadline: "Six neighboring geometries from the bundled Natural Earth boundary snapshot.",
    layerType: "polygons",
    sql: `SELECT
  country_id,
  name,
  center_latitude,
  center_longitude,
  area_km2,
  geometry_geojson
FROM country_boundaries
WHERE name IN ('Germany', 'Austria', 'France', 'Italy', 'Poland', 'Switzerland')
ORDER BY name`,
  },
  earthquakes: {
    headline: "The strongest earthquakes since 1900",
    subheadline: "Global USGS events of magnitude 7.5 and above, sized by magnitude and spanning more than a century.",
    layerType: "rings",
    sql: `SELECT
  event_id,
  observed_at,
  place AS name,
  latitude,
  longitude,
  magnitude,
  depth_km,
  tsunami_flag
FROM earthquakes
WHERE magnitude >= 7.5
ORDER BY magnitude DESC, observed_at`,
  },
  rivers: {
    headline: "Major river systems",
    subheadline: "Named Natural Earth centerlines, ordered into paths across the globe.",
    layerType: "paths",
    sql: `SELECT
  segment_id,
  point_order,
  name,
  latitude,
  longitude,
  scalerank
FROM major_rivers
WHERE scalerank <= 2
ORDER BY segment_id, point_order`,
  },
};

const interestingScenes = [
  {
    id: "theme_parks",
    title: "Theme parks",
    description: "Well-documented theme parks across twenty countries.",
    headline: "Where the world goes to play",
    subheadline: "Sixty-seven well-documented theme parks form a bright, compact map of shared leisure destinations.",
    queries: [{
      id: "places",
      title: "Theme parks around the world",
      sql: `SELECT place_id, name, country, latitude, longitude, sitelinks
FROM theme_parks_landmarks
WHERE category = 'theme park'
ORDER BY country, name`,
    }],
    layers: [{ id: "theme_parks", queryId: "places", type: "points", title: "Theme parks", style: { color: "#f2b85b", radius: 0.38, opacity: 0.92 } }],
  },
  {
    id: "heritage_landmarks",
    title: "Heritage landmarks",
    description: "A selection of widely documented UNESCO heritage places.",
    headline: "World heritage, mapped",
    subheadline: "The 260 most widely documented UNESCO heritage places reveal a cultural geography spanning every inhabited continent.",
    queries: [{
      id: "places",
      title: "Widely documented heritage landmarks",
      sql: `SELECT place_id, name, country, latitude, longitude, sitelinks
FROM theme_parks_landmarks
WHERE category = 'UNESCO heritage landmark'
ORDER BY sitelinks DESC, name
LIMIT 260`,
    }],
    layers: [{ id: "heritage_landmarks", queryId: "places", type: "points", title: "UNESCO heritage landmarks", style: { color: "#d8a4e2", radius: 0.22, opacity: 0.86 } }],
  },
  {
    id: "mcdonalds",
    title: "McDonald’s",
    description: "A geographically balanced sample of McDonald’s locations.",
    headline: "McDonald’s around the world",
    subheadline: "Up to five high-confidence locations per country show the breadth—and the gaps—of a familiar global brand.",
    queries: [{
      id: "locations",
      title: "McDonald’s location sample",
      sql: `WITH ranked AS (
  SELECT place_id, brand, country, confidence, latitude, longitude,
    row_number() OVER (PARTITION BY country ORDER BY confidence DESC, place_id) AS country_rank
  FROM global_chains
  WHERE brand = 'McDonald''s' AND country IS NOT NULL
)
SELECT * EXCLUDE (country_rank) FROM ranked
WHERE country_rank <= 5
ORDER BY country, place_id`,
    }],
    layers: [{ id: "mcdonalds", queryId: "locations", type: "points", title: "McDonald’s", style: { color: "#f06d5f", radius: 0.2, opacity: 0.88 } }],
  },
  {
    id: "starbucks",
    title: "Starbucks",
    description: "A geographically balanced sample of Starbucks locations.",
    headline: "Starbucks around the world",
    subheadline: "Up to five high-confidence locations per country turn a familiar coffee brand into a readable global footprint.",
    queries: [{
      id: "locations",
      title: "Starbucks location sample",
      sql: `WITH ranked AS (
  SELECT place_id, brand, country, confidence, latitude, longitude,
    row_number() OVER (PARTITION BY country ORDER BY confidence DESC, place_id) AS country_rank
  FROM global_chains
  WHERE brand = 'Starbucks' AND country IS NOT NULL
)
SELECT * EXCLUDE (country_rank) FROM ranked
WHERE country_rank <= 5
ORDER BY country, place_id`,
    }],
    layers: [{ id: "starbucks", queryId: "locations", type: "points", title: "Starbucks", style: { color: "#70c49a", radius: 0.2, opacity: 0.88 } }],
  },
  {
    id: "ikea",
    title: "IKEA",
    description: "The bundled snapshot of high-confidence IKEA locations.",
    headline: "IKEA’s global footprint",
    subheadline: "High-confidence IKEA locations make a compact map of how one retail concept traveled across national markets.",
    queries: [{
      id: "locations",
      title: "IKEA locations",
      sql: `SELECT place_id, brand, country, confidence, latitude, longitude
FROM global_chains
WHERE brand = 'IKEA'
ORDER BY country, place_id`,
    }],
    layers: [{ id: "ikea", queryId: "locations", type: "points", title: "IKEA", style: { color: "#f3ce57", radius: 0.24, opacity: 0.9 } }],
  },
  {
    id: "earthquakes",
    title: "Powerful earthquakes",
    description: "The strongest earthquakes in the historical USGS catalog.",
    headline: "A century of powerful earthquakes",
    subheadline: "Magnitude 8 and greater earthquakes since 1900 trace the most active edges of Earth’s tectonic plates.",
    queries: [{
      id: "events",
      title: "Magnitude 8+ earthquakes since 1900",
      sql: `SELECT event_id, observed_at, place AS name, latitude, longitude, magnitude, depth_km, tsunami_flag
FROM earthquakes
WHERE magnitude >= 8
ORDER BY magnitude DESC, observed_at`,
    }],
    layers: [{ id: "earthquakes", queryId: "events", type: "rings", title: "Magnitude 8+ earthquakes", style: { color: "#ee7287", radius: 3.5, opacity: 0.88 } }],
  },
  {
    id: "major_rivers",
    title: "Major rivers",
    description: "Nine famous river systems, simplified for a quick global view.",
    headline: "Rivers that shape continents",
    subheadline: "Nine major river systems are lightly simplified while preserving their geographic paths across the globe.",
    queries: [{
      id: "paths",
      title: "Nine major river systems",
      sql: `WITH ranked AS (
  SELECT segment_id, point_order, name, latitude, longitude, scalerank,
    row_number() OVER (PARTITION BY segment_id ORDER BY point_order) AS path_rank,
    count(*) OVER (PARTITION BY segment_id) AS path_points
  FROM major_rivers
  WHERE name IN ('Congo', 'Danube', 'Ganges', 'Mekong', 'Mississippi', 'Murray', 'Nile', 'Volga', 'Yangtze')
)
SELECT segment_id, point_order, name, latitude, longitude, scalerank
FROM ranked
WHERE path_rank = 1 OR path_rank = path_points OR path_rank % 5 = 0
ORDER BY segment_id, point_order`,
    }],
    layers: [{ id: "major_rivers", queryId: "paths", type: "paths", title: "Major rivers", style: { color: "#62cce1", width: 0.68, opacity: 0.86, animate: false } }],
  },
  {
    id: "tsunamis",
    title: "Historical tsunamis",
    description: "Definite historical tsunami sources in the NOAA catalog.",
    headline: "Where major tsunamis began",
    subheadline: "Definite tsunami sources with waves of at least five metres reveal recurring zones of ocean risk.",
    queries: [{
      id: "events",
      title: "Major definite tsunami sources",
      sql: `SELECT tsunami_id, year, month, day, location_name AS name, country, latitude, longitude, maximum_water_height_m, cause
FROM tsunami_events
WHERE validity = 'definite' AND maximum_water_height_m >= 5
ORDER BY maximum_water_height_m DESC, year`,
    }],
    layers: [{ id: "tsunamis", queryId: "events", type: "rings", title: "Major tsunami sources", style: { color: "#62cce1", radius: 4.5, opacity: 0.88 } }],
  },
  {
    id: "atlantic_storms",
    title: "Atlantic storm tracks",
    description: "The tracks of named Atlantic storms from the 2025 season.",
    headline: "Atlantic storms leave tracks",
    subheadline: "Thirteen named storms from the 2025 season reveal how cyclones curve and travel across the North Atlantic.",
    camera: { fit: "all-layers" },
    queries: [{
      id: "tracks",
      title: "Named Atlantic storm tracks from 2025",
      sql: `SELECT sid, name, iso_time, latitude, longitude, wind_kts, pressure_mb
FROM atlantic_storms
WHERE season = 2025 AND name <> 'UNNAMED'
ORDER BY sid, iso_time`,
    }],
    layers: [{ id: "atlantic_storms", queryId: "tracks", type: "paths", title: "Atlantic storm tracks", style: { color: "#ef9a67", width: 0.72, opacity: 0.82, animate: true } }],
  },
  {
    id: "ocean_loops",
    title: "Ocean drifter loops",
    description: "Persistent loops detected in North Atlantic drifter observations.",
    headline: "Ocean drifters caught in loops",
    subheadline: "Twenty-four persistent drifter loops expose places where North Atlantic surface circulation repeatedly turns back on itself.",
    camera: { fit: "all-layers" },
    queries: [{ id: "loops", title: "Persistent North Atlantic loops", sql: examples.loops.sql }],
    layers: [{ id: "ocean_loops", queryId: "loops", type: "rings", title: "Ocean drifter loops", style: { color: "#62cce1", radius: 6 } }],
  },
];

const DEFAULT_SCENE_ID = "theme_parks";

export const state = {
  duckdb: null,
  db: null,
  conn: null,
  globe: null,
  datasets: new Map(),
  results: new Map(),
  layers: new Map(),
  loadedRelations: new Set(),
  loadingRelations: new Map(),
  bootstrapScenes: new Map(),
  scene: null,
  activeResultId: null,
  selectedRowIndex: null,
  page: 0,
  resultSequence: 0,
  ready: false,
  activeShowcaseId: null,
  showcaseLoading: false,
  bootstrapSceneShown: false,
  globeReady: false,
  sceneRendered: false,
  globeRevealQueued: false,
  catalogSources: [],
};

const elements = {
  status: $("#system-status"),
  statusDot: $("#status-dot"),
  webmcpStatus: $("#webmcp-status"),
  engineVersion: $("#engine-version"),
  datasetCount: $("#dataset-count"),
  datasetList: $("#dataset-list"),
  sqlEditor: $("#sql-editor"),
  layerType: $("#layer-type"),
  runQuery: $("#run-query"),
  queryError: $("#query-error"),
  resultTitle: $("#result-title"),
  resultKind: $("#result-kind"),
  resultCount: $("#result-count"),
  resultSummary: $("#result-summary"),
  resultTable: $("#result-table"),
  previousPage: $("#previous-page"),
  nextPage: $("#next-page"),
  pageLabel: $("#page-label"),
  provenanceContent: $("#provenance-content"),
  provenanceDetails: $("#provenance-details"),
  sceneHeadline: $("#scene-headline"),
  sceneSubheadline: $("#scene-subheadline"),
  sceneLegend: $("#stage-legend"),
  selectionCard: $("#selection-card"),
  selectionTitle: $("#selection-title"),
  selectionDetail: $("#selection-detail"),
  showcaseButton: $("#showcase-button"),
  showcaseMenu: $("#showcase-menu"),
  showcaseList: $("#showcase-list"),
  resultPeek: $("#result-peek"),
  resultPeekTitle: $("#result-peek-title"),
  resultPeekCount: $("#result-peek-count"),
  workspaceSheet: $("#workspace-sheet"),
  sheetBackdrop: $("#sheet-backdrop"),
  sheetClose: $("#sheet-close"),
  sheetEngineStatus: $("#sheet-engine-status"),
  previousSelection: $("#previous-selection"),
  nextSelection: $("#next-selection"),
  selectionPosition: $("#selection-position"),
};

function setStatus(message, kind = "loading") {
  elements.status.textContent = message;
  elements.statusDot.className = `status-dot ${kind === "ready" ? "ready" : kind === "error" ? "error" : ""}`;
}

function revealInteractiveGlobe() {
  if (!state.globeReady || !state.sceneRendered || state.globeRevealQueued || $("#globe").classList.contains("is-live")) return;
  state.globeRevealQueued = true;
  requestAnimationFrame(() => {
    $("#globe").classList.add("is-live");
    state.globeRevealQueued = false;
    markPerformance("atlas:interactive-globe");
    const scene = $("#globe .scene-container");
    let settled = false;
    const finishHandoff = () => {
      if (settled) return;
      settled = true;
      scene?.removeEventListener("transitionend", finishHandoff);
      markPerformance("atlas:globe-handoff-complete");
      requestAnimationFrame(() => setTimeout(resolveFirstInteractiveGlobe, 0));
    };
    scene?.addEventListener("transitionend", finishHandoff, { once: true });
    setTimeout(finishHandoff, 360);
  });
}

async function renderBootstrapScene() {
  const payload = await bootstrapScenePromise;
  if (state.ready || state.bootstrapSceneShown) return;
  for (const result of payload.results || []) {
    state.results.set(result.id, {
      ...result,
      bootstrap: true,
      createdAt: payload.generatedAt,
    });
  }
  for (const scene of payload.scenes || [payload.scene]) {
    if (scene?.id) state.bootstrapScenes.set(scene.id, scene);
  }
  const selectedScene = state.bootstrapScenes.get(payload.defaultSceneId || DEFAULT_SCENE_ID) || payload.scene;
  const { id: showcaseId, ...scene } = selectedScene;
  syncShowcaseControls(interestingScenes.find((showcase) => showcase.id === showcaseId));
  renderGlobeScene(scene, { actor: "app bootstrap", showcaseId });
  state.bootstrapSceneShown = true;
  markPerformance("atlas:bootstrap-scene");
}

function setShowcaseMenu(open) {
  elements.showcaseMenu.hidden = !open;
  elements.showcaseButton.setAttribute("aria-expanded", String(open));
}

function updateShowcaseSelection() {
  $$('[data-showcase]').forEach((button) => {
    const active = button.dataset.showcase === state.activeShowcaseId;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  });
}

function renderShowcaseList() {
  elements.showcaseList.replaceChildren();
  const orderedScenes = [...interestingScenes].sort((left, right) => Number(right.id === DEFAULT_SCENE_ID) - Number(left.id === DEFAULT_SCENE_ID));
  for (const scene of orderedScenes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "showcase-option";
    button.dataset.showcase = scene.id;
    button.disabled = state.showcaseLoading;
    const title = document.createElement("strong");
    title.textContent = scene.title;
    const description = document.createElement("span");
    description.textContent = scene.description;
    button.append(title, description);
    button.addEventListener("click", () => runShowcase(scene.id));
    elements.showcaseList.append(button);
  }
  updateShowcaseSelection();
}

function syncShowcaseControls(showcase) {
  if (!showcase) return;
  const activeQuery = showcase.queries.at(-1);
  const activeLayer = showcase.layers.at(-1);
  elements.sqlEditor.value = activeQuery.sql;
  elements.sqlEditor.dataset.headline = showcase.headline;
  elements.sqlEditor.dataset.subheadline = showcase.subheadline;
  elements.layerType.value = activeLayer.type;
}

const showcaseSnapshotPromises = new Map();

async function loadShowcaseSnapshot(sceneId) {
  if (state.bootstrapScenes.has(sceneId)) return state.bootstrapScenes.get(sceneId);
  if (!showcaseSnapshotPromises.has(sceneId)) {
    showcaseSnapshotPromises.set(sceneId, fetch(assetUrl(`./data/showcases/${sceneId}.json`), { cache: "force-cache" }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load example scene ${sceneId} (${response.status}).`);
      const payload = await response.json();
      for (const result of payload.results || []) {
        state.results.set(result.id, { ...result, bootstrap: true, createdAt: payload.generatedAt });
      }
      state.bootstrapScenes.set(sceneId, payload.scene);
      return payload.scene;
    }));
  }
  return showcaseSnapshotPromises.get(sceneId);
}

async function runShowcase(sceneId, options = {}) {
  const showcase = interestingScenes.find((scene) => scene.id === sceneId);
  if (!showcase) throw new Error("Unknown example scene.");
  if (state.showcaseLoading) return;

  state.showcaseLoading = true;
  elements.showcaseButton.setAttribute("aria-busy", "true");
  setShowcaseMenu(false);
  renderShowcaseList();
  elements.queryError.hidden = true;
  try {
    const snapshot = await loadShowcaseSnapshot(sceneId);
    syncShowcaseControls(showcase);
    const { id, ...scene } = snapshot;
    renderGlobeScene({ ...scene, camera: { ...scene.camera, fit: options.cameraFit || scene.camera?.fit || "all-layers" } }, {
      actor: options.actor || "user",
      showcaseId: id,
    });
  } catch (error) {
    showError(error);
  } finally {
    state.showcaseLoading = false;
    elements.showcaseButton.removeAttribute("aria-busy");
    renderShowcaseList();
  }
}

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

function tableToRows(table) {
  const fields = table.schema.fields;
  return table.toArray().map((row) => Object.fromEntries(fields.map((field) => [field.name, toPlainValue(row[field.name], String(field.type))])));
}

function cleanName(value, fallback = "dataset") {
  const cleaned = String(value || fallback).toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(cleaned) ? cleaned.slice(0, 48) : `data_${cleaned}`.slice(0, 48);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
}

function displayValue(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return Number.isFinite(value) ? formatNumber(value) : "—";
  const text = String(value);
  return text.length > 42 ? `${text.slice(0, 39)}…` : text;
}

function inferColumns(columns) {
  const lower = Object.fromEntries(columns.map((name) => [name.toLowerCase(), name]));
  const pick = (...names) => names.map((name) => lower[name]).find(Boolean) || null;
  return {
    latitude: pick("latitude", "lat", "center_latitude", "y"),
    longitude: pick("longitude", "lon", "lng", "long", "center_longitude", "x"),
    altitude: pick("altitude_km", "altitude", "height_km"),
    geometry: pick("geometry_geojson", "geojson", "geometry", "geom"),
    group: pick("id", "sid", "satellite_id", "place_id", "track_id", "trajectory_id", "group_id", "segment_id", "tornado_id", "tsunami_id", "volcano_number"),
    order: pick("point_order", "observed_at", "iso_time", "time", "timestamp", "t"),
    label: pick("name", "brand", "volcano_name", "location_name", "place", "title", "label", "id", "sid", "event_id"),
    size: pick("radius_km", "radius", "magnitude", "vei", "water_height_m", "maximum_water_height_m", "wind_kts", "value"),
  };
}

function colorFor(value) {
  const text = String(value ?? "default");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, location.origin);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function publicDatasetUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Dataset URLs must be public HTTPS URLs without credentials.");
  const hostname = url.hostname.toLowerCase();
  const octets = hostname.split(".").map(Number);
  const isPrivateIp = octets.length === 4 && octets.every(Number.isInteger) && (
    octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
  );
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.endsWith(".local") || isPrivateIp) throw new Error("Local and private-network dataset URLs are not allowed.");
  return url;
}

function rowLabel(row, encoding) {
  const value = encoding.label ? row[encoding.label] : encoding.group ? row[encoding.group] : "Result";
  return String(value ?? "Result");
}

function initGlobe() {
  const host = $("#globe");
  state.globe = window.Globe({
    animateIn: false,
    rendererConfig: {
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    },
  })(host)
    .backgroundColor("rgba(0,0,0,0)")
    .globeImageUrl(assetUrl("./assets/textures/earth-night-poster.jpg").href)
    .showAtmosphere(true)
    .atmosphereColor("#58a8c5")
    .atmosphereAltitude(0.13)
    .showGraticules(true)
    .polygonsTransitionDuration(0)
    .polygonCapColor((polygon) => polygon._scenePolygon ? polygon._color : "rgba(38, 78, 57, .05)")
    .polygonSideColor((polygon) => polygon._scenePolygon ? colorWithOpacity(polygon._color, 0.22) : "rgba(0, 0, 0, 0)")
    .polygonStrokeColor((polygon) => polygon._scenePolygon ? polygon._color : "rgba(169, 204, 178, .32)")
    .polygonAltitude((polygon) => polygon._scenePolygon ? 0.014 : 0.004)
    .polygonLabel((polygon) => polygon._scenePolygon
      ? `<strong>${escapeHtml(rowLabel(polygon._row, polygon._encoding))}</strong>`
      : escapeHtml(polygon.properties?.name || ""))
    .pointAltitude(0.014)
    .pointRadius(0.32)
    .pointsMerge(false)
    .pathPoints((path) => path.points)
    .pathPointLat((point) => point.lat)
    .pathPointLng((point) => point.lon)
    .pathPointAlt(0.018)
    .pathStroke(0.7)
    .pathDashLength(0.88)
    .pathDashGap(0.08)
    .pathDashAnimateTime(9000)
    .ringAltitude(0.018)
    .ringPropagationSpeed(1.2)
    .ringRepeatPeriod(1100)
    .onGlobeReady(() => {
      state.globeReady = true;
      markPerformance("atlas:globe-ready");
      revealInteractiveGlobe();
    })
    .onPointClick((row) => selectRow(row._rowIndex, row._resultId))
    .onPolygonClick((polygon) => {
      if (polygon._scenePolygon) selectRow(polygon._rowIndex, polygon._resultId);
    });

  const material = state.globe.globeMaterial();
  material.color.set("#d7e3e6");
  material.emissive.set("#0a2635");
  material.emissiveIntensity = 0.34;
  material.shininess = 0.28;

  state.globe.controls().autoRotate = true;
  state.globe.controls().autoRotateSpeed = 0.22;
  state.globe.controls().enableDamping = true;
  state.globe.pointOfView(DEFAULT_GLOBE_VIEW, 0);

  const resize = () => state.globe.width(host.clientWidth).height(host.clientHeight);
  new ResizeObserver(resize).observe(host);
  resize();

}

async function initDuckDb() {
  const duckdb = await import(assetUrl("./vendor/duckdb-browser.mjs").href);
  state.duckdb = duckdb;
  const bundles = {
    mvp: {
      mainModule: assetUrl("./vendor/duckdb-mvp.wasm").href,
      mainWorker: assetUrl("./vendor/duckdb-browser-compressed.worker.js?variant=mvp").href,
    },
    eh: {
      mainModule: assetUrl("./vendor/duckdb-eh.wasm").href,
      mainWorker: assetUrl("./vendor/duckdb-browser-compressed.worker.js?variant=eh").href,
    },
  };
  const bundle = await duckdb.selectBundle(bundles);
  const worker = new Worker(bundle.mainWorker);
  state.db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await state.db.instantiate(bundle.mainModule);
  state.conn = await state.db.connect();
  elements.engineVersion.textContent = `DuckDB ${await state.db.getVersion()}`;
  markPerformance("atlas:duckdb-ready");
}

async function loadCatalogMetadata() {
  const response = await fetch(assetUrl("./data/sources.json"));
  if (!response.ok) throw new Error(`Could not load the data catalog (${response.status}).`);
  state.catalogSources = await response.json();
  for (const source of state.catalogSources) {
    state.datasets.set(source.relation, { ...source, kind: "built-in" });
  }
}

const BUILT_IN_DATASET_DEFINITIONS = [
    {
      relation: "drifter_loopers",
      file: "drifter-loopers.csv",
      color: "#62cce1",
      createSql: `CREATE VIEW drifter_loopers AS
        SELECT
          CAST(id AS VARCHAR) AS id,
          latitude, longitude, period, persist, radius, drogue, t, u, v,
          TIMESTAMP '1979-01-01' + t * INTERVAL 1 DAY AS observed_at
        FROM read_csv_auto('drifter-loopers.csv', header = true)`,
    },
    {
      relation: "atlantic_storms",
      file: "atlantic-storms.csv",
      color: "#ee8869",
      createSql: `CREATE VIEW atlantic_storms AS
        SELECT
          sid, season, name, CAST(iso_time AS TIMESTAMP) AS iso_time, nature,
          latitude, longitude, wind_kts, pressure_mb
        FROM read_csv_auto('atlantic-storms.csv', header = true)`,
    },
    {
      relation: "country_boundaries",
      file: "country-boundaries.csv",
      color: "#63d2aa",
      createSql: `CREATE VIEW country_boundaries AS
        SELECT * FROM read_csv_auto('country-boundaries.csv', header = true)`,
    },
    {
      relation: "earthquakes",
      file: "earthquakes.parquet",
      color: "#e45f67",
      createSql: `CREATE VIEW earthquakes AS
        SELECT * EXCLUDE (observed_at), CAST(observed_at AS TIMESTAMP) AS observed_at
        FROM read_parquet('earthquakes.parquet')`,
    },
    {
      relation: "tsunami_events",
      file: "tsunami-events.parquet",
      color: "#3ba9cf",
      createSql: `CREATE VIEW tsunami_events AS
        SELECT * FROM read_parquet('tsunami-events.parquet')`,
    },
    {
      relation: "tsunami_runups",
      file: "tsunami-runups.parquet",
      color: "#75c7de",
      createSql: `CREATE VIEW tsunami_runups AS
        SELECT * FROM read_parquet('tsunami-runups.parquet')`,
    },
    {
      relation: "us_tornado_tracks",
      file: "us-tornado-tracks.parquet",
      color: "#b092d1",
      createSql: `CREATE VIEW us_tornado_tracks AS
        SELECT * EXCLUDE (observed_at), CAST(observed_at AS TIMESTAMP) AS observed_at
        FROM read_parquet('us-tornado-tracks.parquet')`,
    },
    {
      relation: "major_rivers",
      file: "major-rivers.parquet",
      color: "#4eb1d2",
      createSql: `CREATE VIEW major_rivers AS
        SELECT * FROM read_parquet('major-rivers.parquet')`,
    },
    {
      relation: "global_chains",
      file: "global-chains.parquet",
      color: "#e58ca7",
      createSql: `CREATE VIEW global_chains AS
        SELECT * FROM read_parquet('global-chains.parquet')`,
    },
    {
      relation: "theme_parks_landmarks",
      file: "theme-parks-landmarks.parquet",
      color: "#e9b75e",
      createSql: `CREATE VIEW theme_parks_landmarks AS
        SELECT * FROM read_parquet('theme-parks-landmarks.parquet')`,
    },
  ];

function prepareBuiltInDatasets() {
  for (const definition of BUILT_IN_DATASET_DEFINITIONS) {
    const source = state.catalogSources.find((item) => item.relation === definition.relation);
    state.datasets.set(definition.relation, {
      ...definition,
      ...source,
      rowCount: source?.rowCount ?? null,
      kind: "built-in",
      loaded: state.loadedRelations.has(definition.relation),
    });
  }
  renderDatasetList();
}

async function ensureEngineReady() {
  if (state.ready) return;
  if (!engineInitializationPromise) throw new Error("DuckDB has not started yet.");
  await engineInitializationPromise;
  if (!state.ready) throw new Error("DuckDB could not start.");
}

async function ensureDatasetLoaded(relation) {
  await ensureEngineReady();
  if (state.loadedRelations.has(relation)) return;
  if (state.loadingRelations.has(relation)) return state.loadingRelations.get(relation);
  const definition = BUILT_IN_DATASET_DEFINITIONS.find((item) => item.relation === relation);
  if (!definition) return;
  const loading = (async () => {
    const url = assetUrl(`./data/${definition.file}`).href;
    await state.db.registerFileURL(definition.file, url, state.duckdb.DuckDBDataProtocol.HTTP, false);
    await state.conn.query(definition.createSql);
    state.loadedRelations.add(relation);
    const dataset = state.datasets.get(relation);
    if (dataset) dataset.loaded = true;
  })();
  state.loadingRelations.set(relation, loading);
  try {
    await loading;
  } finally {
    state.loadingRelations.delete(relation);
  }
}

function referencedDatasetNames(sql) {
  return [...state.datasets.keys()].filter((name) => new RegExp(`(^|[^a-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i").test(sql));
}

async function ensureDatasetsForSql(sql) {
  for (const relation of referencedDatasetNames(sql)) await ensureDatasetLoaded(relation);
}

function renderDatasetList() {
  elements.datasetCount.textContent = state.datasets.size;
  elements.datasetList.replaceChildren();
  for (const dataset of state.datasets.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dataset-card";
    button.style.setProperty("--dataset-color", dataset.color || "#b394e8");

    const media = document.createElement("span");
    media.className = "dataset-media";
    if (dataset.image && dataset.kind === "built-in") {
      const image = document.createElement("img");
      const thumbnail = /-thumb\.jpg$/i.test(dataset.image)
        ? dataset.image
        : dataset.image.replace(/\.jpg$/i, "-thumb.jpg");
      image.dataset.src = assetUrl(thumbnail).href;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      media.append(image);
    } else {
      const fallback = document.createElement("span");
      fallback.className = "dataset-fallback";
      fallback.setAttribute("aria-hidden", "true");
      media.append(fallback);
    }

    const copy = document.createElement("span");
    copy.className = "dataset-copy";
    const name = document.createElement("span");
    name.className = "dataset-name";
    name.textContent = dataset.title || dataset.relation;
    const description = document.createElement("span");
    description.className = "dataset-description";
    description.textContent = dataset.description || dataset.notes || "Explore this relation with SQL and the globe.";
    const meta = document.createElement("span");
    meta.className = "dataset-meta";
    meta.textContent = `${dataset.relation} · ${dataset.rowCount == null ? "row count unavailable" : `${formatNumber(dataset.rowCount)} rows`}`;
    copy.append(name, description, meta);

    const arrow = document.createElement("span");
    arrow.className = "dataset-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    button.append(media, copy, arrow);
    button.addEventListener("click", () => showDataset(dataset.relation));
    elements.datasetList.append(button);
  }
}

function hydrateDatasetImages() {
  elements.datasetList.querySelectorAll("img[data-src]").forEach((image) => {
    image.src = image.dataset.src;
    delete image.dataset.src;
  });
}

async function showDataset(relation) {
  try {
    elements.sheetEngineStatus.textContent = "Opening dataset…";
    const info = await inspectRelation(relation);
    elements.resultTitle.textContent = relation;
    elements.resultKind.textContent = "Dataset sample";
    elements.resultCount.textContent = `${formatNumber(info.rowCount)} rows`;
    elements.resultSummary.textContent = info.schema.map((column) => `${column.name} · ${column.type}`).join("  /  ");
    renderTable(info.sample, info.schema.map((column) => column.name), 0, false);
    elements.pageLabel.textContent = `${info.sample.length}-row sample of ${formatNumber(info.rowCount)}`;
    elements.previousPage.disabled = true;
    elements.nextPage.disabled = true;
    elements.provenanceContent.innerHTML = provenanceMarkup(info.provenance);
    elements.provenanceDetails.open = true;
    elements.sheetEngineStatus.textContent = "Local data ready";
    selectSheetTab("results");
  } catch (error) {
    elements.sheetEngineStatus.textContent = state.ready ? "Local data ready" : "Preparing local data…";
    showError(error);
  }
}

function validateSql(input) {
  const sql = String(input || "").trim().replace(/;+\s*$/, "");
  if (!sql) throw new Error("Enter a query first.");
  if (!/^(select|with)\b/i.test(sql)) throw new Error("Only SELECT and WITH queries are allowed.");
  if (sql.includes(";")) throw new Error("Run one SQL statement at a time.");
  const blocked = /\b(attach|copy|create|delete|drop|export|import|insert|install|load|pragma|update|alter|call|vacuum|read_csv|read_json|read_parquet|read_text|read_blob|csv_scan|parquet_scan|sqlite_scan|glob|query_table)\b/i;
  if (blocked.test(sql)) throw new Error("This query uses a blocked file, network, or mutation operation.");
  if (/https?:\/\/|['"][^'"]+\.(csv|json|parquet|duckdb)['"]/i.test(sql)) throw new Error("Load external data through the dataset loader before querying it.");
  if (sql.length > 12_000) throw new Error("Query is too long for this workspace.");
  return sql;
}

export async function executeSql(input, options = {}) {
  const sql = validateSql(input);
  await ensureEngineReady();
  await ensureDatasetsForSql(sql);
  const id = `result_${String(++state.resultSequence).padStart(4, "0")}`;
  const relation = `_${id}`;
  const started = performance.now();

  await state.conn.query(`CREATE OR REPLACE TEMP TABLE ${relation} AS SELECT * FROM (${sql}) AS workspace_query LIMIT ${RESULT_ROW_LIMIT}`);
  const table = await state.conn.query(`SELECT * FROM ${relation}`);
  const rows = tableToRows(table);
  const columns = table.schema.fields.map((field) => field.name);
  const schema = table.schema.fields.map((field) => ({ name: field.name, type: String(field.type) }));
  const candidates = [...state.datasets.keys(), ...[...state.results.values()].map((item) => item.relation)];
  const sources = [...new Set(candidates.filter((name) => new RegExp(`(^|[^a-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i").test(sql)))];
  const result = {
    id,
    relation,
    title: options.title || "SQL result",
    sql,
    rows,
    columns,
    schema,
    rowCount: rows.length,
    truncated: rows.length === RESULT_ROW_LIMIT,
    sources,
    createdAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    actor: options.actor || "user",
  };
  state.results.set(id, result);
  if (!options.silent) {
    state.activeResultId = id;
    state.page = 0;
    state.selectedRowIndex = null;
    elements.selectionCard.hidden = true;
    renderResult(result);
  }
  return result;
}

function resultProvenance(result) {
  return {
    scene: state.scene?.headline,
    sceneSubheadline: state.scene?.subheadline,
    sceneLayers: state.scene?.layers.map((layer) => `${layer.id} ← ${layer.resultId}`).join(", "),
    actor: result.actor,
    createdAt: result.createdAt,
    duration: `${result.durationMs} ms`,
    sources: result.sources.join(", ") || "derived relation",
    relation: result.relation,
    sql: result.sql,
  };
}

function provenanceMarkup(provenance = {}) {
  const entries = [];
  const sourceUrl = safeHttpUrl(provenance.sourceUrl);
  const licenseUrl = safeHttpUrl(provenance.licenseUrl);
  const manifestUrl = safeHttpUrl(provenance.manifestUrl);
  if (provenance.title) entries.push(["Source", sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(provenance.title)}</a>` : escapeHtml(provenance.title)]);
  if (provenance.organization) entries.push(["Publisher", escapeHtml(provenance.organization)]);
  if (provenance.license) entries.push(["License", licenseUrl ? `<a href="${escapeHtml(licenseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(provenance.license)}</a>` : escapeHtml(provenance.license)]);
  if (provenance.snapshotId) entries.push(["Snapshot", escapeHtml(provenance.snapshotId)]);
  if (provenance.snapshotAt) entries.push(["Position time", escapeHtml(provenance.snapshotAt)]);
  if (manifestUrl) entries.push(["Manifest", `<a href="${escapeHtml(manifestUrl)}" target="_blank" rel="noreferrer">Open provenance JSON</a>`]);
  if (provenance.retrieved) entries.push(["Retrieved", escapeHtml(provenance.retrieved)]);
  if (provenance.sha256) entries.push(["Bundled SHA-256", escapeHtml(provenance.sha256)]);
  if (provenance.scene) entries.push(["Scene", escapeHtml(provenance.scene)]);
  if (provenance.sceneLayers) entries.push(["Layers", escapeHtml(provenance.sceneLayers)]);
  if (provenance.sources) entries.push(["Parents", escapeHtml(provenance.sources)]);
  if (provenance.actor) entries.push(["Created by", escapeHtml(provenance.actor)]);
  if (provenance.createdAt) entries.push(["At", escapeHtml(provenance.createdAt)]);
  if (provenance.duration) entries.push(["Runtime", escapeHtml(provenance.duration)]);
  if (provenance.relation) entries.push(["Relation", escapeHtml(provenance.relation)]);
  if (provenance.sql) entries.push(["SQL", escapeHtml(provenance.sql)]);
  if (provenance.methodology) entries.push(["Method", escapeHtml(provenance.methodology)]);
  if (provenance.caveats) entries.push(["Caveats", escapeHtml(provenance.caveats)]);
  if (Array.isArray(provenance.sources) && provenance.sources.length) {
    const sourceLinks = provenance.sources.map((source) => {
      const url = safeHttpUrl(source.url);
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title || source.id)}</a>` : escapeHtml(source.title || source.id);
    }).join(", ");
    entries.push(["Inputs", sourceLinks]);
  }
  if (provenance.notes) entries.push(["Notes", escapeHtml(provenance.notes)]);
  return `<dl>${entries.map(([term, detail]) => `<dt>${term}</dt><dd>${detail}</dd>`).join("")}</dl>`;
}

function renderResult(result) {
  elements.resultKind.textContent = "Current result";
  elements.resultTitle.textContent = result.title;
  elements.resultCount.textContent = `${formatNumber(result.rowCount)}${result.truncated ? "+" : ""} rows`;
  elements.resultPeekTitle.textContent = result.title;
  elements.resultPeekCount.textContent = `${formatNumber(result.rowCount)}${result.truncated ? "+" : ""} rows`;
  const timing = result.bootstrap ? "preloaded" : `${result.durationMs} ms`;
  elements.resultSummary.textContent = `${result.columns.length} columns · ${timing} · saved as ${result.relation}`;
  elements.provenanceContent.innerHTML = provenanceMarkup(resultProvenance(result));
  renderCurrentPage();
}

function renderCurrentPage() {
  const result = state.results.get(state.activeResultId);
  if (!result) return;
  const pages = Math.max(1, Math.ceil(result.rows.length / PAGE_SIZE));
  state.page = Math.min(Math.max(0, state.page), pages - 1);
  const start = state.page * PAGE_SIZE;
  renderTable(result.rows.slice(start, start + PAGE_SIZE), result.columns.slice(0, 5), start);
  elements.pageLabel.textContent = `Page ${state.page + 1} / ${pages}`;
  elements.previousPage.disabled = state.page === 0;
  elements.nextPage.disabled = state.page >= pages - 1;
}

function renderTable(rows, columns, offset = 0, selectable = true) {
  const head = elements.resultTable.tHead || elements.resultTable.createTHead();
  const body = elements.resultTable.tBodies[0] || elements.resultTable.createTBody();
  head.replaceChildren();
  body.replaceChildren();
  const headerRow = head.insertRow();
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = column;
    headerRow.append(th);
  });
  rows.forEach((row, localIndex) => {
    const tr = body.insertRow();
    const rowIndex = offset + localIndex;
    tr.classList.toggle("selected", selectable && rowIndex === state.selectedRowIndex);
    if (selectable) tr.addEventListener("click", () => selectRow(rowIndex));
    columns.forEach((column) => {
      const td = tr.insertCell();
      td.textContent = displayValue(row[column]);
      td.title = String(row[column] ?? "");
    });
  });
}

function assertOnlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} has unsupported properties: ${unexpected.join(", ")}.`);
}

function numberInRange(value, fallback, min, max, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return number;
}

function normalizeLayer(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Layer ${index + 1} must be an object.`);
  assertOnlyKeys(input, ["id", "resultId", "type", "title", "encoding", "style"], `Layer ${index + 1}`);
  const id = cleanName(input.id || `layer_${index + 1}`, "layer");
  const resultId = String(input.resultId || "");
  const result = state.results.get(resultId);
  if (!result) throw new Error(`Layer ${id} references an unknown result.`);
  const type = String(input.type || "points");
  if (!LAYER_TYPES.includes(type)) throw new Error(`Layer ${id} must use points, paths, or rings.`);

  const suppliedEncoding = input.encoding ?? {};
  if (!suppliedEncoding || typeof suppliedEncoding !== "object" || Array.isArray(suppliedEncoding)) throw new Error(`Layer ${id} encoding must be an object.`);
  assertOnlyKeys(suppliedEncoding, VISUALIZATION_CAPABILITIES.encodingRoles, `Layer ${id} encoding`);
  const encoding = { ...inferColumns(result.columns), ...suppliedEncoding };
  if (type === "polygons" && !encoding.geometry) throw new Error(`Polygon layer ${id} needs a GeoJSON geometry column.`);
  if (type !== "polygons" && (!encoding.latitude || !encoding.longitude)) throw new Error(`Layer ${id} needs latitude and longitude columns.`);
  for (const [role, column] of Object.entries(encoding)) {
    if (column != null && (typeof column !== "string" || !result.columns.includes(column))) throw new Error(`Layer ${id} maps ${role} to a missing column.`);
  }
  if (type === "paths" && (!encoding.group || !encoding.order)) throw new Error(`Path layer ${id} needs group and order columns.`);

  const suppliedStyle = input.style ?? {};
  if (!suppliedStyle || typeof suppliedStyle !== "object" || Array.isArray(suppliedStyle)) throw new Error(`Layer ${id} style must be an object.`);
  assertOnlyKeys(suppliedStyle, VISUALIZATION_CAPABILITIES.styleProperties, `Layer ${id} style`);
  if (suppliedStyle.color != null && (typeof suppliedStyle.color !== "string" || suppliedStyle.color.length > 60 || !CSS.supports("color", suppliedStyle.color))) {
    throw new Error(`Layer ${id} color must be a valid CSS color.`);
  }
  if (suppliedStyle.animate != null && typeof suppliedStyle.animate !== "boolean") throw new Error(`Layer ${id} animate must be a boolean.`);
  const style = {
    color: suppliedStyle.color || null,
    opacity: numberInRange(suppliedStyle.opacity, 0.92, 0.1, 1, `Layer ${id} opacity`),
    width: numberInRange(suppliedStyle.width, 0.7, 0.1, 4, `Layer ${id} width`),
    radius: numberInRange(suppliedStyle.radius, type === "rings" ? 6 : encoding.altitude ? 0.1 : 0.28, 0.05, type === "rings" ? 20 : 2.5, `Layer ${id} radius`),
    animate: suppliedStyle.animate ?? type === "paths",
  };

  return {
    id,
    resultId,
    type,
    title: String(input.title || result.title).slice(0, 120),
    encoding,
    style,
  };
}

function normalizeScene(input, actor) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Scene input must be an object.");
  assertOnlyKeys(input, ["headline", "subheadline", "layers", "camera"], "Scene");
  const headline = String(input.headline || "").trim();
  const subheadline = String(input.subheadline || "").trim();
  if (!headline || headline.length > 120) throw new Error("headline is required and must be at most 120 characters.");
  if (!subheadline || subheadline.length > 220) throw new Error("subheadline is required and must be at most 220 characters.");
  if (!Array.isArray(input.layers) || !input.layers.length || input.layers.length > VISUALIZATION_CAPABILITIES.maxLayers) {
    throw new Error(`A scene needs 1–${VISUALIZATION_CAPABILITIES.maxLayers} layers.`);
  }
  const layers = input.layers.map(normalizeLayer);
  if (new Set(layers.map((layer) => layer.id)).size !== layers.length) throw new Error("Scene layer IDs must be unique after normalization.");

  const suppliedCamera = input.camera ?? {};
  if (!suppliedCamera || typeof suppliedCamera !== "object" || Array.isArray(suppliedCamera)) throw new Error("camera must be an object.");
  assertOnlyKeys(suppliedCamera, ["fit", "layerId"], "Camera");
  const fit = suppliedCamera.fit || "all-layers";
  if (!CAMERA_FITS.includes(fit)) throw new Error(`Camera fit must be one of: ${CAMERA_FITS.join(", ")}.`);
  const layerId = suppliedCamera.layerId ? cleanName(suppliedCamera.layerId, "layer") : layers.at(-1).id;
  if (fit === "active-layer" && !layers.some((layer) => layer.id === layerId)) throw new Error("Camera layerId is not part of this scene.");

  return {
    headline,
    subheadline,
    layers,
    camera: { fit, layerId: fit === "active-layer" ? layerId : null },
    createdAt: new Date().toISOString(),
    actor,
  };
}

export function renderGlobeScene(input, options = {}) {
  const scene = normalizeScene(input, options.actor || "user");
  state.scene = scene;
  state.activeShowcaseId = options.showcaseId || null;
  state.layers = new Map(scene.layers.map((layer) => [layer.id, layer]));
  state.activeResultId = scene.layers.at(-1).resultId;
  state.page = 0;
  state.selectedRowIndex = null;
  elements.selectionCard.hidden = true;
  elements.sceneHeadline.textContent = scene.headline;
  elements.sceneSubheadline.textContent = scene.subheadline;
  updateShowcaseSelection();
  renderSceneLegend(scene);
  renderGlobeLayers();
  state.sceneRendered = true;
  revealInteractiveGlobe();
  renderResult(state.results.get(state.activeResultId));
  applySceneCamera(scene);
  return scene;
}

function renderSceneLegend(scene) {
  elements.sceneLegend.replaceChildren();
  scene.layers.forEach((layer) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    const key = document.createElement("span");
    key.className = `legend-key ${layer.type}`;
    key.style.setProperty("--legend-color", layer.style.color || colorFor(layer.id));
    const label = document.createElement("span");
    label.textContent = layer.title;
    item.append(key, label);
    elements.sceneLegend.append(item);
  });
}

const colorContext = document.createElement("canvas").getContext("2d");

function colorWithOpacity(color, opacity) {
  colorContext.fillStyle = "#000000";
  colorContext.fillStyle = color;
  const normalized = colorContext.fillStyle;
  const hex = normalized.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
  }
  const rgb = normalized.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) return `rgba(${rgb[1].split(",").slice(0, 3).join(",")}, ${opacity})`;
  return normalized;
}

function relativeAltitude(row, encoding, fallback = 0.014) {
  if (!encoding.altitude) return fallback;
  const altitudeKm = Number(row[encoding.altitude]);
  return Number.isFinite(altitudeKm) ? Math.max(0, Math.min(20, altitudeKm / EARTH_RADIUS_KM)) : fallback;
}

function parseGeoJsonGeometry(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const geometry = parsed?.type === "Feature" ? parsed.geometry : parsed;
    return ["Polygon", "MultiPolygon"].includes(geometry?.type) && Array.isArray(geometry.coordinates) ? geometry : null;
  } catch {
    return null;
  }
}

function geometryLocations(geometry) {
  const locations = [];
  const visit = (coordinates) => {
    if (!Array.isArray(coordinates)) return;
    if (coordinates.length >= 2 && Number.isFinite(Number(coordinates[0])) && Number.isFinite(Number(coordinates[1]))) {
      locations.push({ longitude: Number(coordinates[0]), latitude: Number(coordinates[1]), altitude: 0 });
      return;
    }
    coordinates.forEach(visit);
  };
  visit(geometry?.coordinates);
  return locations;
}

function renderGlobeLayers() {
  const points = [];
  const rings = [];
  const paths = [];
  const polygons = [];

  for (const layer of state.layers.values()) {
    const result = state.results.get(layer.resultId);
    if (!result) continue;
    const { encoding, style } = layer;
    const indexedRows = result.rows
      .map((row, index) => ({ ...row, _rowIndex: index, _layerId: layer.id, _resultId: layer.resultId }));
    const layerColor = (row) => colorWithOpacity(style.color || colorFor(encoding.group ? row[encoding.group] : layer.id), style.opacity);
    if (layer.type === "polygons") {
      for (const row of indexedRows) {
        const geometry = parseGeoJsonGeometry(row[encoding.geometry]);
        if (!geometry) continue;
        polygons.push({
          type: "Feature",
          geometry,
          properties: { name: rowLabel(row, encoding) },
          _scenePolygon: true,
          _row: row,
          _rowIndex: row._rowIndex,
          _resultId: layer.resultId,
          _encoding: encoding,
          _color: layerColor(row),
        });
      }
      continue;
    }
    const validRows = indexedRows
      .filter((row) => Number.isFinite(Number(row[encoding.latitude])) && Number.isFinite(Number(row[encoding.longitude])));
    if (layer.type === "paths") {
      const groups = new Map();
      for (const row of validRows) {
        const key = row[encoding.group];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      for (const [key, rows] of groups) {
        rows.sort((a, b) => String(a[encoding.order]).localeCompare(String(b[encoding.order]), undefined, { numeric: true }));
        paths.push({
          key,
          label: encoding.label ? rows[0][encoding.label] : key,
          color: layerColor(rows[0]),
          width: style.width,
          animate: style.animate,
          points: rows.map((row) => ({
            lat: Number(row[encoding.latitude]),
            lon: Number(row[encoding.longitude]),
            alt: relativeAltitude(row, encoding, 0.018),
          })),
        });
      }
    } else if (layer.type === "rings") {
      rings.push(...validRows.map((row) => ({ ...row, _color: layerColor(row), _encoding: encoding, _style: style, _pointRadius: 0.22, _altitude: relativeAltitude(row, encoding, 0.018) })));
    } else {
      points.push(...validRows.map((row) => ({ ...row, _color: layerColor(row), _encoding: encoding, _style: style, _pointRadius: style.radius, _altitude: relativeAltitude(row, encoding) })));
    }
  }

  state.globe
    .polygonsData(polygons)
    .pointsData([...points, ...rings])
    .pointLat((row) => Number(row[row._encoding.latitude]))
    .pointLng((row) => Number(row[row._encoding.longitude]))
    .pointAltitude((row) => row._altitude)
    .pointColor((row) => row._resultId === state.activeResultId && row._rowIndex === state.selectedRowIndex ? "#ffffff" : row._color)
    .pointRadius((row) => row._resultId === state.activeResultId && row._rowIndex === state.selectedRowIndex ? Math.max(0.55, row._pointRadius * 1.7) : row._pointRadius)
    .pointLabel((row) => `<strong>${escapeHtml(rowLabel(row, row._encoding))}</strong>`)
    .ringsData(rings)
    .ringLat((row) => Number(row[row._encoding.latitude]))
    .ringLng((row) => Number(row[row._encoding.longitude]))
    .ringAltitude((row) => row._altitude)
    .ringColor((row) => (row._resultId === state.activeResultId && row._rowIndex === state.selectedRowIndex ? ["#ffffff", "rgba(255,255,255,0)"] : [row._color, colorWithOpacity(row._color, 0)]))
    .ringMaxRadius((row) => {
      const value = row._encoding.size ? Number(row[row._encoding.size]) : NaN;
      return Number.isFinite(value) ? Math.max(2.5, Math.min(20, Math.sqrt(Math.abs(value)) * 0.7)) : row._style.radius;
    })
    .pathsData(paths)
    .pathPointAlt((point) => point.alt)
    .pathColor((path) => path.color)
    .pathStroke((path) => path.width)
    .pathDashLength((path) => path.animate ? 0.88 : 1)
    .pathDashGap((path) => path.animate ? 0.08 : 0)
    .pathDashAnimateTime((path) => path.animate ? 9000 : 0)
    .pathLabel((path) => `<strong>${escapeHtml(path.label)}</strong>`);
}

function locationsForLayers(layers) {
  return layers.flatMap((layer) => {
    const result = state.results.get(layer.resultId);
    if (!result) return [];
    if (layer.type === "polygons") {
      return result.rows.flatMap((row) => geometryLocations(parseGeoJsonGeometry(row[layer.encoding.geometry])));
    }
    return result.rows
      .map((row) => ({
        latitude: Number(row[layer.encoding.latitude]),
        longitude: Number(row[layer.encoding.longitude]),
        altitude: relativeAltitude(row, layer.encoding, 0),
      }))
      .filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
  });
}

function fitLocations(locations) {
  if (!locations.length) return;
  const lat = locations.reduce((sum, row) => sum + row.latitude, 0) / locations.length;
  const sin = locations.reduce((sum, row) => sum + Math.sin(row.longitude * Math.PI / 180), 0);
  const cos = locations.reduce((sum, row) => sum + Math.cos(row.longitude * Math.PI / 180), 0);
  const lng = Math.atan2(sin, cos) * 180 / Math.PI;
  const centerLat = lat * Math.PI / 180;
  const centerLng = lng * Math.PI / 180;
  const angularSpread = Math.max(...locations.map((row) => {
    const rowLat = row.latitude * Math.PI / 180;
    const rowLng = row.longitude * Math.PI / 180;
    const cosine = Math.sin(centerLat) * Math.sin(rowLat) + Math.cos(centerLat) * Math.cos(rowLat) * Math.cos(rowLng - centerLng);
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
  }));
  const altitude = locations.length === 1
    ? 0.8
    : Math.max(MIN_SURFACE_FIT_ALTITUDE, Math.min(MAX_SURFACE_FIT_ALTITUDE, 0.72 + angularSpread / 65));
  const objectAltitude = Math.max(...locations.map((row) => row.altitude || 0));
  state.globe.pointOfView({ lat, lng, altitude: Math.min(22, Math.max(altitude, objectAltitude + 1.25)) }, 900);
}

function applySceneCamera(scene) {
  if (!scene || scene.camera.fit === "none") return;
  const layers = scene.camera.fit === "active-layer"
    ? scene.layers.filter((layer) => layer.id === scene.camera.layerId)
    : scene.layers;
  fitLocations(locationsForLayers(layers));
}

function activeEncoding() {
  const layer = [...state.layers.values()].reverse().find((item) => item.resultId === state.activeResultId);
  return layer?.encoding || inferColumns(state.results.get(state.activeResultId)?.columns || []);
}

function fitActiveResult() {
  const result = state.results.get(state.activeResultId);
  const encoding = activeEncoding();
  if (!result) return;
  const layer = [...state.layers.values()].reverse().find((item) => item.resultId === state.activeResultId);
  if (layer?.type === "polygons") {
    fitLocations(locationsForLayers([layer]));
    return;
  }
  if (!encoding.latitude || !encoding.longitude) return;
  fitLocations(result.rows
    .map((row) => ({
      latitude: Number(row[encoding.latitude]),
      longitude: Number(row[encoding.longitude]),
      altitude: relativeAltitude(row, encoding, 0),
    }))
    .filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude)));
}

export function presentResult({ resultId, page = 1, selectedIndex = null, fit = true } = {}) {
  const id = resultId || state.activeResultId;
  const result = state.results.get(id);
  if (!result) throw new Error("Unknown result.");
  if (selectedIndex != null && Number(selectedIndex) >= result.rows.length) throw new Error("Selected row is outside this result.");
  state.activeResultId = id;
  state.page = Math.max(0, Number(page) - 1);
  state.selectedRowIndex = selectedIndex == null ? null : Math.max(0, Number(selectedIndex));
  renderResult(result);
  if (state.selectedRowIndex != null) selectRow(state.selectedRowIndex);
  else {
    if (fit) fitActiveResult();
    setWorkspaceSheet(true, "results");
  }
  return { resultId: id, page: state.page + 1, selectedIndex: state.selectedRowIndex };
}

function selectRow(rowIndex, resultId = state.activeResultId) {
  const result = state.results.get(resultId);
  if (!result || !result.rows[rowIndex]) return;
  if (state.activeResultId !== resultId) {
    state.activeResultId = resultId;
    renderResult(result);
  }
  state.selectedRowIndex = rowIndex;
  state.page = Math.floor(rowIndex / PAGE_SIZE);
  renderCurrentPage();
  renderGlobeLayers();
  const row = result.rows[rowIndex];
  const encoding = activeEncoding();
  elements.selectionCard.hidden = false;
  elements.selectionTitle.textContent = rowLabel(row, encoding);
  const detailColumns = result.columns.filter((column) => column !== encoding.label).slice(0, 4);
  elements.selectionDetail.replaceChildren(...detailColumns.map((column) => {
    const field = document.createElement("div");
    field.className = "selection-field";
    const key = document.createElement("dt");
    key.textContent = column;
    const value = document.createElement("dd");
    value.textContent = displayValue(row[column]);
    value.title = String(row[column] ?? "");
    field.append(key, value);
    return field;
  }));
  elements.selectionPosition.textContent = `${formatNumber(rowIndex + 1)} of ${formatNumber(result.rows.length)}`;
  elements.previousSelection.disabled = rowIndex <= 0;
  elements.nextSelection.disabled = rowIndex >= result.rows.length - 1;
  if (window.innerWidth <= 700) setWorkspaceSheet(false);
  if (encoding.latitude && encoding.longitude && Number.isFinite(Number(row[encoding.latitude])) && Number.isFinite(Number(row[encoding.longitude]))) {
    const altitude = relativeAltitude(row, encoding, 0);
    state.globe.pointOfView({ lat: Number(row[encoding.latitude]), lng: Number(row[encoding.longitude]), altitude: Math.min(22, Math.max(0.72, altitude + 0.75)) }, 850);
  }
}

export async function inspectRelation(relation) {
  const name = cleanName(relation);
  const dataset = state.datasets.get(name);
  const result = [...state.results.values()].find((item) => item.relation === relation || item.id === relation);
  if (!dataset && !result) throw new Error(`Unknown relation: ${relation}`);
  if (result?.bootstrap && !state.ready) {
    return {
      relation: result.relation,
      rowCount: result.rowCount,
      schema: result.schema,
      sample: result.rows.slice(0, 5),
      roles: inferColumns(result.columns),
      provenance: resultProvenance(result),
    };
  }
  await ensureEngineReady();
  if (dataset) await ensureDatasetLoaded(name);
  const target = dataset ? name : result.relation;
  const schemaRows = tableToRows(await state.conn.query(`DESCRIBE SELECT * FROM ${quoteIdentifier(target)}`));
  const sample = tableToRows(await state.conn.query(`SELECT * FROM ${quoteIdentifier(target)} LIMIT 5`));
  const rowCount = dataset?.rowCount ?? result.rowCount;
  return {
    relation: target,
    rowCount,
    schema: schemaRows.map((row) => ({ name: row.column_name, type: row.column_type, nullable: row.null === "YES" })),
    sample,
    roles: inferColumns(schemaRows.map((row) => row.column_name)),
    provenance: dataset || resultProvenance(result),
  };
}

export function inspectWorkspace() {
  return {
    ready: state.ready,
    visualization: VISUALIZATION_CAPABILITIES,
    datasets: [...state.datasets.values()].map((item) => ({
      relation: item.relation,
      rows: item.rowCount,
      loaded: state.loadedRelations.has(item.relation),
      title: item.title,
      description: item.description,
      organization: item.organization,
    })),
    results: [...state.results.values()].map((item) => ({ id: item.id, relation: item.relation, rows: item.rowCount, title: item.title, sources: item.sources })),
    scene: state.scene ? {
      headline: state.scene.headline,
      subheadline: state.scene.subheadline,
      camera: state.scene.camera,
      actor: state.scene.actor,
      createdAt: state.scene.createdAt,
      layers: state.scene.layers.map((item) => ({ id: item.id, type: item.type, resultId: item.resultId, title: item.title, encoding: item.encoding, style: item.style })),
    } : null,
    activeResultId: state.activeResultId,
  };
}

export async function loadDataset(input) {
  await ensureEngineReady();
  const relation = cleanName(input.name);
  if (state.datasets.has(relation)) throw new Error(`A dataset named ${relation} already exists.`);
  const format = input.format || (input.url?.toLowerCase().split("?")[0].endsWith(".parquet") ? "parquet" : "csv");
  const fileName = `${relation}.${format === "parquet" ? "parquet" : input.records ? "json" : "csv"}`;
  if (Array.isArray(input.records)) {
    if (!input.records.length || input.records.length > 500) throw new Error("Inline datasets need 1–500 records.");
    await state.db.registerFileText(fileName, input.records.map((row) => JSON.stringify(row)).join("\n"));
    await state.conn.query(`CREATE TABLE ${quoteIdentifier(relation)} AS SELECT * FROM read_json_auto('${fileName}', format = 'newline_delimited')`);
  } else {
    const url = publicDatasetUrl(input.url);
    try {
      const head = await fetch(url, { method: "HEAD", mode: "cors" });
      const contentLength = Number(head.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 50 * 1024 * 1024) throw new Error("Remote datasets are limited to 50 MB in this proof of concept.");
    } catch (error) {
      if (/limited to 50 MB/.test(error.message)) throw error;
    }
    await state.db.registerFileURL(fileName, url.href, state.duckdb.DuckDBDataProtocol.HTTP, false);
    const reader = format === "parquet" ? "read_parquet" : "read_csv_auto";
    await state.conn.query(`CREATE TABLE ${quoteIdentifier(relation)} AS SELECT * FROM ${reader}('${fileName}') LIMIT 100000`);
  }
  const rowCount = Number(tableToRows(await state.conn.query(`SELECT count(*) AS count FROM ${quoteIdentifier(relation)}`))[0].count);
  state.datasets.set(relation, {
    relation,
    rowCount,
    color: COLORS[state.datasets.size % COLORS.length],
    title: input.sourceTitle || relation,
    organization: input.organization || (input.records ? "Agent-supplied records" : new URL(input.url).hostname),
    sourceUrl: safeHttpUrl(input.sourceUrl) || safeHttpUrl(input.url),
    license: input.license || "Not specified",
    retrieved: new Date().toISOString(),
    notes: input.records ? "Agent-supplied inline records; not independently verified." : "Loaded from a remote URL in this browser session.",
    kind: input.records ? "agent" : "remote",
  });
  state.loadedRelations.add(relation);
  renderDatasetList();
  return inspectRelation(relation);
}

function showError(error) {
  elements.queryError.hidden = false;
  elements.queryError.textContent = error?.message || String(error);
}

async function runFromEditor() {
  elements.queryError.hidden = true;
  elements.runQuery.disabled = true;
  elements.runQuery.firstChild.textContent = "Running ";
  try {
    const headline = elements.sqlEditor.dataset.headline || "Custom SQL result";
    const result = await executeSql(elements.sqlEditor.value, { title: headline, actor: "user" });
    renderGlobeScene({
      headline,
      subheadline: elements.sqlEditor.dataset.subheadline || `${formatNumber(result.rowCount)} rows returned from the local catalog.`,
      layers: [{ id: `${result.id}_${elements.layerType.value}`, resultId: result.id, type: elements.layerType.value, title: result.title }],
      camera: { fit: "all-layers" },
    }, { actor: "user" });
  } catch (error) {
    showError(error);
  } finally {
    elements.runQuery.disabled = false;
    elements.runQuery.firstChild.textContent = "Run query ";
  }
}

function selectSheetTab(tabName) {
  $$('[data-sheet-tab]').forEach((button) => {
    const active = button.dataset.sheetTab === tabName;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  ["results", "data", "sql"].forEach((name) => {
    $(`#${name}-panel`).hidden = name !== tabName;
  });
  if (tabName === "data") hydrateDatasetImages();
}

function setWorkspaceSheet(open, tabName = "results") {
  elements.workspaceSheet.hidden = !open;
  elements.sheetBackdrop.hidden = !open;
  elements.resultPeek.setAttribute("aria-expanded", String(open));
  if (open) {
    setShowcaseMenu(false);
    selectSheetTab(tabName);
    elements.sheetClose.focus({ preventScroll: true });
  } else if (document.activeElement === elements.sheetClose || elements.workspaceSheet.contains(document.activeElement)) {
    elements.resultPeek.focus({ preventScroll: true });
  }
}

function wireUi() {
  $$("[data-example]").forEach((button) => button.addEventListener("click", () => {
    const example = examples[button.dataset.example];
    elements.sqlEditor.value = example.sql;
    elements.sqlEditor.dataset.headline = example.headline;
    elements.sqlEditor.dataset.subheadline = example.subheadline;
    elements.layerType.value = example.layerType;
  }));
  elements.sqlEditor.addEventListener("input", () => {
    delete elements.sqlEditor.dataset.headline;
    delete elements.sqlEditor.dataset.subheadline;
  });
  elements.runQuery.addEventListener("click", runFromEditor);
  elements.sqlEditor.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      runFromEditor();
    }
  });
  elements.previousPage.addEventListener("click", () => { state.page -= 1; renderCurrentPage(); });
  elements.nextPage.addEventListener("click", () => { state.page += 1; renderCurrentPage(); });
  elements.previousSelection.addEventListener("click", () => selectRow(Math.max(0, state.selectedRowIndex - 1)));
  elements.nextSelection.addEventListener("click", () => {
    const result = state.results.get(state.activeResultId);
    if (result) selectRow(Math.min(result.rows.length - 1, state.selectedRowIndex + 1));
  });
  $("#fit-view").addEventListener("click", fitActiveResult);
  elements.resultPeek.addEventListener("click", () => setWorkspaceSheet(elements.workspaceSheet.hidden, "results"));
  elements.sheetClose.addEventListener("click", () => setWorkspaceSheet(false));
  elements.sheetBackdrop.addEventListener("click", () => setWorkspaceSheet(false));
  $$('[data-sheet-tab]').forEach((button) => button.addEventListener("click", () => selectSheetTab(button.dataset.sheetTab)));
  elements.showcaseButton.addEventListener("click", () => setShowcaseMenu(elements.showcaseMenu.hidden));
  document.addEventListener("click", (event) => {
    if (!elements.showcaseMenu.hidden && !elements.showcaseMenu.contains(event.target) && !elements.showcaseButton.contains(event.target)) {
      setShowcaseMenu(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!elements.workspaceSheet.hidden) setWorkspaceSheet(false);
      else if (!elements.showcaseMenu.hidden) {
        setShowcaseMenu(false);
        elements.showcaseButton.focus();
      }
    }
  });
}

async function init() {
  wireUi();
  renderShowcaseList();
  initGlobe();
  markPerformance("atlas:globe-created");
  const defaultScene = interestingScenes.find((scene) => scene.id === DEFAULT_SCENE_ID) || interestingScenes[0];
  syncShowcaseControls(defaultScene);
  const bootstrapTask = renderBootstrapScene().catch((error) => {
    console.warn("The preloaded scene was unavailable; DuckDB will render it instead.", error);
  });
  try {
    setStatus("Loading catalog…");
    const catalogTask = loadCatalogMetadata().then(prepareBuiltInDatasets);
    engineInitializationPromise = firstGlobeStartupGate.then(async () => {
      setStatus("Preparing local engine…");
      elements.sheetEngineStatus.textContent = "Preparing local data…";
      await initDuckDb();
      state.ready = true;
      markPerformance("atlas:engine-ready");
      setStatus("Local engine ready", "ready");
      elements.sheetEngineStatus.textContent = "Local data ready";
    });
    await Promise.all([catalogTask, bootstrapTask]);
    const { registerWebMcpTools } = await import(assetUrl("./webmcp.js").href);
    await registerWebMcpTools();
    await engineInitializationPromise;
  } catch (error) {
    console.error(error);
    setStatus("Engine failed", "error");
    showError(error);
  }
}

init();
