import { describe, expect, test } from "bun:test";

import { delegationAllowsApp, resolveOwnerAccess } from "./delegation-access";
import type { RequestAuthContext } from "./request-context";
import type { WorkspaceDelegationRecord } from "../storage/workspace-delegation-store";

const owner = "npub1admin";
const delegate = "npub1agent";

const auth: RequestAuthContext = {
  npub: delegate,
  actorNpub: delegate,
  signerNpub: delegate,
  subjectNpub: delegate,
  targetOwnerNpub: delegate,
  session: null,
  authMethod: "nip98",
};

function grant(overrides: Partial<WorkspaceDelegationRecord> = {}): WorkspaceDelegationRecord {
  return {
    id: "grant-1",
    ownerNpub: owner,
    delegateNpub: delegate,
    scopes: ["apps:operate"],
    resourceFilters: { appIds: ["app-1"] },
    billingMode: "owner",
    spendLimitSats: null,
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    signedPayload: "signed",
    signature: "signature",
    eventId: "event-1",
    createdBy: owner,
    ...overrides,
  };
}

describe("owner execution delegation", () => {
  test("requires an active exact-owner scope; owner association alone is ignored", () => {
    expect(resolveOwnerAccess(auth, owner, () => null, "apps:operate")).toBeNull();
    expect(resolveOwnerAccess(auth, "npub1wrong", () => null, "apps:operate")).toBeNull();
    expect(resolveOwnerAccess(auth, owner, (_owner, _delegate, scope) => scope === "apps:operate" ? grant() : null, "apps:build")).toBeNull();
    expect(resolveOwnerAccess(auth, owner, () => grant(), "apps:operate")?.delegation?.id).toBe("grant-1");
  });

  test("enforces app id and root filters", () => {
    expect(delegationAllowsApp(grant(), { id: "app-1", root: "/apps/one" })).toBeTrue();
    expect(delegationAllowsApp(grant(), { id: "app-2", root: "/apps/two" })).toBeFalse();
    const rootGrant = grant({ resourceFilters: { appRoots: ["/apps/allowed"] } });
    expect(delegationAllowsApp(rootGrant, { id: "app-2", root: "/apps/allowed/nested" })).toBeTrue();
    expect(delegationAllowsApp(rootGrant, { id: "app-2", root: "/apps/denied" })).toBeFalse();
  });
});
