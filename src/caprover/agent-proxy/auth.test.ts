import { afterEach, expect, test } from "bun:test";
import { generateSecretKey } from "nostr-tools";
import { Nip98ReplayCache } from "../../auth/nip98-verifier";
import { createAgentCaproverHandler } from "./service";
import { allowedNpub, base, fixture, signedRequest } from "./__tests__/fixture";

import { ProxyOperationLog } from "./operation-log";

const logs: ProxyOperationLog[] = [];
const caches: Nip98ReplayCache[] = [];
afterEach(() => { for (const cache of caches.splice(0)) cache.close(); for (const log of logs.splice(0)) log.close(); });
function setup() {
  const data = fixture();
  const cache = new Nip98ReplayCache(1000, ":memory:");
  caches.push(cache);
  const operationLog = new ProxyOperationLog(":memory:");
  logs.push(operationLog);
  return { ...data, cache, operationLog, handle: createAgentCaproverHandler(data.config, cache, operationLog) };
}

test("only the exact configured signer can authenticate; npub headers have no authority", async () => {
  const { handle, client, cache } = setup();
  expect((await handle(signedRequest("/apps", { signer: generateSecretKey(), headers: { "x-npub": allowedNpub } }))).status).toBe(401);
  expect((await handle(new Request(`${base}/apps`, { headers: { "x-npub": allowedNpub } }))).status).toBe(401);
  expect(cache.size).toBe(0);
  expect(client.getAllApps).not.toHaveBeenCalled();
  expect((await handle(signedRequest("/apps"))).status).toBe(200);
});

test("rejects invalid signature, kind, URL/query, method, timestamp and duplicate URL/method tags", async () => {
  const { handle, client } = setup();
  const now = Math.floor(Date.now() / 1000);
  for (const options of [
    { badSignature: true }, { kind: 1 }, { signedUrl: `${base}/target` },
    { signedUrl: `${base}/apps?target=secondary` }, { signedMethod: "POST" },
    { createdAt: now - 61 }, { createdAt: now + 16 },
    { extraTags: [["u", `${base}/apps`]] }, { extraTags: [["method", "GET"]] },
  ]) expect((await handle(signedRequest("/apps", options))).status).toBe(401);
  expect((await handle(signedRequest("/apps?target=primary", { signedUrl: `${base}/apps?target=secondary` }))).status).toBe(401);
  expect(client.getAllApps).not.toHaveBeenCalled();
});

test("requires a single correct digest over exact body bytes", async () => {
  const { handle, client } = setup();
  const body = JSON.stringify({ appName: "new-app" });
  for (const options of [
    { payloadTags: [] }, { payloadTags: [["payload", "0".repeat(64)]] },
    { payloadTags: [["payload", "bad"], ["payload", "bad"]] },
    { signedBody: body + " " },
  ]) expect((await handle(signedRequest("/apps", { method: "POST", body, ...options }))).status).toBe(401);
  expect(client.createApp).not.toHaveBeenCalled();
  expect((await handle(signedRequest("/apps", { method: "POST", body }))).status).toBe(201);
  expect((await handle(signedRequest("/apps", { payloadTags: [["payload", "0".repeat(64)]] }))).status).toBe(401);
});

test("replay denied including across service instances sharing the durable cache", async () => {
  const { handle, cache, config, operationLog } = setup();
  const request = signedRequest("/apps");
  const copy = request.clone();
  expect((await handle(request)).status).toBe(200);
  expect((await createAgentCaproverHandler(config, cache, operationLog)(copy)).status).toBe(401);
});

test("forwarded host/proto headers cannot change the configured external origin", async () => {
  const { handle } = setup();
  const request = signedRequest("/apps", { headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http", forwarded: "host=attacker.example;proto=http" } });
  expect((await handle(new Request("http://127.0.0.1:9999/api/agent/caprover/apps", { headers: request.headers }))).status).toBe(200);
  expect((await handle(signedRequest("/apps", { signedUrl: "https://attacker.example/api/agent/caprover/apps", headers: { "x-forwarded-host": "attacker.example" } }))).status).toBe(401);
});

test("missing signer, origin or target fails closed, health reveals only readiness", async () => {
  const { config, cache, client, operationLog } = setup();
  const health = await createAgentCaproverHandler(config, cache, operationLog)(new Request("http://localhost/health"));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ service: "caprover-agent-proxy", ready: true });
  for (const missing of [{ allowedNpub: null }, { target: null }, { publicOrigin: null }]) {
    const handle = createAgentCaproverHandler({ ...config, ...missing }, cache, operationLog);
    expect((await handle(signedRequest("/apps"))).status).toBe(503);
    expect((await handle(new Request("http://localhost/health"))).status).toBe(503);
  }
  expect(client.getAllApps).not.toHaveBeenCalled();
});

test("DELETE, untrack, raw routes and arbitrary operations cannot reach the client", async () => {
  const { handle, client } = setup();
  for (const [path, method, status] of [
    ["/apps/demo", "DELETE", 405], ["/apps/demo", "PUT", 405],
    ["/apps/demo/untrack", "POST", 404], ["/apps/demo/delete", "POST", 404],
    ["/apps/demo/exec", "POST", 404], ["/raw", "POST", 404],
  ]) expect((await handle(signedRequest(path!, { method }))).status).toBe(status);
  expect((await handle(signedRequest("/apps?target=secondary"))).status).toBe(400);
  expect(client.getApp).not.toHaveBeenCalled();
});
