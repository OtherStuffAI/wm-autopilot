import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey, nip19 } from "nostr-tools";
import type { AppRecord } from "../apps/app-registry";
import { pgScopeFixture } from "../wapps/__tests__/pg-scope-fixture";
import { WappStore } from "../wapps/wapp-store";
import { handleWappsApi, type WappsApiContext } from "./wapps-api-routes";

function fixture(title: string) {
  const pg = pgScopeFixture();
  const dir = mkdtempSync(join(tmpdir(), "wapp-pg-registration-"));
  const store = new WappStore(join(dir, "wapps.sqlite"));
  const binding = store.createTowerBinding({ ...pg.input.towerBinding! });
  const registrationSecret = new Uint8Array(32).fill(9);
  const registrationIdentity = { botSecret: registrationSecret, botPubkeyHex: getPublicKey(registrationSecret), botNpub: nip19.npubEncode(getPublicKey(registrationSecret)) };
  const registered: unknown[] = [];
  const ctx: WappsApiContext = {
    adminNpub: null, viewerNpub: pg.owner, actorNpub: pg.actor,
    sourceWingmanUrl: "https://autopilot.example", flightDeckAppNamespace: "autopilot",
    AccessActions: { AppsManage: "apps:manage" }, ensureApiAccess: async () => null,
    ensureDirectory: async root => root, canAccessApp: () => true,
    appRegistry: { listApps: async () => [], getApp: async () => ({ id: "app-1", root: dir, ownerNpub: pg.owner, webApp: true }) as AppRecord },
    appAliasRegistry: { getByAppId: async () => ({ alias: "test" }) }, wappStore: store,
    publisher: { publish: async () => { throw new Error("must not publish or activate"); } },
    scopeAccessResolver: pg.resolver, towerRegistrationIdentity: registrationIdentity,
    towerWappRegistrar: { register: async input => { registered.push(input);
      expect(input.authority).toBe(registrationIdentity);
      return { workspaceOwnerNpub: input.workspaceOwnerNpub, appNpub: input.appNpub, app: {} }; } },
    buildLaunchUrl: () => "https://app.example",
  };
  const body = { appId: "app-1", title, workspaceOwnerNpub: pg.owner, scopeId: "scope-1", towerBindingId: binding.id, allowedNpubs: [pg.actor] };
  async function call(method: "POST" | "PATCH", path: string, payload: unknown) {
    const request = new Request(`https://autopilot.example${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return (await handleWappsApi(request, new URL(request.url), method, { npub: pg.actor, actorNpub: pg.actor, delegatedOwnerNpub: pg.owner, session: null }, ctx))!;
  }
  return { ...pg, dir, ctx, body, call, registered, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const title of ["Army library", "Kindling"]) test(`registers ${title} through PG without board.json or owner impersonation`, async () => {
  const f = fixture(title);
  try {
    expect(existsSync(join(f.dir, "board.json"))).toBe(false);
    const response = await f.call("POST", "/api/wapps", f.body);
    expect(response.status).toBe(201);
    const { wapp } = await response.json();
    expect(wapp.allowedNpubs).toEqual([f.owner, f.member].sort());
    expect(wapp.createdByNpub).toBe(f.actor);
    expect(wapp.ownerNpub).toBe(f.owner);
    expect(wapp.towerBindingId).toBe(f.body.towerBindingId);
    expect(f.registered).toHaveLength(1);
    expect(wapp.appNsec).toBeUndefined();
    const refresh = await f.call("POST", `/api/wapps/${wapp.id}/refresh-allowlist`, {});
    expect(refresh.status).toBe(200);
    expect((await refresh.json()).wapp.allowedNpubs).toEqual(wapp.allowedNpubs);
  } finally { f.cleanup(); }
});

test("denies wrong-workspace registration before registration or persistence", async () => {
  const f = fixture("Denied");
  try {
    f.scope.workspace_id = "foreign";
    expect((await f.call("POST", "/api/wapps", f.body)).status).toBe(400);
    expect(f.registered).toEqual([]);
    expect(f.ctx.wappStore.list()).toEqual([]);
  } finally { f.cleanup(); }
});

test("binding-only updates refresh exact scope access and reject foreign workspace", async () => {
  const f = fixture("Update");
  try {
    const { wapp } = await (await f.call("POST", "/api/wapps", f.body)).json();
    const binding = f.ctx.wappStore.createTowerBinding({ label: "Foreign", towerUrl: "https://pg.example", workspaceOwnerNpub: f.owner, workspaceId: "foreign" });
    expect((await f.call("PATCH", `/api/wapps/${wapp.id}`, { towerBindingId: binding.id })).status).toBe(400);
    expect(f.ctx.wappStore.get(wapp.id)!.towerBindingId).toBe(f.body.towerBindingId);
    expect(f.registered).toHaveLength(1);
  } finally { f.cleanup(); }
});
