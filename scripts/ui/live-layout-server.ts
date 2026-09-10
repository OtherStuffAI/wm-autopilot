// Isolated production static-asset server for the browser regression runner.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createProjectStaticAssetService } from "../../src/server/static-assets.ts";
const root = resolve(import.meta.dir, "../..");
const baselineRef = process.env.UI_BASELINE_REF;
const assets = createProjectStaticAssetService(root);
const index = (await Bun.file(`${root}/src/ui/index.html`).text()).replace('src="/app.js"', 'src="/layout-fixture.js"');
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/live")
    return new Response(index, { headers: { "content-type": "text/html" } });
  if (path === "/layout-fixture.js")
    return new Response(Bun.file(`${root}/scripts/ui/live-phone-fixture.js`), { headers: { "content-type": "application/javascript" } });
  if (path.startsWith("/api/"))
    return Response.json({ artifacts: [] });
  if (baselineRef && ["/live/phone-layout.css", "/live/mobile-runtime.js", "/views/live-view.js"].includes(path)) {
    const result = Bun.spawnSync(["git", "show", `${baselineRef}:src/ui${path}`], { cwd: root });
    assert.equal(result.exitCode, 0);
    return new Response(result.stdout, { headers: { "content-type": path.endsWith("css") ? "text/css" : "application/javascript" } });
  }
  if (process.env.UI_SERVED_URL && /\.(js|css|mjs)$/.test(path)) {
    const response = await fetch(new URL(path, process.env.UI_SERVED_URL));
    // fetch decompresses the body; do not forward its original gzip header.
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/octet-stream" },
    });
  }
  return assets.resolveUiAsset(path) || assets.servePublicAsset(path) || await assets.serveVendorModule(path) || new Response("Missing test asset", { status: 404 });
} });
console.log(JSON.stringify({ url: server.url.toString() }));
