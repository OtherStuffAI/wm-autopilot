import { describe, expect, spyOn, test } from "bun:test";
import { handleOwnerSpaceApi, type OwnerSpaceRoutesContext } from "./owner-space-routes";
import { handleAppsApi, type AppsApiContext } from "./apps-api-routes";
import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import type { AppRecord } from "../apps/app-registry";
import { DelegationScopes } from "../auth/delegation-access";

const existingSecret = "PRIVATE_EXISTING_VALUE";
const newSecret = "PRIVATE_NEW_VALUE";
const auth: RequestAuthContext = { npub: "npub1agent", signerNpub: "npub1agent", subjectNpub: "npub1agent", session: null };
const payload = {
  caproverName: "tower", caproverTarget: "secondary", expectedServerUrl: "https://captain.example.com",
  expectedDomain: "tower.example.com", envVars: [{ key: "FCM_JSON", value: newSecret }], unsetKeys: ["FCM_JSON_FILE"],
};
function fixture() {
  let env: unknown = [{ key: "DATABASE_URL", value: existingSecret }, { key: "FCM_JSON_FILE", value: "/old.json" }];
  let reads = 0;
  let allowed = true;
  let denied = false;
  let upstreamError = false;
  let remoteDomain = "tower.example.com";
  let scopes = [DelegationScopes.DeploymentsManage];
  let appIds = ["registered"];
  const writes: unknown[] = [];
  const actions: unknown[] = [];
  const app = { id: "registered", root: "/workspace/tower", ownerNpub: "npub1owner", webApp: true } as AppRecord;
  const ctx = {
    AccessActions,
    ensureApiAccess: async (action: unknown) => { actions.push(action); return denied ? Response.json({ error: "denied" }, { status: 403 }) : null; },
    canManageCore: false,
    canAccessApp: () => allowed,
    appRegistry: { getApp: async (id: string) => id === app.id ? app : undefined },
    caproverStore: { getAppByLocalAppId: () => ({ caproverName: "tower" }) },
    createCaproverTargetClientsFromEnv: () => [{ name: "secondary", serverUrl: payload.expectedServerUrl, client: {
      getApp: async () => { reads++; return { appName: "tower", envVars: env, customDomain: [{ publicDomain: remoteDomain }] }; },
      patchAppConfig: async (name: string, patch: { envVars: unknown }) => {
        if (upstreamError) throw new Error(`${existingSecret} ${newSecret}`);
        writes.push({ name, patch }); env = patch.envVars;
      },
    } }],
  } as unknown as AppsApiContext;
  const ownerCtx = {
    workspaceDelegationStore: { findActiveDelegation: (_owner: string, _delegate: string, scope?: string) => scope && !scopes.includes(scope as typeof scopes[number]) ? null : ({ id: "delegation", ownerNpub: "npub1owner", delegateNpub: "npub1agent", scopes, resourceFilters: { appIds } }) },
    resolveWorkspace: () => ({ defaultDirectory: "/workspace", allowedDirectories: ["/workspace"] }),
    buildAppsContext: (_auth: unknown, _scope: unknown, canAccessApp: (app: AppRecord) => boolean) => ({ ...ctx, canAccessApp: (record: AppRecord) => allowed && canAccessApp(record) }),
  } as unknown as OwnerSpaceRoutesContext;
  async function call(body: unknown = payload, owner = false, suffix = "", method: "PATCH" | "GET" = "PATCH") {
    const url = new URL(`https://autopilot.example/api/${owner ? "owners/npub1owner/" : ""}apps/registered/caprover/environment${suffix}`);
    const request = new Request(url, { method, headers: { "content-type": "application/json" }, ...(method === "PATCH" ? { body: JSON.stringify(body) } : {}) });
    return owner ? handleOwnerSpaceApi(request, url, method, auth, ownerCtx) : handleAppsApi(request, url, method, auth, ctx);
  }
  return { call, writes, actions, get reads() { return reads; }, setEnv: (value: unknown) => { env = value; },
    deny: () => { denied = true; }, disallow: () => { allowed = false; }, fail: () => { upstreamError = true; },
    wrongDomain: () => { remoteDomain = "other.example.com"; }, noScope: () => { scopes = []; }, wrongResource: () => { appIds = ["other"]; } };
}

