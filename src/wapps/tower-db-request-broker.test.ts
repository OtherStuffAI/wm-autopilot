import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { nip19, verifyEvent, type Event } from "nostr-tools";

import { handleWappTowerDbBrokerRoute } from "../server/wapp-tower-db-broker-route";
import { sha256Payload } from "./wapp-publishing-client";
import {
  WAPP_TOWER_DB_BROKER_PATH,
  WappTowerDbBrokerError,
  WappTowerDbRequestBroker,
} from "./tower-db-request-broker";
import { WappStore } from "./wapp-store";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function withBroker(
  fn: (input: {
    store: WappStore;
    broker: WappTowerDbRequestBroker;
    token: string;
    appNpub: string;
    calls: CapturedRequest[];
    setNow: (value: number) => void;
  }) => void | Promise<void>,
  options: { maxBodyBytes?: number; capabilityTtlMs?: number } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "wapp-tower-db-broker-"));
  const store = new WappStore(join(directory, "wapps.sqlite"));
  const calls: CapturedRequest[] = [];
  let now = Date.parse("2026-08-31T00:00:00.000Z");
  store.createTowerBinding({
    id: "tower-primary",
    label: "Tower",
    towerUrl: "https://tower.example",
    workspaceId: "workspace-1",
    workspaceOwnerNpub: "npub1workspaceowner",
  });
  const wapp = store.create({
    id: "installation-1",
    appId: "kindling-api",
    title: "Kindling API",
    ownerNpub: "npub1owner",
    createdByNpub: "npub1owner",
    workspaceOwnerNpub: "npub1workspaceowner",
    scopeId: "scope-1",
    allowedNpubs: ["npub1owner"],
    launchUrl: "https://kindling.example",
    towerBindingId: "tower-primary",
    appKeyMode: "generate",
  });
  const broker = new WappTowerDbRequestBroker({
    store,
    now: () => now,
    capabilityTtlMs: options.capabilityTtlMs ?? 60_000,
    maxBodyBytes: options.maxBodyBytes,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 207,
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: "must-not-be-proxied",
        },
      });
    },
  });
  const capability = broker.issue({ installationId: wapp.id, appId: wapp.appId });
  return Promise.resolve(fn({
    store,
    broker,
    token: capability.token,
    appNpub: wapp.appNpub!,
    calls,
    setNow: (value) => { now = value; },
  })).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function decodeAuthorization(init: RequestInit): Event {
  const headers = new Headers(init.headers);
  const authorization = headers.get("authorization") ?? "";
  expect(authorization).toStartWith("Nostr ");
  return JSON.parse(Buffer.from(authorization.slice("Nostr ".length), "base64").toString("utf8")) as Event;
}

