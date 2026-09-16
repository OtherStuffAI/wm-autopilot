import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { handleAdminUsersApi, type AdminUsersApiContext } from "./admin-users-routes";

const makeNpub = () => nip19.npubEncode(getPublicKey(generateSecretKey()));

type CreateContextOptions = {
  bootstrapAdminNpubs?: string[];
  enforceAdminAccess?: boolean;
};

function createContext(options: CreateContextOptions = {}): AdminUsersApiContext {
  const users = new Map<string, {
    npub: string;
    normalizedNpub: string;
    alias: string;
    nickname: string | null;
    pictureUrl: string | null;
    roles: string[];
    onboardedAt: string | null;
    lastSeenAt: string | null;
    updatedAt: string | null;
    ports: number[];
  }>();

  const listUsers = () => Array.from(users.values());
  const bootstrapAdminNpubs = options.bootstrapAdminNpubs ?? [makeNpub()];
  const isAdminNpub = (npub: string | null | undefined) => {
    const normalized = normaliseNpub(npub ?? null);
    if (!normalized) return false;
    if (bootstrapAdminNpubs.includes(normalized)) return true;
    return Boolean(users.get(normalized)?.roles.includes("admin"));
  };

  return {
    adminNpub: bootstrapAdminNpubs[0] ?? null,
    bootstrapAdminNpubs,
    isAdminNpub,
    config: { connectRelays: [] },
    identityUserStore: {
      listUsers,
      setRole: (npub, role, value) => {
        const normalizedNpub = normaliseNpub(npub);
        if (!normalizedNpub) throw new Error("Invalid npub");
        const existing = users.get(normalizedNpub);
        const roles = new Set(existing?.roles ?? []);
        if (value) roles.add(role);
        else roles.delete(role);
        users.set(normalizedNpub, {
          npub,
          normalizedNpub,
          alias: existing?.alias ?? npub,
          nickname: existing?.nickname ?? null,
          pictureUrl: existing?.pictureUrl ?? null,
          roles: Array.from(roles).sort(),
          onboardedAt: existing?.onboardedAt ?? null,
          lastSeenAt: existing?.lastSeenAt ?? null,
          updatedAt: new Date(0).toISOString(),
          ports: existing?.ports ?? [],
        });
      },
      deleteUser: (npub) => {
        const normalized = normaliseNpub(npub);
        return normalized ? users.delete(normalized) : false;
      },
      setNickname: (npub) => ({ normalizedNpub: normaliseNpub(npub) ?? npub }),
      addPortsToUser: (npub) => ({ normalizedNpub: normaliseNpub(npub) ?? npub, ports: [] }),
      touchExisting: () => undefined,
    },
    manager: { listSessions: () => [] },
    ensureApiAccess: async (_action, _request, _url, requestAuthContext) =>
      options.enforceAdminAccess && !isAdminNpub(requestAuthContext.npub)
        ? Response.json({ error: "admin-only" }, { status: 403 })
        : null,
    AccessActions: { AdminUsers: AccessActions.AdminUsers },
    normaliseOptionalString: (value) => typeof value === "string" && value.trim() ? value.trim() : null,
    stopSessionsForUser: async () => undefined,
    resolveAndCacheNostrProfile: async () => undefined,
    buildIdentitySummaries: () => [],
  };
}

const authContext: RequestAuthContext = {
  npub: makeNpub(),
  actorNpub: null,
  session: null,
};

