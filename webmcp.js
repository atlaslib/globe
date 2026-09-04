import {
  executeSql,
  inspectRelation,
  inspectWorkspace,
  loadDataset,
  presentResult,
  renderGlobeScene,
  state,
} from "./app.js";

const lifecycle = new AbortController();

function requireObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object.");
  return input;
}

function requireString(input, key, maxLength = 12_000) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  if (value.length > maxLength) throw new Error(`${key} is too long.`);
  return value.trim();
}

function optionalString(input, key, maxLength = 300) {
  const value = input[key];
  if (value == null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${key} must be a string of at most ${maxLength} characters.`);
  return value.trim() || undefined;
}

function compactValue(value) {
  if (typeof value === "string" && value.length > 100) return `${value.slice(0, 97)}…`;
  if (Array.isArray(value)) return value.slice(0, 8).map(compactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 8).map(([key, item]) => [key, compactValue(item)]));
  return value;
}

function compactSampleRow(row, roles) {
  const roleColumns = [roles.label, roles.latitude, roles.longitude, roles.altitude, roles.geometry, roles.group, roles.order, roles.size].filter(Boolean);
  const columns = [...new Set([...roleColumns, ...Object.keys(row)])].slice(0, 10);
  return Object.fromEntries(columns.map((column) => [column, compactValue(row[column])]));
}

function compactRelation(info) {
  const provenance = info.provenance || {};
  return {
    relation: info.relation,
    rowCount: info.rowCount,
    schema: info.schema.slice(0, 12),
    schemaTruncated: info.schema.length > 12,
    roles: info.roles,
    sample: info.sample.slice(0, 2).map((row) => compactSampleRow(row, info.roles)),
    provenance: {
      title: compactValue(provenance.title),
      organization: compactValue(provenance.organization),
      sourceUrl: provenance.sourceUrl,
      license: compactValue(provenance.license),
      licenseUrl: provenance.licenseUrl,
      snapshotId: provenance.snapshotId,
      snapshotAt: provenance.snapshotAt,
      manifestUrl: provenance.manifestUrl,
      methodology: compactValue(provenance.methodology),
      caveats: compactValue(provenance.caveats),
      sources: compactValue(provenance.sources),
      notes: compactValue(provenance.notes),
      sql: compactValue(provenance.sql),
    },
  };
}

function compactWorkspace(info) {
  return {
    ready: info.ready,
    visualization: compactValue(info.visualization),
    datasets: info.datasets.map((dataset) => ({
      relation: dataset.relation,
      rows: dataset.rows,
      loaded: dataset.loaded,
      title: compactValue(dataset.title),
      description: compactValue(dataset.description),
    })),
    results: info.results.slice(-8).map(compactValue),
    resultsTruncated: info.results.length > 8,
    scene: compactValue(info.scene),
    activeResultId: info.activeResultId,
  };
}

async function withCancellation(signal, task) {
  signal?.throwIfAborted();
  const cancel = () => void state.conn?.cancelSent?.().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const value = await task();
    signal?.throwIfAborted();
    return value;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function tool(definition) {
  try {
    return document.modelContext.registerTool(definition, { signal: lifecycle.signal });
  } catch (error) {
    return Promise.reject(error);
  }
}

export async function registerWebMcpTools() {
  const status = document.querySelector("#webmcp-status");
  if (!document.modelContext?.registerTool) {
    status.textContent = "WebMCP unsupported";
    return { supported: false, registered: 0 };
  }

  const registrations = [
    tool({
      name: "inspect_workspace",
      title: "Inspect workspace",
      description: "List available DuckDB relations, whether each is loaded, saved query results, globe layers, and the active result. Use this first to understand the current spatial workspace.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, { signal } = {}) {
        requireObject(input);
        return withCancellation(signal, async () => compactWorkspace(inspectWorkspace()));
      },
    }),
    tool({
      name: "inspect_relation",
      title: "Inspect relation",
      description: "Inspect one dataset or saved result before writing SQL. Returns schema, inferred geographic/time roles, row count, sample rows, and source provenance.",
      inputSchema: {
        type: "object",
        properties: { relation: { type: "string", description: "Relation, result ID, or saved result relation." } },
        required: ["relation"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, { signal } = {}) {
        const value = requireObject(input);
        const relation = requireString(value, "relation", 80);
        return withCancellation(signal, async () => compactRelation(await inspectRelation(relation)));
      },
    }),
    tool({
      name: "load_dataset",
      title: "Load dataset",
      description: "Load an HTTPS CSV/Parquet URL or up to 500 inline records into DuckDB as a named relation. Include source and license details so the workspace can preserve provenance.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short SQL-safe relation name; it will be normalized." },
          url: { type: "string", description: "Public HTTPS CSV or Parquet URL. Must allow browser CORS." },
          format: { type: "string", enum: ["csv", "parquet"], description: "Remote file format. Inferred from URL if omitted." },
          records: { type: "array", maxItems: 500, description: "Small JSON records supplied directly by the agent.", items: { type: "object" } },
          sourceTitle: { type: "string", description: "Human-readable dataset or source title." },
          sourceUrl: { type: "string", description: "Canonical page that documents inline records." },
          organization: { type: "string", description: "Source organization or publisher." },
          license: { type: "string", description: "Dataset license or usage terms." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, { signal } = {}) {
        const value = requireObject(input);
        const name = requireString(value, "name", 60);
        const hasUrl = typeof value.url === "string" && value.url.trim();
        const hasRecords = Array.isArray(value.records);
        if (Boolean(hasUrl) === Boolean(hasRecords)) throw new Error("Provide exactly one of url or records.");
        const normalized = {
          name,
          url: hasUrl ? requireString(value, "url", 2_000) : undefined,
          format: value.format,
          records: hasRecords ? value.records : undefined,
          sourceTitle: optionalString(value, "sourceTitle"),
          sourceUrl: optionalString(value, "sourceUrl", 2_000),
          organization: optionalString(value, "organization"),
          license: optionalString(value, "license"),
        };
        return withCancellation(signal, async () => compactRelation(await loadDataset(normalized)));
      },
    }),
    tool({
      name: "execute_sql",
      title: "Execute SQL",
      description: "Run one read-only SELECT/WITH query across available DuckDB relations. Referenced bundled datasets load on demand. Saves a capped result, updates the result table, and records SQL lineage for rendering.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "DuckDB SELECT or WITH query. File, network, DDL, and mutation operations are blocked." },
          title: { type: "string", description: "Short title for the result and result panel." },
        },
        required: ["sql"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, { signal } = {}) {
        const value = requireObject(input);
        const sql = requireString(value, "sql");
        const title = optionalString(value, "title", 120) || "Agent query";
        return withCancellation(signal, async () => {
          const result = await executeSql(sql, { title, actor: "agent" });
          return {
            resultId: result.id,
            relation: result.relation,
            title: result.title,
            rowCount: result.rowCount,
            truncated: result.truncated,
            columns: result.columns.slice(0, 24),
            columnsTruncated: result.columns.length > 24,
            sources: result.sources,
            durationMs: result.durationMs,
            preview: result.rows.slice(0, 2).map(compactValue),
          };
        });
      },
    }),
    tool({
      name: "render_globe_scene",
      title: "Render globe scene",
      description: "Present an explanation as a headline, subheadline, and up to eight declarative globe layers. Each layer references a saved SQL result and maps columns to visual roles.",
      inputSchema: {
        type: "object",
        properties: {
          headline: { type: "string", maxLength: 120, description: "Specific conclusion or subject shown prominently over the globe." },
          subheadline: { type: "string", maxLength: 220, description: "One concise sentence explaining what is shown and why it matters." },
          layers: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            description: "Ordered back-to-front scene layers. The last layer also becomes the active table result.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", maxLength: 80, description: "Stable scene-unique layer ID." },
                resultId: { type: "string", maxLength: 80, description: "Saved result ID returned by execute_sql." },
                type: { type: "string", enum: ["points", "paths", "rings", "polygons"], description: "Normalized spatial mark type." },
                title: { type: "string", maxLength: 120, description: "Compact label used in the globe legend." },
                encoding: {
                  type: "object",
                  description: "Result columns assigned to visual roles. Geographic roles are inferred when omitted.",
                  properties: {
                    latitude: { type: "string", description: "Latitude column." },
                    longitude: { type: "string", description: "Longitude column." },
                    altitude: { type: "string", description: "Optional altitude in kilometers above the Earth reference ellipsoid." },
                    geometry: { type: "string", description: "GeoJSON Polygon or MultiPolygon geometry column." },
                    group: { type: "string", description: "Series or path identifier column." },
                    order: { type: "string", description: "Path point ordering column." },
                    label: { type: "string", description: "Hover and selection label column." },
                    size: { type: "string", description: "Optional numeric ring-size column." },
                  },
                  additionalProperties: false,
                },
                style: {
                  type: "object",
                  description: "Validated fixed styling. Width and animate affect paths; radius affects points or rings.",
                  properties: {
                    color: { type: "string", maxLength: 60, description: "CSS color; omit for deterministic group colors." },
                    opacity: { type: "number", minimum: 0.1, maximum: 1, description: "Layer opacity." },
                    width: { type: "number", minimum: 0.1, maximum: 4, description: "Path stroke width." },
                    radius: { type: "number", minimum: 0.05, maximum: 20, description: "Point radius or ring maximum radius." },
                    animate: { type: "boolean", description: "Whether path dashes move." },
                  },
                  additionalProperties: false,
                },
              },
              required: ["id", "resultId", "type"],
              additionalProperties: false,
            },
          },
          camera: {
            type: "object",
            description: "Initial camera behavior after the scene is committed.",
            properties: {
              fit: { type: "string", enum: ["all-layers", "active-layer", "none"], description: "Fit every layer, one layer, or preserve the camera." },
              layerId: { type: "string", maxLength: 80, description: "Layer to fit when fit is active-layer; defaults to the last layer." },
            },
            additionalProperties: false,
          },
        },
        required: ["headline", "subheadline", "layers"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, { signal } = {}) {
        const value = requireObject(input);
        return withCancellation(signal, async () => {
          const scene = renderGlobeScene(value, { actor: "agent" });
          return {
            headline: scene.headline,
            subheadline: scene.subheadline,
            camera: scene.camera,
            activeResultId: scene.layers.at(-1).resultId,
            layers: scene.layers.map((layer) => ({ id: layer.id, type: layer.type, resultId: layer.resultId })),
          };
        });
      },
    }),
    tool({
      name: "present_result",
      title: "Present result",
      description: "Bring a saved result into the visible table, open a 1-based page, optionally select a 0-based row, and fit the globe. Use after rendering to focus the user's attention.",
      inputSchema: {
        type: "object",
        properties: {
          resultId: { type: "string", description: "Saved result ID returned by execute_sql." },
          page: { type: "integer", minimum: 1, description: "One-based result page." },
          selectedIndex: { type: "integer", minimum: 0, description: "Optional zero-based row index to select." },
          fit: { type: "boolean", description: "Fit the globe to the result when no row is selected." },
        },
        required: ["resultId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, { signal } = {}) {
        const value = requireObject(input);
        const args = {
          resultId: requireString(value, "resultId", 80),
          page: value.page == null ? 1 : Number(value.page),
          selectedIndex: value.selectedIndex == null ? null : Number(value.selectedIndex),
          fit: value.fit !== false,
        };
        if (!Number.isInteger(args.page) || args.page < 1) throw new Error("page must be an integer of at least 1.");
        if (args.selectedIndex != null && (!Number.isInteger(args.selectedIndex) || args.selectedIndex < 0)) throw new Error("selectedIndex must be a non-negative integer.");
        return withCancellation(signal, async () => presentResult(args));
      },
    }),
  ];

  try {
    await Promise.all(registrations.map((registration) => Promise.resolve(registration)));
    status.textContent = "6 WebMCP tools ready";
    return { supported: true, registered: 6 };
  } catch (error) {
    lifecycle.abort();
    status.textContent = "WebMCP registration failed";
    console.error("WebMCP registration failed", error);
    return { supported: true, registered: 0, error: error.message };
  }
}

window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