describe("WappTowerDbRequestBroker", () => {
  test("allows only the required own-app DB method and path combinations", () => withBroker(async ({ broker, token, calls, appNpub }) => {
    const requests = [
      { method: "POST", path: "/provision", body: { app_slug: "kindling" } },
      { method: "GET", path: "/migrations" },
      { method: "POST", path: "/migrations", body: { migrations: [] } },
      { method: "POST", path: "/tables/companies/query", body: { where: { status: { eq: "queued" } } } },
      { method: "GET", path: "/tables/companies/rows?limit=25&offset=0&order_by=updated_at&order_dir=desc" },
      { method: "POST", path: "/tables/companies/rows", body: { id: "company_1", data: { name: "North HVAC" } } },
      { method: "GET", path: "/tables/companies/rows/company_1" },
      { method: "PATCH", path: "/tables/companies/rows/company_1", body: { set: { status: "complete" } } },
      { method: "DELETE", path: "/tables/companies/rows/company_1" },
    ];
    for (const request of requests) {
      const response = await broker.request(token, request);
      expect(response.status).toBe(207);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.has("authorization")).toBeFalse();
    }
    expect(calls).toHaveLength(requests.length);
    const expectedBase = `https://tower.example/api/v4/workspaces/npub1workspaceowner/apps/${encodeURIComponent(appNpub)}/db`;
    expect(calls.map((call) => call.url)).toEqual(requests.map((request) => `${expectedBase}${request.path}`));
    expect(calls.every((call) => call.init.redirect === "manual")).toBeTrue();
  }));

  test("signs and forwards the exact serialized JSON body through encrypted custody", () => withBroker(async ({ broker, token, calls, appNpub }) => {
    const body = { set: { name: "Café Ω", profile: { score: 0, active: false } }, unset: ["legacy"] };
    await broker.request(token, { method: "PATCH", path: "/tables/companies/rows/company_1", body });
    const call = calls[0]!;
    const serialized = JSON.stringify(body);
    expect(call.init.body).toBe(serialized);
    const event = decodeAuthorization(call.init);
    expect(verifyEvent(event)).toBeTrue();
    expect(event.tags).toContainEqual(["u", call.url]);
    expect(event.tags).toContainEqual(["method", "PATCH"]);
    expect(event.tags).toContainEqual(["payload", sha256Payload(serialized)]);
    const decoded = nip19.decode(appNpub);
    expect(decoded.type).toBe("npub");
    expect(event.pubkey).toBe(decoded.data);
  }));

  test("denies arbitrary origins, workspaces, app identities, non-DB paths, and invalid methods", () => withBroker(async ({ broker, token, calls }) => {
    const deniedPaths = [
      "https://evil.example/api/v4/workspaces/other/apps/other/db/migrations",
      "//evil.example/migrations",
      "/api/v4/workspaces/other/apps/other/db/migrations",
      "/descriptor",
      "/tables/companies/../migrations",
      "/tables/companies/rows?owner_npub=npub1other",
    ];
    for (const path of deniedPaths) {
      await expect(broker.request(token, { method: "GET", path })).rejects.toMatchObject({
        code: "db_path_not_allowed",
        status: 403,
      });
    }
    await expect(broker.request(token, { method: "PUT", path: "/migrations", body: {} })).rejects.toMatchObject({
      code: "db_method_not_allowed",
      status: 405,
    });
    await expect(broker.request(token, { method: "DELETE", path: "/migrations" })).rejects.toMatchObject({
      code: "db_method_not_allowed",
      status: 405,
    });
    expect(calls).toEqual([]);
  }));

  test("denies oversize bodies before signing or transport", () => withBroker(async ({ broker, token, calls }) => {
    await expect(broker.request(token, {
      method: "POST",
      path: "/tables/companies/rows",
      body: { value: "x".repeat(64) },
    })).rejects.toMatchObject({ code: "db_body_too_large", status: 413 });
    expect(calls).toEqual([]);
  }, { maxBodyBytes: 32 }));

  test("denies wrong, expired, revoked, and identity-drifted capabilities", () => withBroker(async ({ store, broker, token, setNow, calls }) => {
    await expect(broker.request("A".repeat(43), { method: "GET", path: "/migrations" })).rejects.toMatchObject({
      code: "capability_invalid",
      status: 401,
    });
    setNow(Date.parse("2026-08-31T00:00:02.000Z"));
    await expect(broker.request(token, { method: "GET", path: "/migrations" })).rejects.toMatchObject({ code: "capability_expired" });

    setNow(Date.parse("2026-08-31T00:00:00.000Z"));
    const revoked = broker.issue({ installationId: "installation-1", appId: "kindling-api" });
    broker.revokeToken(revoked.token);
    await expect(broker.request(revoked.token, { method: "GET", path: "/migrations" })).rejects.toMatchObject({ code: "capability_revoked" });

    const drifted = broker.issue({ installationId: "installation-1", appId: "kindling-api" });
    store.updateTowerBinding("tower-primary", { towerUrl: "https://tower-changed.example" });
    await expect(broker.request(drifted.token, { method: "GET", path: "/migrations" })).rejects.toMatchObject({ code: "wapp_identity_drift" });
    expect(calls).toEqual([]);
  }, { capabilityTtlMs: 1_000 }));

  test("renews the inactivity expiry only after an accepted request", () => withBroker(async ({ broker, token, setNow }) => {
    setNow(Date.parse("2026-08-31T00:00:00.500Z"));
    expect((await broker.request(token, { method: "GET", path: "/migrations" })).status).toBe(207);
    setNow(Date.parse("2026-08-31T00:00:01.200Z"));
    expect((await broker.request(token, { method: "GET", path: "/migrations" })).status).toBe(207);
    setNow(Date.parse("2026-08-31T00:00:02.201Z"));
    await expect(broker.request(token, { method: "GET", path: "/migrations" })).rejects.toMatchObject({
      code: "capability_expired",
    });
  }, { capabilityTtlMs: 1_000 }));

  test("route requires loopback, a bearer capability, and the minimal request shape", () => withBroker(async ({ broker, token, calls }) => {
    const makeRequest = (body: unknown, authorization = `Bearer ${token}`) => new Request(`http://127.0.0.1:3600${WAPP_TOWER_DB_BROKER_PATH}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const remoteRequest = makeRequest({ method: "GET", path: "/migrations" });
    const remote = await handleWappTowerDbBrokerRoute({
      request: remoteRequest,
      url: new URL(remoteRequest.url),
      method: "POST",
      isLoopback: false,
      broker,
    });
    expect(remote?.status).toBe(403);
    expect(await remote?.json()).toMatchObject({ error: "loopback_required" });

    const widenedRequest = makeRequest({ method: "GET", path: "/migrations", origin: "https://evil.example" });
    const widened = await handleWappTowerDbBrokerRoute({
      request: widenedRequest,
      url: new URL(widenedRequest.url),
      method: "POST",
      isLoopback: true,
      broker,
    });
    expect(widened?.status).toBe(400);
    expect(await widened?.json()).toMatchObject({ error: "broker_request_invalid" });

    const validRequest = makeRequest({ method: "GET", path: "/migrations" });
    const valid = await handleWappTowerDbBrokerRoute({
      request: validRequest,
      url: new URL(validRequest.url),
      method: "POST",
      isLoopback: true,
      broker,
    });
    expect(valid?.status).toBe(207);
    expect(calls).toHaveLength(1);
  }));

  test("does not issue a capability for a non-Tower WApp", () => {
    const directory = mkdtempSync(join(tmpdir(), "wapp-tower-db-local-"));
    try {
      const store = new WappStore(join(directory, "wapps.sqlite"));
      store.create({
        id: "local-installation",
        appId: "local-app",
        title: "Local",
        ownerNpub: "npub1owner",
        createdByNpub: "npub1owner",
        workspaceOwnerNpub: "npub1workspace",
        scopeId: "scope-1",
        allowedNpubs: ["npub1owner"],
        launchUrl: "http://localhost",
      });
      expect(() => new WappTowerDbRequestBroker({ store }).issue({
        installationId: "local-installation",
        appId: "local-app",
      })).toThrow(WappTowerDbBrokerError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
