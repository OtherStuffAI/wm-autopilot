import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { handleAdminUsersApi, type AdminUsersApiContext } from "./admin-users-routes";

const makeNpub = () => nip19.npubEncode(getPublicKey(generateSecretKey()));

function createContext(): AdminUsersApiContext {
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

  return {
    adminNpub: makeNpub(),
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
      deleteUser: () => false,
      setNickname: (npub) => ({ normalizedNpub: normaliseNpub(npub) ?? npub }),
      addPortsToUser: (npub) => ({ normalizedNpub: normaliseNpub(npub) ?? npub, ports: [] }),
      touchExisting: () => undefined,
    },
    manager: { listSessions: () => [] },
    ensureApiAccess: async () => null,
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
    const ctx = createContext();
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
});
