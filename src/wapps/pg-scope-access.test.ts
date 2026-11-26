import { describe, expect, test } from "bun:test";
import { createPgWappScopeAccessResolver } from "./pg-scope-access-runtime";
import { pgScopeFixture, owner, actor, member, outsider } from "./__tests__/pg-scope-fixture";

const base = "/api/v4/flightdeck-pg/workspaces/workspace-1";
describe("typed PG WApp scope access", () => {
  test("retains delegated requester, signs exact routes and resolves nested group readers without board config", async () => {
    const f = pgScopeFixture();
    const result = await f.resolver.resolveWappScopeAccess(f.input);
    expect(result.allowedNpubs).toEqual([owner, member].sort());
    expect(result.allowedNpubs).not.toContain(outsider);
    expect(result.scopeLineage).toEqual({ scopeId: "scope-1", l1Id: null, l2Id: null, l3Id: null, l4Id: null, l5Id: null });
    expect(f.requests).toHaveLength(4);
    expect(f.signed).toHaveLength(4);
  });

  test("uses only authoritative nested lineage", async () => {
    const f = pgScopeFixture();
    Object.assign(f.scope, { scope_l1_id: "parent-1", scope_l2_id: "parent-2", scope_l3_id: "parent-3" });
    expect((await f.resolver.resolveWappScopeAccess(f.input)).scopeLineage).toMatchObject({ l1Id: "parent-1", l2Id: "parent-2", l3Id: "parent-3" });
  });

  for (const [name, mutate] of Object.entries({
    "wrong bound workspace": (f: ReturnType<typeof pgScopeFixture>) => { f.input.towerBinding!.workspaceId = "foreign"; },
    "wrong scope workspace": (f: ReturnType<typeof pgScopeFixture>) => { f.scope.workspace_id = "foreign"; },
    "missing owner identity": (f: ReturnType<typeof pgScopeFixture>) => { delete f.responses[`${base}/scopes`].identity.workspace_owner_npub; },
    "wrong app identity": (f: ReturnType<typeof pgScopeFixture>) => { f.identity.app_npub = "wrong-app"; },
    "wrong service identity": (f: ReturnType<typeof pgScopeFixture>) => { f.identity.tower_service_npub = "wrong-service"; },
    "missing permission inspection": (f: ReturnType<typeof pgScopeFixture>) => { f.responses[`${base}/scopes/scope-1/grants`].can_manage = false; },
    "missing grants": (f: ReturnType<typeof pgScopeFixture>) => { delete f.responses[`${base}/scopes/scope-1/grants`].grants; },
    "missing group": (f: ReturnType<typeof pgScopeFixture>) => { f.responses[`${base}/groups`].groups = []; },
    "wrong group workspace": (f: ReturnType<typeof pgScopeFixture>) => { f.responses[`${base}/groups`].groups[0].workspace_id = "foreign"; },
    "missing effective members": (f: ReturnType<typeof pgScopeFixture>) => { delete f.responses[`${base}/groups`].groups[0].effective_members; },
    "mismatching typed member": (f: ReturnType<typeof pgScopeFixture>) => { f.responses[`${base}/groups`].groups[0].effective_members[0].id = "wrong-actor"; },
    "mismatching member list": (f: ReturnType<typeof pgScopeFixture>) => { f.responses[`${base}/groups`].groups[0].effective_member_npubs = [outsider]; },
    "incomplete groups": (f: ReturnType<typeof pgScopeFixture>) => { f.responses[`${base}/groups`].next_cursor = "next"; },
    "permission denied": (f: ReturnType<typeof pgScopeFixture>) => { f.responses[`${base}/groups`] = Response.json({ error: "permission_denied" }, { status: 403 }); },
  })) test(`fails closed: ${name}`, async () => {
    const f = pgScopeFixture();
    mutate(f);
    await expect(f.resolver.resolveWappScopeAccess(f.input)).rejects.toThrow();
  });

  test("requires an authorized unambiguous connection and never tries another origin", async () => {
    const f = pgScopeFixture();
    f.input.towerBinding!.towerUrl = "https://unapproved.example";
    await expect(f.resolver.resolveWappScopeAccess(f.input)).rejects.toThrow("Exactly one authorized backend");
    expect(f.requests).toEqual([]);
  });

  test("resolves direct read grants against typed workspace principals", async () => {
    const f = pgScopeFixture();
    f.responses[`${base}/scopes/scope-1/grants`].grants = [{ principal_type: "actor", principal_id: "actor-1", npub: member, permissions: ["scope.read"] }];
    expect((await f.resolver.resolveWappScopeAccess(f.input)).allowedNpubs).toEqual([owner, member].sort());
    expect(f.requests).not.toContain(`${base}/groups`);
  });

  test("human owner retains identity and gets an explicit downstream capability error without key fallback", async () => {
    const f = pgScopeFixture();
    const resolver = createPgWappScopeAccessResolver({ connections: { listAvailableForManagerNpub: () => [f.connection] },
      agents: { getByBotNpub: () => { throw new Error("must not select an agent for the owner"); } },
      identity: { instanceIdentity: null, botKeyStore: { getActiveKeyForBotNpub: () => { throw new Error("must not export keys"); } },
        brokerKeyVault: { withKey: async () => { throw new Error("must not use another signer"); } } },
    });
    await expect(resolver.resolveWappScopeAccess({ ...f.input, actorNpub: owner })).rejects.toThrow("explicit downstream PG signing capability");
  });
});

