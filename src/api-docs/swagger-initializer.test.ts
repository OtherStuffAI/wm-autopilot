import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, type EventTemplate } from "nostr-tools";
import { Nip98ReplayCache, verifyNip98Request } from "../auth/nip98-verifier";
import { createOpenApiSpec } from "./openapi";
import { handleApiDocs } from "./routes";

const bundleSource = await Bun.file(fileURLToPath(import.meta.resolve("swagger-ui-dist/swagger-ui-bundle.js"))).text();
const initializerSource = await Bun.file(new URL("./swagger-initializer.js", import.meta.url)).text();
const origin = "https://autopilot.example";

// Run the shipped initializer and pinned Swagger client together, without a DOM.
// Fetch emulates browser-relative URL resolution and records transmitted bytes.
async function loadSwagger(signEvent?: (event: EventTemplate) => Promise<unknown>) {
  const requests: Request[] = [];
  const fetchCredentials: Array<RequestCredentials | undefined> = [];
  const status = { textContent: "" };
  let onLoad: () => void = () => { throw new Error("Missing initializer load handler"); };
  const context = vm.createContext({
    console, URL, URLSearchParams, Request, Response, Headers, File, Blob,
    TextEncoder, AbortController, setTimeout, clearTimeout, crypto, btoa,
    history: { pushState: () => {} },
    fetch: async (url: string, init: RequestInit) => {
      const request = new Request(new URL(url, origin), init);
      requests.push(request.clone());
      fetchCredentials.push(init.credentials);
      return handleApiDocs(request, new URL(request.url)) ?? Response.json({ ok: true });
    },
    document: { baseURI: `${origin}/api/docs`, querySelector: () => status },
    window: {
      File, location: { origin, href: `${origin}/api/docs`, search: "" },
      nostr: signEvent ? { signEvent } : undefined,
      addEventListener: (_name: string, callback: () => void) => { onLoad = callback; },
    },
  });
  vm.runInContext(bundleSource, context);
  vm.runInContext(`
    globalThis.shapes = [];
    window.SwaggerUIBundle = config => {
      globalThis.config = config;
      const intercept = config.requestInterceptor;
      config.requestInterceptor = request => {
        shapes.push({ url: request.url, method: request.method, loadSpec: request.loadSpec });
        return intercept(request);
      };
      globalThis.ui = SwaggerUIBundle({ ...config, dom_id: null });
    };
  `, context);
  vm.runInContext(initializerSource, context);
  onLoad();
  const deadline = Date.now() + 3000;
  while (context.ui.specSelectors.loadingStatus() === "loading" && Date.now() < deadline) await Bun.sleep(5);
  expect(context.ui.specSelectors.loadingStatus()).not.toBe("loading");
  return {
    context, requests, fetchCredentials, status,
    intercept: context.config.requestInterceptor as (request: any) => Promise<any>,
    execute: (pathName: string, method: string, parameters = {}, requestBody?: unknown) => context.ui.fn.execute({
      spec: createOpenApiSpec(), pathName, method, parameters, requestBody,
      requestInterceptor: context.config.requestInterceptor,
    }),
  };
}

