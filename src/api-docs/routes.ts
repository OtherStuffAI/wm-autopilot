import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenApiSpec } from "./openapi";

const swaggerDirectory = dirname(fileURLToPath(import.meta.resolve("swagger-ui-dist/package.json")));
const localDirectory = dirname(fileURLToPath(import.meta.url));
const assets: Record<string, { path: string; type: string }> = {
  "/api/docs/swagger-ui-bundle.js": { path: join(swaggerDirectory, "swagger-ui-bundle.js"), type: "application/javascript" },
  "/api/docs/swagger-ui.css": { path: join(swaggerDirectory, "swagger-ui.css"), type: "text/css" },
  "/api/docs/swagger-initializer.js": { path: join(localDirectory, "swagger-initializer.js"), type: "application/javascript" },
};

export function handleApiDocs(request: Request, url: URL): Response | null {
  const relevant = url.pathname === "/api/docs" || url.pathname === "/api/docs/openapi.json" || Object.hasOwn(assets, url.pathname);
  if (!relevant) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const headers = { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  if (url.pathname === "/api/docs/openapi.json") return new Response(request.method === "HEAD" ? null : JSON.stringify(createOpenApiSpec()),
    { headers: { ...headers, "Content-Type": "application/json" } });
  const asset = assets[url.pathname];
  if (asset) return new Response(request.method === "HEAD" ? null : Bun.file(asset.path), { headers: { ...headers, "Content-Type": asset.type } });
  return new Response(request.method === "HEAD" ? null : `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autopilot API documentation</title><link rel="stylesheet" href="/api/docs/swagger-ui.css"></head>
<body><header><h1>Autopilot API</h1><p>Calls require a fresh NIP-98 signature and current access approval.</p>
<p>For interactive requests, enable a NIP-07 browser signer. Your key stays in your signer.</p>
<a href="/api/docs/openapi.json" aria-label="Download the OpenAPI specification" data-testid="openapi-download">OpenAPI JSON</a></header>
<main aria-label="API documentation" data-testid="api-docs"><div id="swagger-ui"></div></main>
<aside role="status" aria-live="polite">Interactive requests ask your signer for authorization.</aside>
<script src="/api/docs/swagger-ui-bundle.js"></script><script src="/api/docs/swagger-initializer.js"></script></body></html>`,
    { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'" } });
}