describe("admin users routes", () => {
  test("POST /api/admin/users adds an approved npub without legacy credit metadata", async () => {
    const ctx = createContext({ bootstrapAdminNpubs: [] });
    const npub = makeNpub();
    const request = new Request("http://localhost/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ npub }),
    });

    const response = await handleAdminUsersApi(
      request,
      new URL(request.url),
      "POST",
      authContext,
      ctx,
    );

    expect(response?.status).toBe(201);
    const body = await response!.json() as { user: Record<string, unknown>; users: Array<Record<string, unknown>> };
    expect(body.user.npub).toBe(npub);
    expect(body.user.approved).toBe(true);
    expect(body.user).not.toHaveProperty("balance");
    expect(body.users).toHaveLength(1);
  });

  test("GET /api/admin/users exposes multiple stored admin users", async () => {
    const ctx = createContext({ bootstrapAdminNpubs: [] });
    const firstAdmin = makeNpub();
    const secondAdmin = makeNpub();
    ctx.identityUserStore.setRole(firstAdmin, "admin", true);
    ctx.identityUserStore.setRole(secondAdmin, "admin", true);

    const request = new Request("http://localhost/api/admin/users");
    const response = await handleAdminUsersApi(request, new URL(request.url), "GET", authContext, ctx);

    expect(response?.status).toBe(200);
    const body = await response!.json() as { users: Array<Record<string, unknown>> };
    const admins = body.users.filter((user) => user.admin === true);
    expect(admins.map((user) => user.npub).sort()).toEqual([firstAdmin, secondAdmin].sort());
  });

  test("GET /api/admin/users seeds and preserves bootstrap admins", async () => {
    const bootstrapAdmin = makeNpub();
    const ctx = createContext({ bootstrapAdminNpubs: [bootstrapAdmin] });

    const request = new Request("http://localhost/api/admin/users");
    const response = await handleAdminUsersApi(request, new URL(request.url), "GET", authContext, ctx);

    expect(response?.status).toBe(200);
    let body = await response!.json() as { users: Array<Record<string, unknown>> };
    const seeded = body.users.find((user) => user.npub === bootstrapAdmin);
    expect(seeded?.admin).toBe(true);
    expect(seeded?.bootstrapAdmin).toBe(true);
    expect(seeded?.roles).toContain("admin");

    const demoteRequest = new Request("http://localhost/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ npub: bootstrapAdmin, admin: false }),
    });
    const demoteResponse = await handleAdminUsersApi(demoteRequest, new URL(demoteRequest.url), "PATCH", authContext, ctx);
    expect(demoteResponse?.status).toBe(400);

    const reread = new Request("http://localhost/api/admin/users");
    body = await (await handleAdminUsersApi(reread, new URL(reread.url), "GET", authContext, ctx))!.json();
    expect(body.users.find((user) => user.npub === bootstrapAdmin)?.admin).toBe(true);
  });

  test("PATCH /api/admin/users can promote and demote stored admins", async () => {
    const bootstrapAdmin = makeNpub();
    const ctx = createContext({ bootstrapAdminNpubs: [bootstrapAdmin] });
    const target = makeNpub();

    const promoteRequest = new Request("http://localhost/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ npub: target, admin: true }),
    });
    let response = await handleAdminUsersApi(promoteRequest, new URL(promoteRequest.url), "PATCH", authContext, ctx);
    expect(response?.status).toBe(200);
    let body = await response!.json() as { user: Record<string, unknown> };
    expect(body.user.admin).toBe(true);
    expect(body.user.approved).toBe(false);

    const demoteRequest = new Request("http://localhost/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ npub: target, admin: false }),
    });
    response = await handleAdminUsersApi(demoteRequest, new URL(demoteRequest.url), "PATCH", authContext, ctx);
    expect(response?.status).toBe(200);
    body = await response!.json() as { user: Record<string, unknown> };
    expect(body.user.admin).toBe(false);
  });

  test("PATCH and DELETE cannot remove the last effective admin", async () => {
    const ctx = createContext({ bootstrapAdminNpubs: [] });
    const onlyAdmin = makeNpub();
    ctx.identityUserStore.setRole(onlyAdmin, "admin", true);

    const demoteRequest = new Request("http://localhost/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ npub: onlyAdmin, admin: false, confirmSelfAdminDemotion: true }),
    });
    let response = await handleAdminUsersApi(demoteRequest, new URL(demoteRequest.url), "PATCH", { ...authContext, npub: onlyAdmin }, ctx);
    expect(response?.status).toBe(400);
    expect((await response!.json()).error).toBe("Cannot demote the last admin");

    const deleteRequest = new Request("http://localhost/api/admin/users", {
      method: "DELETE",
      body: JSON.stringify({ npub: onlyAdmin }),
    });
    response = await handleAdminUsersApi(deleteRequest, new URL(deleteRequest.url), "DELETE", authContext, ctx);
    expect(response?.status).toBe(400);
    expect((await response!.json()).error).toBe("Cannot delete the last admin");
  });

  test("DELETE /api/admin/users requires explicit confirmation for self admin deletion", async () => {
    const bootstrapAdmin = makeNpub();
    const selfAdmin = makeNpub();
    const ctx = createContext({ bootstrapAdminNpubs: [bootstrapAdmin] });
    ctx.identityUserStore.setRole(selfAdmin, "admin", true);

    const deleteRequest = new Request("http://localhost/api/admin/users", {
      method: "DELETE",
      body: JSON.stringify({ npub: selfAdmin }),
    });
    let response = await handleAdminUsersApi(
      deleteRequest,
      new URL(deleteRequest.url),
      "DELETE",
      { ...authContext, npub: selfAdmin },
      ctx,
    );
    expect(response?.status).toBe(409);
    expect((await response!.json()).requiresConfirmation).toBe("self-admin-deletion");

    const confirmedDeleteRequest = new Request("http://localhost/api/admin/users", {
      method: "DELETE",
      body: JSON.stringify({ npub: selfAdmin, confirmSelfAdminDeletion: true }),
    });
    response = await handleAdminUsersApi(
      confirmedDeleteRequest,
      new URL(confirmedDeleteRequest.url),
      "DELETE",
      { ...authContext, npub: selfAdmin },
      ctx,
    );
    expect(response?.status).toBe(200);
  });

  test("admin-only access follows a promoted admin role dynamically", async () => {
    const bootstrapAdmin = makeNpub();
    const promotedAdmin = makeNpub();
    const ctx = createContext({ bootstrapAdminNpubs: [bootstrapAdmin], enforceAdminAccess: true });

    const promoteRequest = new Request("http://localhost/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ npub: promotedAdmin, admin: true }),
    });
    const promoteResponse = await handleAdminUsersApi(
      promoteRequest,
      new URL(promoteRequest.url),
      "PATCH",
      { ...authContext, npub: bootstrapAdmin },
      ctx,
    );
    expect(promoteResponse?.status).toBe(200);

    const listRequest = new Request("http://localhost/api/admin/users");
    const listResponse = await handleAdminUsersApi(
      listRequest,
      new URL(listRequest.url),
      "GET",
      { ...authContext, npub: promotedAdmin },
      ctx,
    );
    expect(listResponse?.status).toBe(200);
  });
});