test("runtime uses only the enabled requesting owner-managed profile in broker custody", async () => {
  const f = pgScopeFixture();
  const events: string[] = [];
  const profile = { botNpub: actor, managedByNpub: owner, enabled: true } as any;
  const key = { id: "key", userNpub: owner, botNpub: actor, botPubkeyHex: "public" } as any;
  const resolver = createPgWappScopeAccessResolver({
    connections: { listAvailableForManagerNpub: () => [f.connection] },
    agents: { getByBotNpub: npub => { expect(npub).toBe(actor); return profile; } },
    identity: { instanceIdentity: null, botKeyStore: { getActiveKeyForBotNpub: npub => { expect(npub).toBe(actor); return key; } },
      brokerKeyVault: { withKey: async (selected, operation) => {
        expect(selected).toBe(key); events.push("custody");
        try { return await operation(new Uint8Array(32).fill(7)); } finally { events.push("released"); }
      } } },
    createClient: (_connection, identity) => {
      expect(events).toEqual(["custody"]);
      expect(identity.botNpub).toBe(actor);
      return {
        listWorkspaces: async () => f.responses["/api/v4/flightdeck-pg/workspaces"],
        showWorkspace: async () => f.responses[`${base}/descriptor`],
        listScopes: async () => f.responses[`${base}/scopes`],
        scopeGrants: async () => f.responses[`${base}/scopes/scope-1/grants`],
        listGroups: async () => f.responses[`${base}/groups`],
      };
    },
  });
  expect((await resolver.resolveWappScopeAccess(f.input)).allowedNpubs).toContain(member);
  expect(events).toEqual(["custody", "released"]);
  profile.managedByNpub = outsider;
  await expect(resolver.resolveWappScopeAccess(f.input)).rejects.toThrow("owner-managed signing profile");
  profile.managedByNpub = owner;
  profile.enabled = false;
  await expect(resolver.resolveWappScopeAccess(f.input)).rejects.toThrow("owner-managed signing profile");
  expect(events).toHaveLength(2);
});

test("unbound registration discovers only an unambiguous owner workspace", async () => {
  const f = pgScopeFixture();
  f.input.towerBinding = null;
  expect((await f.resolver.resolveWappScopeAccess(f.input)).allowedNpubs).toContain(member);
  f.responses["/api/v4/flightdeck-pg/workspaces"].workspaces.push({ identity: { ...f.identity, workspace_id: "second" } });
  await expect(f.resolver.resolveWappScopeAccess(f.input)).rejects.toThrow("missing or ambiguous");
});

test("rejects workspace service identity drift across typed responses", async () => {
  const f = pgScopeFixture();
  f.responses[`${base}/scopes`].identity = { ...f.identity, workspace_service_npub: "other-service" };
  await expect(f.resolver.resolveWappScopeAccess(f.input)).rejects.toThrow("identity mismatch");
});

test("rejects a scope read grant whose direct principal npub disagrees with workspace membership", async () => {
  const f = pgScopeFixture();
  f.responses[`${base}/scopes/scope-1/grants`].grants = [{ principal_type: "actor", principal_id: "actor-1", npub: outsider, permissions: ["scope.read"] }];
  await expect(f.resolver.resolveWappScopeAccess(f.input)).rejects.toThrow("matching workspace member");
});
