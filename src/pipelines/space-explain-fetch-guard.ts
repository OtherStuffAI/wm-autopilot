import { readBoundedText } from "./space-explain-runtime";

/** Preloaded into the Space CLI worker: transport cannot read private Tower routes or follow redirects. */
export function guardExplainFetch(fetchImpl: typeof fetch, towerOrigin: string, brokerOrigin: string,
  concept: string, version: string, workerNpub: string): typeof fetch {
  let walkRead = false;
  const sourceReads = new Set<string>();
  let nextSignAt = 0;
  return (async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(target instanceof Request ? target.url : target.toString());
    const method = (init?.method ?? (target instanceof Request ? target.method : "GET")).toUpperCase();
    if (url.username || url.password || url.hash) throw new Error("transport_denied");
    if (url.origin === towerOrigin) {
      const path = url.pathname.match(/^\/api\/v4\/learning\/research\/concepts\/([a-z0-9-]+)\/(walk|sources)$/);
      if (method !== "GET" || !path || url.searchParams.get("version") !== version ||
        [...url.searchParams.keys()].some(key => !["version", "depth", "limit"].includes(key))) throw new Error("transport_denied");
      if (path[2] === "walk" && (path[1] !== concept || url.searchParams.get("depth") !== "1" || url.searchParams.get("limit") !== "13")) throw new Error("transport_denied");
      if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw new Error("transport_denied");
      if (path[2] === "walk") {
        if (walkRead) throw new Error("transport_denied");
        walkRead = true;
      } else {
        if (sourceReads.has(path[1]!) || sourceReads.size >= 13) throw new Error("transport_denied");
        sourceReads.add(path[1]!);
      }
    } else if (url.origin === brokerOrigin) {
      if (method !== "POST" || url.search || !["/api/mcp/capabilities/nip98", "/api/mcp/capabilities/refresh"].includes(url.pathname)) throw new Error("transport_denied");
      if (url.pathname.endsWith("/nip98")) {
        const body = JSON.parse(String(init?.body));
        const signed = new URL(body.url);
        if (signed.origin !== towerOrigin || body.method !== "GET" || !/^\/api\/v4\/learning\/research\/concepts\/[a-z0-9-]+\/(walk|sources)$/.test(signed.pathname)) throw new Error("transport_denied");
        await Bun.sleep(Math.max(0, nextSignAt - Date.now()));
        nextSignAt = Date.now() + 1100;
      }
    } else throw new Error("transport_denied");
    const response = await fetchImpl(target, { ...init, redirect: "error" });
    const text = await readBoundedText(response.body, 256_000);
    if (url.origin === brokerOrigin && url.pathname.endsWith("/nip98") && response.ok) {
      if (JSON.parse(text).signedBy !== workerNpub) throw new Error("worker_identity_mismatch");
    }
    return new Response(text, { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

if (process.env.SPACE_EXPLAIN_GUARD === "1") {
  globalThis.fetch = guardExplainFetch(globalThis.fetch, process.env.TOWER_URL!,
    new URL(process.env.WINGMAN_URL!).origin, process.env.SPACE_EXPLAIN_CONCEPT!, process.env.SPACE_EXPLAIN_VERSION!, process.env.SPACE_EXPLAIN_WORKER_NPUB!);
}
