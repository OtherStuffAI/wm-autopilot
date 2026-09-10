// Isolated full-app review: production assets, synthetic reads, no mutations.
import { resolve } from "node:path";
import { createProjectStaticAssetService } from "../../src/server/static-assets.ts";
import { responses } from "./phone-screens-data.ts";
const root = resolve(import.meta.dir, "../..");
const assets = createProjectStaticAssetService(root);
let index = (await Bun.file(`${root}/src/ui/index.html`).text()).replace('src="/app.js"', 'src="/review-fixture.js"');
if (process.env.UI_BASELINE) index = index.replace('<link rel="stylesheet" href="/phone-layout.css" />', "");
const requests: string[] = [];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/review-requests") return Response.json(requests);
  if (path === "/review-fixture.js") return new Response(Bun.file(`${root}/scripts/ui/phone-screens-fixture.js`), { headers: { "content-type": "application/javascript" } });
  if (path === "/api/docs/file/raw" && request.method === "GET") return Response.json({ base64: Buffer.from("# Review notes\n\nLong preview content wraps on small phones.\n\n".repeat(12)).toString("base64"), mtimeMs: 1 });
  if (path.startsWith("/api/") && !path.endsWith(".js")) {
    requests.push(`${request.method} ${path}`);
    if (request.method !== "GET") return Response.json({ error: "Review fixture forbids mutations" }, { status: 405 });
    if (Object.hasOwn(responses, path)) return Response.json(responses[path]);
    return Response.json({ error: `No synthetic response for ${path}` }, { status: 404 });
  }
  if (/^\/(home|settings|apps|projects|files|scheduler|pipelines|nightwatch|terminal|chat|privacy|live)(\/|$)/.test(path) && !/\.(js|css|mjs)$/.test(path)) return new Response(index, { headers: { "content-type": "text/html" } });
  return assets.resolveUiAsset(path) || assets.servePublicAsset(path) || await assets.serveVendorModule(path) || new Response("Missing review asset", { status: 404 });
} });
console.log(JSON.stringify({ url: server.url.toString() }));
