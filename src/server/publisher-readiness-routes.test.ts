import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { WappStore } from "../wapps/wapp-store";
import { hasWappActivityAuthority } from "../auth/wapp-activity-authority";
import { handleWappsApi, type WappsApiContext } from "./wapps-api-routes";
import { handleOwnerSpaceApi, type OwnerSpaceRoutesContext } from "./owner-space-routes";
import type { RequestAuthContext } from "../auth/request-context";

const owner = "npub1owner";
const auth: RequestAuthContext = {
  npub: "npub1worker", actorNpub: "npub1worker", session: null,
  authMethod: "nip98", capabilitySessionId: "scheduled-session",
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "readiness-route-"));
  const store = new WappStore(join(dir, "wapps.sqlite"));
  for (const id of ["installation-1", "installation-2"]) store.create({
    id, appId: id, title: "Book", ownerNpub: owner, createdByNpub: owner,
    workspaceOwnerNpub: owner, scopeId: "scope-1", allowedNpubs: [owner],
    launchUrl: "https://book.example", registeredOpenOrigins: ["https://book.example"],
  });
  let managementChecks = 0;
  const ctx = {
    viewerNpub: owner, adminNpub: null, wappStore: store,
    AccessActions: { AppsManage: "apps:manage" },
    ensureApiAccess: async () => { managementChecks++; return Response.json({ error: "denied" }, { status: 403 }); },
    hasWappActivityAuthority: (requestAuth: RequestAuthContext, id: string) => hasWappActivityAuthority(
      requestAuth, id,
      () => ({ status: "running", origin: { type: "scheduler", id: "trigger-1" }, metadata: { wappActivityInstallationId: "installation-1" } }) as any,
      () => "installation-1",
    ),
  } as WappsApiContext;
  return { ctx, store, managementChecks: () => managementChecks, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function requestFor(id: string, prefix = "/api/wapps") {
  return new Request(`https://autopilot.example${prefix}/${id}/publisher-readiness?scope_id=scope-1&channel_id=channel-1&origin=https%3A%2F%2Fbook.example`);
}

test("scheduled authority can check only its installation and cannot widen management", async () => {
  const f = fixture();
  try {
    const request = requestFor("installation-1");
    const response = await handleWappsApi(request, new URL(request.url), "GET", auth, f.ctx);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ready: false, code: "publishing_configuration_missing" });
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(f.managementChecks()).toBe(0);
    const other = requestFor("installation-2");
    expect((await handleWappsApi(other, new URL(other.url), "GET", auth, f.ctx))?.status).toBe(403);
    expect((await handleWappsApi(request, new URL(request.url), "GET", { ...auth, capabilitySessionId: null }, f.ctx))?.status).toBe(403);
    const mutation = new Request(request.url, { method: "POST" });
    expect((await handleWappsApi(mutation, new URL(mutation.url), "POST", auth, f.ctx))?.status).toBe(403);
    expect(f.managementChecks()).toBe(3);
  } finally { f.cleanup(); }
});

test("readiness inherits owner delegation and installation filters", async () => {
  const f = fixture();
  try {
    const delegation = {
      id: "delegation-1", ownerNpub: owner, delegateNpub: auth.npub,
      scopes: ["wapps:read"], resourceFilters: { wappIds: ["installation-1"] },
      expiresAt: null, revokedAt: null,
    };
    const ctx = {
      workspaceDelegationStore: { findActiveDelegation: () => delegation },
      buildWappsContext: (ownerAuth: RequestAuthContext) => ({
        ...f.ctx, viewerNpub: ownerAuth.targetOwnerNpub, ensureApiAccess: async () => null,
      }),
      audit: () => {},
    } as unknown as OwnerSpaceRoutesContext;
    for (const [id, expected] of [["installation-1", 200], ["installation-2", 403]] as const) {
      const request = requestFor(id, `/api/owners/${owner}/wapps`);
      const response = await handleOwnerSpaceApi(request, new URL(request.url), "GET", { ...auth, capabilitySessionId: null }, ctx);
      expect(response?.status).toBe(expected);
    }
  } finally { f.cleanup(); }
});
