# Third-party notices

The static build includes these open-source runtime packages:

- DuckDB-Wasm 1.33.1-dev57.0 — MIT — <https://github.com/duckdb/duckdb-wasm>
- Apache Arrow JavaScript 17.0.0 — Apache-2.0 — <https://github.com/apache/arrow-js>
- FlatBuffers 24.3.25 — Apache-2.0 — <https://github.com/google/flatbuffers>
- tslib 2.8.1 — 0BSD — <https://github.com/microsoft/tslib>
- Globe.gl 2.46.2 — MIT — <https://github.com/vasturiano/globe.gl>
- three-globe 2.45.2 — MIT — <https://github.com/vasturiano/three-globe>
- Three.js — MIT — <https://github.com/mrdoob/three.js>
- world-atlas 2.0.2 — ISC — <https://github.com/topojson/world-atlas> (source of the derived country-boundary snapshot)

Exact dependency versions and their transitive graph are pinned in `package-lock.json`. The corresponding license texts are checked in under `third_party/licenses/` and copied into the static build.

The night globe texture is adapted from the three-globe example assets. The application source does not copy executable third-party packages into Git: `npm run vendor` extracts only the pinned browser runtime files required by the static app.

Bundled data is not relicensed by Atlas. See [DATA_LICENSES.md](DATA_LICENSES.md) and `data/sources.json` for publisher terms, attribution, provenance, transformations, and caveats.
