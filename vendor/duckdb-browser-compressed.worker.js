const variant = new URL(self.location.href).searchParams.get("variant");
if (!new Set(["eh", "mvp"]).has(variant)) throw new Error("Unknown DuckDB worker variant.");

const nativeFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const url = new URL(requestUrl, self.location.href);
  if (url.pathname.endsWith(`/duckdb-${variant}.wasm`) && "DecompressionStream" in self) {
    try {
      const compressedUrl = new URL(url);
      compressedUrl.pathname += ".gz";
      const compressed = await nativeFetch(compressedUrl, init);
      if (compressed.ok && compressed.body) {
        const headers = new Headers(compressed.headers);
        headers.delete("Content-Encoding");
        headers.delete("Content-Length");
        headers.set("Content-Type", "application/wasm");
        return new Response(compressed.body.pipeThrough(new DecompressionStream("gzip")), {
          status: 200,
          statusText: "OK",
          headers,
        });
      }
    } catch (error) {
      console.warn("Compressed DuckDB module unavailable; using the unpacked module.", error);
    }
  }
  return nativeFetch(input, init);
};

const workerBundleUrl = new URL(`./duckdb-browser-${variant}.worker.js`, self.location.href);
const buildVersion = new URL(self.location.href).searchParams.get("v");
if (buildVersion) workerBundleUrl.searchParams.set("v", buildVersion);
importScripts(workerBundleUrl.href);
