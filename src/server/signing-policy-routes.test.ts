import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RequestAuthContext } from "../auth/request-context";
import { buildDefaultAgentCapabilityPolicy, type ActiveSessionCapability, type IssuedSessionCapability } from "../signing/capability-broker";
import { FileSigningPolicyStore, SigningPolicyRegistry } from "../signing/signing-policy-registry";
import { handleSigningPolicyApi, type SigningPolicyRoutesContext } from "./signing-policy-routes";

const roots: string[] = [];
const adminAuth = { npub: "npub1admin", session: { npub: "npub1admin" } } as RequestAuthContext;
const memberAuth = { npub: "npub1member", session: { npub: "npub1member" } } as RequestAuthContext;
const anonymousAuth = { npub: null, session: null } as RequestAuthContext;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wingman-signing-routes-"));
  roots.push(root);
  let reissues = 0;
  let inventoryReads = 0;
  const capabilities: ActiveSessionCapability[] = [];
  const registry = new SigningPolicyRegistry(new FileSigningPolicyStore(join(root, "policies.json")), {
    forgejoCompletionUrl: "https://tower.example/api/v4/git/oidc/authorize/complete",
  });
  const baseline = buildDefaultAgentCapabilityPolicy({ towerUrl: "https://tower.example", autopilotUrl: "https://autopilot.example" });
  const ctx: SigningPolicyRoutesContext = {
    registry,
    listCapabilities: () => { inventoryReads += 1; return capabilities; },
    buildBaselinePolicy: () => baseline,
    reissueSessionCapability: () => {
      reissues += 1;
      return {
        token: "must-not-leave-route",
        capabilityId: "cap-new",
        expiresAt: new Date().toISOString(),
        botNpub: "npub1bot",
        botPubkeyHex: "ab".repeat(32),
        policyRefs: [{ id: "builtin-default-agent", revision: 1 }],
      } satisfies IssuedSessionCapability;
    },
    ensureApiAccess: async (_action, _request, _url, auth) => {
      if (!auth.session) return Response.json({ error: "auth-required" }, { status: 401 });
      if (auth.npub !== adminAuth.npub) return Response.json({ error: "admin-only" }, { status: 403 });
      return null;
    },
    AccessActions: { SystemManage: "system:manage" },
  };
  const call = (path: string, method: "GET" | "POST" | "PUT", auth: RequestAuthContext, body?: unknown) => {
    const url = new URL(`http://localhost${path}`);
    const request = new Request(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return handleSigningPolicyApi(request, url, method, auth, ctx) as Promise<Response>;
  };
  return { call, registry, capabilities, get reissues() { return reissues; }, get inventoryReads() { return inventoryReads; } };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("signing policy admin routes", () => {
  test("denies unauthenticated and non-admin requests before policy or session data is read", async () => {
    const f = fixture();
    expect((await f.call("/api/admin/signing-policies", "GET", anonymousAuth)).status).toBe(401);
    expect((await f.call("/api/admin/signing-policies", "GET", memberAuth)).status).toBe(403);
    expect((await f.call("/api/admin/signing-policies/sessions/session-a/reissue", "POST", memberAuth, {})).status).toBe(403);
    expect(f.inventoryReads).toBe(0);
    expect(f.reissues).toBe(0);
  });

  test("allows an administrator to read policies and deliberately reissue without returning a bearer", async () => {
    const f = fixture();
    const list = await f.call("/api/admin/signing-policies", "GET", adminAuth);
    expect(list.status).toBe(200);
    expect((await list.json() as { policies: unknown[] }).policies.length).toBe(2);
    const reissue = await f.call("/api/admin/signing-policies/sessions/session-a/reissue", "POST", adminAuth, {});
    expect(reissue.status).toBe(200);
    const payload = await reissue.json();
    expect(JSON.stringify(payload)).not.toContain("must-not-leave-route");
    expect(f.reissues).toBe(1);
  });

  test("mutates revisions and reports newly affected active capabilities as stale", async () => {
    const f = fixture();
    const template = f.registry.get("tower-forgejo-login")!;
    const update = {
      id: template.id,
      name: template.name,
      description: template.description,
      enabled: true,
      operations: template.operations,
      eventKinds: template.eventKinds,
      nostrKindRules: template.nostrKindRules,
      nip98Targets: template.nip98Targets,
      assignments: { profileIds: ["profile-a"], workspaceIds: [] },
    };
    f.capabilities.push({
      capabilityId: "cap-old", sessionId: "session-a", ownerNpub: "npub1owner", botNpub: "npub1bot",
      profileId: "profile-a", workspaceId: null, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      policyRefs: [{ id: "builtin-default-agent", revision: 1 }],
    });
    const saved = await f.call("/api/admin/signing-policies/tower-forgejo-login", "PUT", adminAuth, update);
    expect(saved.status).toBe(200);
    expect((await saved.json() as { policy: { revision: number } }).policy.revision).toBe(2);
    const list = await f.call("/api/admin/signing-policies", "GET", adminAuth);
    const payload = await list.json() as { sessions: Array<{ policyState: string; currentPolicyRefs: Array<{ id: string; revision: number }> }> };
    expect(payload.sessions[0]).toMatchObject({
      policyState: "stale",
      currentPolicyRefs: expect.arrayContaining([{ id: "tower-forgejo-login", revision: 2 }]),
    });
    const history = await f.call("/api/admin/signing-policies/tower-forgejo-login/history", "GET", adminAuth);
    expect((await history.json() as { history: unknown[] }).history).toHaveLength(2);
  });
});
