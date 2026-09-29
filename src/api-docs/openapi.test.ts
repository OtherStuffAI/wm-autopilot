import { describe, expect, test } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import { createApiRouteHandler, type ApiRoutesContext } from "../server/api-routes";
import { createOpenApiSpec } from "./openapi";
import { endpointCatalog } from "./endpoint-catalog";
import { handleApiDocs } from "./routes";
import { acceptedExample, runExample } from "./schemas";

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("uri", value => { try { new URL(value); return true; } catch { return false; } });
ajv.addFormat("date-time", value => Number.isFinite(Date.parse(value)));

async function dereferenced() {
  return await SwaggerParser.dereference(createOpenApiSpec() as any) as any;
}

describe("hosted OpenAPI", () => {
  test("OpenAPI parser validates document and examples conform to response/request schemas", async () => {
    const parsed = await SwaggerParser.validate(createOpenApiSpec() as any);
    expect(parsed.openapi).toBe("3.0.3");
    const spec = await dereferenced();
    const start = spec.paths["/api/pipelines/definitions/{id}/runs"].post;
    const requestSchema = start.requestBody.content["application/json"].schema;
    const checkRequest = ajv.compile(requestSchema);
    for (const example of Object.values(start.requestBody.content["application/json"].examples) as Array<{ value: unknown }>) expect(checkRequest(example.value)).toBe(true);
    expect(checkRequest({ mode: "invalid" })).toBe(false);
    expect(checkRequest({ waitSeconds: 61 })).toBe(false);
    const checkResult = ajv.compile(spec.components.schemas.RunEnvelope);
    for (const example of [runExample, acceptedExample, { ...runExample, status: "error", error: "Step failed", result: {} }]) expect(checkResult(example)).toBe(true);
    expect(checkResult({ ...runExample, status: "imaginary" })).toBe(false);
    const callback = start.callbacks.terminalResult["{$request.body#/webhook/url}"].post;
    expect(ajv.compile(callback.requestBody.content["application/json"].schema)(callback.requestBody.content["application/json"].example)).toBe(true);
    const delivery = { id: "delivery", runId: runExample.runId, url: "https://receiver.example/result", status: "pending", attempts: 1, nextAttemptAt: 1000, lastError: null, lastHttpStatus: null, deliveredAt: null };
    const checkDelivery = ajv.compile(spec.components.schemas.DeliveryEnvelope);
    expect(checkDelivery({ ...runExample, delivery })).toBe(true);
    expect(checkDelivery({ ...runExample, delivery: null })).toBe(true);
  });

  test("local HTTP route dispatch serves public docs/assets with correct MIME and no file-route interception", async () => {
    // Docs dispatch must succeed before consulting private auth/workspace context.
    const handler = createApiRouteHandler({ resolveWorkspace: () => { throw new Error("Docs consulted workspace"); } } as unknown as ApiRoutesContext);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler(request, new URL(request.url), request.method as any, { npub: null, actorNpub: null, session: null }) });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const html = await fetch(`${base}/api/docs`);
      expect(html.status).toBe(200);
      expect(html.headers.get("Content-Type")).toContain("text/html");
      const page = await html.text();
      expect(page).toContain('data-testid="api-docs"');
      expect(page).toContain('aria-live="polite"');
      const response = await fetch(`${base}/api/docs/openapi.json`);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toEqual(createOpenApiSpec());
      for (const [asset, type] of [["swagger-ui-bundle.js", "application/javascript"], ["swagger-initializer.js", "application/javascript"], ["swagger-ui.css", "text/css"]]) {
        const result = await fetch(`${base}/api/docs/${asset}`);
        expect(result.status).toBe(200); expect(result.headers.get("Content-Type")).toBe(type);
        expect((await result.text()).length).toBeGreaterThan(100);
      }
      expect((await fetch(`${base}/api/docs`, { method: "HEAD" })).status).toBe(200);
      expect((await fetch(`${base}/api/docs/openapi.json`, { method: "POST", body: "{}" })).status).toBe(405);
      for (const path of ["/api/docs/file", "/api/docs/tree", "/api/docs/../../package.json", "/api/docs/unlisted.js"]) {
        const request = new Request(`${base}${path}`);
        expect(handleApiDocs(request, new URL(request.url))).toBeNull();
      }
    } finally { server.stop(true); }
  });

  test("catalog stays tied to route sources and verified NIP-98 dispatch families", async () => {
    const apiDispatch = await Bun.file(new URL("../server/api-routes.ts", import.meta.url)).text();
    const spec = createOpenApiSpec();
    const families = ["pipelines", "sessions", "archive", "apps", "workspace", "wapps", "scheduler", "docs", "directories", "delegations", "agent-chat", "owners"];
    for (const [method, path, _summary, access, source] of endpointCatalog) {
      expect(families).toContain(path.split("/")[2]!);
      expect(apiDispatch).toContain("resolveNip98AuthContext");
      const code = await Bun.file(source).text();
      // Check concrete path tokens in dispatch source, including regex/dynamic segment dispatch.
      for (const part of path.split("/").filter(part => part && !part.startsWith("{") && part !== "api" && part !== "v1" && part !== "control-plane")) expect(code).toContain(part);
      expect(code.toUpperCase()).toContain(method.toUpperCase());
      expect((spec.paths[path]![method] as any).security).toEqual([{ NIP98: [] }]);
      expect(access.length).toBeGreaterThan(10);
    }
    for (const excluded of ["/api/pipelines/runs/{id}/steps/{stepId}/callback", "/api/pipelines/triggers/http/{key}", "/api/internal/signing", "/api/system/restart", "/api/mcp/nip98", "/api/todos", "/api/skills"]) expect(spec.paths).not.toHaveProperty(excluded);
    expect(spec.servers).toEqual([{ url: "/", description: "This Autopilot origin" }]);
    expect(spec.components.securitySchemes.NIP98).toMatchObject({ type: "apiKey", in: "header", name: "Authorization" });
  });
});
