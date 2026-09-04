# Bundled data licenses and attribution

Atlas does not relicense third-party data. Each compact snapshot remains under its publisher's terms. `data/sources.json` contains the exact source URL, retrieval date, transformation notes, caveats, and SHA-256 digest for every relation.

| Relations | Source and terms | Attribution |
| --- | --- | --- |
| `drifter_loopers` | NOAA/AOML Global Drifter Program, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | NOAA Atlantic Oceanographic and Meteorological Laboratory, Global Drifter Program |
| `atlantic_storms` | NOAA/NCEI IBTrACS v4r01, [full and open distribution policy](https://www.ncei.noaa.gov/products/international-best-track-archive) | Gahtan et al. (2024), International Best Track Archive for Climate Stewardship, NOAA NCEI, DOI 10.25921/82ty-9e16 |
| `country_boundaries` | Natural Earth source data, [public domain](https://www.naturalearthdata.com/about/terms-of-use/); derived from world-atlas 2.0.2, ISC | Natural Earth and world-atlas contributors |
| `earthquakes` | USGS-authored data, [U.S. public domain](https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted) | U.S. Geological Survey Earthquake Hazards Program |
| `tsunami_events`, `tsunami_runups` | NOAA/NCEI/WDS Global Historical Tsunami Database, [unrestricted access with citation](https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ngdc.mgg.hazards%3AG02151) | National Geophysical Data Center / World Data Service, NOAA NCEI, DOI 10.7289/V5PN93H7 |
| `us_tornado_tracks` | NOAA Storm Prediction Center federal data; U.S. government works are public domain | NOAA/NWS Storm Prediction Center |
| `major_rivers` | Natural Earth, [public domain](https://www.naturalearthdata.com/about/terms-of-use/) | Natural Earth |
| `global_chains` | Overture Maps Places, [CDLA Permissive 2.0](https://docs.overturemaps.org/attribution/) with documented upstream open-source licenses | Overture Maps Foundation and the source providers identified by Overture |
| `theme_parks_landmarks` | Wikidata, [CC0 1.0](https://www.wikidata.org/wiki/Wikidata:Licensing) | Wikidata contributors |

The country names assigned to `global_chains` were computed locally against the bundled Natural Earth boundaries. Brand names and other marks remain the property of their respective owners; their appearance describes source records and does not imply affiliation or endorsement.

The generated watercolor catalog thumbnails and Open Graph artwork are project assets covered by the repository's MIT license. They contain no publisher imagery.