describe("Swagger request signing", () => {
  test("the real Swagger spec loader omits method and loads the public definition without a signer", async () => {
    const swagger = await loadSwagger();
    expect(swagger.context.shapes[0]).toEqual({ url: "/api/docs/openapi.json", method: undefined, loadSpec: true });
    expect(swagger.context.ui.specSelectors.specJson().get("openapi")).toBe("3.0.3");
    expect(swagger.requests).toHaveLength(1);
    expect(swagger.requests[0]!.method).toBe("GET");
    expect(swagger.requests[0]!.headers.has("authorization")).toBe(false);
  });

  test("only same-origin public docs reads bypass signing, including lowercase methods and HEAD", async () => {
    let signatures = 0;
    const swagger = await loadSwagger(async () => { signatures++; throw new Error("Unexpected signing"); });
    for (const path of ["/api/docs", "/api/docs/openapi.json", "/api/docs/swagger-ui-bundle.js", "/api/docs/swagger-ui.css", "/api/docs/swagger-initializer.js"]) {
      for (const method of [undefined, "get", "GET", "HEAD", "head"]) {
        const request = await swagger.intercept({ url: `${path}?v=1`, method, headers: {} });
        expect(request.headers.Authorization).toBeUndefined();
        expect(request.method).toBe(method?.toUpperCase() ?? "GET");
        const response = handleApiDocs(new Request(request.url, { method: request.method }), new URL(request.url));
        expect(response?.status).toBe(200);
      }
    }
    expect(signatures).toBe(0);
    await expect(swagger.intercept({ url: "https://other.example/api/docs/openapi.json", headers: {} })).rejects.toThrow("this Autopilot origin");
    expect(signatures).toBe(0);
  });

  test("Swagger-built protected operations and private docs require a signer", async () => {
    const swagger = await loadSwagger();
    await expect(swagger.execute("/api/pipelines/runs/{id}", "get", { id: "run" })).rejects.toThrow("NIP-07 browser signer");
    await expect(swagger.execute("/api/docs/file", "get", { path: "README.md" })).rejects.toThrow("NIP-07 browser signer");
    for (const [url, method] of [["/api/docs/tree", undefined], ["/api/docs/file", "GET"], ["/api/docs/unlisted.js", "GET"], ["/api/docs/openapi.json", "POST"]]) {
      await expect(swagger.intercept({ url, method, headers: {} })).rejects.toThrow("NIP-07 browser signer");
    }
    expect(swagger.requests).toHaveLength(1);
  });

  test("real Swagger serialization signs exact URL, method and UTF-8 body; identical retries are fresh", async () => {
    const secret = generateSecretKey();
    const events: ReturnType<typeof finalizeEvent>[] = [];
    const swagger = await loadSwagger(async event => {
      const signed = finalizeEvent(JSON.parse(JSON.stringify(event)), secret);
      events.push(signed);
      return signed;
    });
    const directory = mkdtempSync(join(tmpdir(), "swagger-signing-"));
    const replayCache = new Nip98ReplayCache(100, join(directory, "replay.db"));
    try {
      // Keep identical calls in the same timestamp second to prove replay safety.
      const now = Math.floor(Date.now() / 1000);
      vm.runInContext(`Date.now = () => ${now * 1000}`, swagger.context);
      for (let i = 0; i < 2; i++) {
        await swagger.execute("/api/pipelines/definitions/{id}/runs", "post", { id: "demo" }, { mode: "poll", input: { text: "世界 ☕" } });
      }
      // Generic catalog routes omit optional queries, so use the real HTTP client
      // for a private document URL with exact encoded query order.
      await swagger.context.ui.fn.fetch({ url: "/api/docs/file?path=a%20b%2F%E4%B8%96%E7%95%8C.md&raw=1", method: "get", requestInterceptor: swagger.intercept });
      expect(events).toHaveLength(3);
      expect(events[0]!.created_at).toBe(events[1]!.created_at);
      expect(events[0]!.id).not.toBe(events[1]!.id);
      expect(swagger.fetchCredentials.slice(1)).toEqual(["omit", "omit", "omit"]);
      const original = swagger.requests[1]!;
      for (const changed of [
        new Request(`${original.url}?changed=1`, { method: "POST", headers: original.headers, body: await original.clone().text() }),
        new Request(original.url, { method: "PUT", headers: original.headers, body: await original.clone().text() }),
        new Request(original.url, { method: "POST", headers: original.headers, body: '{"mode":"webhook"}' }),
      ]) {
        expect(await verifyNip98Request({ request: changed, requestUrl: new URL(changed.url), configuredBaseUrl: origin, replayCache, now })).toBeNull();
      }
      for (const request of swagger.requests.slice(1)) {
        expect(await verifyNip98Request({ request: request.clone(), requestUrl: new URL(request.url), configuredBaseUrl: origin, replayCache, now })).not.toBeNull();
        expect(await verifyNip98Request({ request: request.clone(), requestUrl: new URL(request.url), configuredBaseUrl: origin, replayCache, now })).toBeNull();
      }
      expect(events[0]!.tags).toContainEqual(["u", `${origin}/api/pipelines/definitions/demo/runs`]);
      expect(events[0]!.tags).toContainEqual(["method", "POST"]);
      expect(await swagger.requests[1]!.text()).toBe('{"mode":"poll","input":{"text":"世界 ☕"}}');
      expect(events[2]!.tags).toContainEqual(["u", `${origin}/api/docs/file?path=a%20b%2F%E4%B8%96%E7%95%8C.md&raw=1`]);
      expect(events[2]!.tags.some(tag => tag[0] === "payload")).toBe(false);
      expect(swagger.status.textContent).toBe("Signed request sent.");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("signer refusal and unserialized bodies stop protected requests", async () => {
    let signatures = 0;
    const swagger = await loadSwagger(async () => { signatures++; throw new Error("User denied signing"); });
    await expect(swagger.intercept({ url: "/api/items", method: "POST", headers: {}, body: {} })).rejects.toThrow("serialized text body");
    expect(signatures).toBe(0);
    await expect(swagger.execute("/api/pipelines/runs/{id}", "get", { id: "run" })).rejects.toThrow("User denied signing");
    expect(signatures).toBe(1);
    expect(swagger.status.textContent).toBe("Signer authorization failed.");
    expect(swagger.requests).toHaveLength(1);
  });
});