describe("registered app protected environment merge", () => {
  test("owner-space preserves existing secrets, removes only explicit keys and sends only env config", async () => {
    const f = fixture();
    const response = (await f.call(payload, true))!;
    expect(response.status).toBe(200);
    expect(f.actions).toEqual([AccessActions.AppsManage]);
    expect(f.writes).toEqual([{ name: "tower", patch: { envVars: [
      { key: "DATABASE_URL", value: existingSecret }, { key: "FCM_JSON", value: newSecret },
    ] } }]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain(existingSecret);
    expect(text).not.toContain(newSecret);
    expect(text).not.toContain("envVars");
  });

  test("serializes simultaneous merges so both additions survive", async () => {
    const f = fixture();
    const responses = await Promise.all([f.call(), f.call({ ...payload, envVars: [{ key: "OTHER", value: "preserved" }], unsetKeys: [] })]);
    expect(responses.map((r) => r!.status)).toEqual([200, 200]);
    expect(f.writes[1]).toEqual({ name: "tower", patch: { envVars: [
      { key: "DATABASE_URL", value: existingSecret }, { key: "FCM_JSON", value: newSecret }, { key: "OTHER", value: "preserved" },
    ] } });
  });

  test("requires exact linked name, unique configured target, URL and live domain", async () => {
    for (const change of [{ caproverName: "other" }, { caproverTarget: "primary" }, { expectedServerUrl: "https://other.example.com" }, { expectedDomain: "other.example.com" }]) {
      const f = fixture();
      expect((await f.call({ ...payload, ...change }))!.status).toBe(409);
      expect(f.writes).toEqual([]);
    }
    const f = fixture(); f.wrongDomain();
    expect((await f.call())!.status).toBe(409);
    expect(f.writes).toEqual([]);
  });

  test("preserves ACL, delegated scope and registered-app resource filters", async () => {
    for (const deny of ["deny", "disallow", "noScope", "wrongResource"] as const) {
      const f = fixture(); f[deny]();
      expect([403, 404]).toContain((await f.call(payload, true))!.status);
      expect(f.reads).toBe(0);
      expect(f.writes).toEqual([]);
    }
  });

  test("rejects duplicates, invalid keys, ambiguous set/unset and extra config before upstream reads", async () => {
    for (const change of [
      { envVars: [{ key: "A", value: "1" }, { key: "A", value: "2" }] },
      { envVars: [{ key: "BAD-KEY", value: newSecret }] },
      { unsetKeys: ["FCM_JSON"] }, { unsetKeys: ["A", "A"] }, { instanceCount: 2 }, { caproverTarget: "all" },
    ]) {
      const f = fixture(); const response = (await f.call({ ...payload, ...change }))!;
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(newSecret);
      expect(f.reads).toBe(0);
    }
  });

  test("fails closed on missing or inconsistent upstream env without replacing it", async () => {
    for (const value of [undefined, null, [{ key: "A", value: "x" }, { key: "A", value: "y" }]]) {
      const f = fixture(); f.setEnv(value);
      expect((await f.call())!.status).toBe(502);
      expect(f.writes).toEqual([]);
    }
  });

  test("does not emit submitted or upstream secrets in errors or logs", async () => {
    const logs = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")];
    try {
      const success = fixture();
      expect((await success.call())!.status).toBe(200);
      const f = fixture(); f.fail();
      const response = (await f.call())!;
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain(existingSecret);
      expect(text).not.toContain(newSecret);
      expect(f.writes).toEqual([]);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { for (const log of logs) log.mockRestore(); }
  });
});
