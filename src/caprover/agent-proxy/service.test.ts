import { afterEach, expect, test } from "bun:test";
import { Nip98ReplayCache } from "../../auth/nip98-verifier";
import { createAgentCaproverHandler } from "./service";
import { fixture, signedRequest } from "./__tests__/fixture";
import { loadProxyConfig, validNpub, validOrigin } from "./config";
import { CaproverClientError } from "../caprover-client";

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
  const handle = createAgentCaproverHandler(data.config, cache, operationLog);
  async function call(path: string, method = "GET", body?: unknown) {
    return handle(signedRequest(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  return { ...data, handle, call };
}

test("target, list, detail, status, withheld logs and history return explicit safe DTOs", async () => {
  const { call } = setup();
  for (const path of ["/target", "/apps", "/apps/demo", "/apps/demo/status", "/apps/demo/logs", "/apps/demo/deployments"]) {
    const response = await call(path);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("PRIVATE_");
    expect(text).not.toContain("pushWebhookToken");
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(await (await call("/apps/demo/logs")).json()).toMatchObject({ logs: [], withheld: true, isAppBuilding: false });
  expect(await (await call("/apps/demo/deployments")).json()).toEqual({ deployments: [{ version: 1, timeStamp: "2026-09-28T09:00:00.000Z" }] });
  expect((await call("/apps/missing")).status).toBe(404);
});

test("create and image-only captain definitions use explicit client operations", async () => {
  const { call, client } = setup();
  expect((await call("/apps", "POST", { appName: "new-app", hasPersistentData: true })).status).toBe(201);
  expect(client.createApp).toHaveBeenCalledWith("new-app", true);
  expect((await call("/apps", "POST", { appName: "new-app" })).status).toBe(409);
  expect((await call("/apps/demo/deploy", "POST", { imageName: "registry.example:5000/team/app:release-1" })).status).toBe(200);
  expect(client.deployCaptainDefinition).toHaveBeenCalledWith("demo", { schemaVersion: 2, imageName: "registry.example:5000/team/app:release-1" });
  expect((await call("/apps/demo/deploy", "POST", { captainDefinition: { schemaVersion: 2, imageName: `team/app@sha256:${"a".repeat(64)}` } })).status).toBe(200);
  expect((await call("/apps/missing/deploy", "POST", { imageName: "demo:1" })).status).toBe(404);
});

test("bounded config uses PATCH without leaking or replacing omitted fields", async () => {
  const { call, client } = setup();
  expect((await call("/apps/demo/config", "PATCH", { instanceCount: 2 })).status).toBe(200);
  expect(client.patchAppConfig).toHaveBeenCalledWith("demo", { instanceCount: 2 });
  const config = { containerHttpPort: 8080, envVars: [{ key: "TOKEN", value: "PRIVATE_NEW_VALUE" }], volumes: [{ volumeName: "demo-data", containerPath: "/data" }], forceSsl: true };
  const response = await call("/apps/demo/config", "PATCH", config);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("PRIVATE_");
  expect(client.patchAppConfig).toHaveBeenCalledWith("demo", config);
});

test("domains and HTTPS perform one validated operation per request", async () => {
  const { call, client } = setup();
  for (const action of ["add", "remove", "enable-https"]) {
    expect((await call("/apps/demo/domains", "POST", { action, domain: "app.example.com" })).status).toBe(200);
  }
  expect(client.addCustomDomain).toHaveBeenCalledWith("demo", "app.example.com");
  expect(client.removeCustomDomain).toHaveBeenCalledWith("demo", "app.example.com");
  expect(client.enableSslOnDomain).toHaveBeenCalledWith("demo", "app.example.com");
  expect((await call("/apps/demo/https", "POST", {})).status).toBe(200);
  expect(client.enableSsl).toHaveBeenCalledWith("demo");
});

test("invalid field types, names, images, domains and unsafe config fail before mutations", async () => {
  const { call, client } = setup();
  for (const body of [{ appName: "../demo" }, { appName: "Demo" }, { appName: "demo", hasPersistentData: "true" }, { appName: "x", target: "secondary" }]) {
    expect((await call("/apps", "POST", body)).status).toBe(400);
  }
  for (const body of [{ imageName: "https://user:pass@registry/app" }, { imageName: "app; rm -rf /" }, { captainDefinition: { schemaVersion: 2, dockerfileLines: ["RUN anything"] } }, { imageName: "app:1", captainDefinition: { schemaVersion: 2, imageName: "app:2" } }]) {
    expect((await call("/apps/demo/deploy", "POST", body)).status).toBe(400);
  }
  for (const body of [{}, { instanceCount: "2" }, { instanceCount: 21 }, { containerHttpPort: 0 }, { envVars: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }, { volumes: [{ containerPath: "/data", hostPath: "/" }] }, { volumes: [{ containerPath: "/data", volumeName: "other-data" }] }, { volumes: [{ containerPath: "/../etc", volumeName: "demo-data" }] }, { ports: [{ hostPort: 22, containerPort: 22 }] }, { preDeployFunction: "anything" }]) {
    expect((await call("/apps/demo/config", "PATCH", body)).status).toBe(400);
  }
  for (const domain of ["*.example.com", "https://app.example.com", "localhost", "127.0.0.1", "a..example.com"]) {
    expect((await call("/apps/demo/domains", "POST", { action: "add", domain })).status).toBe(400);
  }
  expect(client.createApp).not.toHaveBeenCalled();
  expect(client.patchAppConfig).not.toHaveBeenCalled();
  expect(client.deployCaptainDefinition).not.toHaveBeenCalled();
  expect(client.addCustomDomain).not.toHaveBeenCalled();
});

test("size, JSON/media errors, upstream failures and inconsistent state are explicit and secret-safe", async () => {
  const { call, handle, client, apps } = setup();
  const huge = "x".repeat(128 * 1024 + 1);
  expect((await handle(signedRequest("/apps", { method: "POST", body: huge }))).status).toBe(413);
  expect((await handle(signedRequest("/apps", { method: "POST", body: "{" }))).status).toBe(400);
  expect((await handle(signedRequest("/apps", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }))).status).toBe(415);
  client.patchAppConfig.mockImplementation(async () => { throw new Error("PRIVATE_UPSTREAM_ERROR"); });
  const failure = await call("/apps/demo/config", "PATCH", { instanceCount: 2 });
  expect(failure.status).toBe(502);
  expect(await failure.text()).not.toContain("PRIVATE_");
  client.patchAppConfig.mockImplementation(async () => { throw new CaproverClientError("PRIVATE_UPSTREAM_BODY", 405); });
  const unsupported = await call("/apps/demo/config", "PATCH", { instanceCount: 2 });
  expect(unsupported.status).toBe(502);
  expect(await unsupported.json()).toEqual({ error: "Target does not support the required partial-config PATCH; no POST fallback was attempted" });
  apps[0]!.versions = undefined;
  apps[0]!.isAppBuilding = undefined;
  expect((await call("/apps/demo/deployments")).status).toBe(502);
  expect((await call("/apps/demo/status")).status).toBe(502);
  apps[0]!.hasPersistentData = false;
  expect((await call("/apps/demo/config", "PATCH", { volumes: [{ containerPath: "/data", volumeName: "demo-data" }] })).status).toBe(409);
});

test("environment configuration never guesses a signer or target and rejects unsafe URLs", () => {
  expect(loadProxyConfig({})).toEqual({ allowedNpub: null, publicOrigin: null, target: null });
  expect(validNpub("not-an-npub")).toBeNull();
  for (const url of ["http://public.example", "https://user:pass@proxy.example", "https://proxy.example/path", "https://proxy.example?x=1"]) expect(validOrigin(url)).toBeNull();
  expect(validOrigin("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  const env = { CAPROVER_AGENT_TARGET: "primary", CAPROVER_URL: "https://captain.example", CAPROVER_PASSWORD: "test-password" };
  expect(loadProxyConfig(env).target?.name).toBe("primary");
  expect(loadProxyConfig({ ...env, CAPROVER_AGENT_TARGET: "secondary" }).target).toBeNull();
  expect(loadProxyConfig({ ...env, CAPROVER_PASSWORD: "" }).target).toBeNull();
  expect(loadProxyConfig({ ...env, CAPROVER_URL: "https://captain.example/path" }).target).toBeNull();
});

test("operation logs contain only metadata and preserve uncertain upstream outcomes", async () => {
  const { call, client } = setup();
  expect((await call("/apps/demo/config", "PATCH", { envVars: [{ key: "TOKEN", value: "PRIVATE_OPERATION_BODY" }] })).status).toBe(200);
  let response = await call("/apps/demo/logs");
  let payload = await response.json();
  expect(payload.logs[0]).toMatchObject({ operation: "config", state: "completed" });
  expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
  client.deployCaptainDefinition.mockImplementation(async () => { throw new Error("PRIVATE_UPSTREAM_OUTPUT"); });
  expect((await call("/apps/demo/deploy", "POST", { imageName: "demo:1" })).status).toBe(502);
  response = await call("/apps/demo/logs");
  payload = await response.json();
  expect(payload.logs[0]).toMatchObject({ operation: "deploy", state: "outcome-unknown" });
  expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
});
