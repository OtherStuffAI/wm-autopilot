import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { WORKSPACE_DELEGATION_KIND } from "../auth/delegation-payload";
import { WorkspaceDelegationStore } from "./workspace-delegation-store";

describe("WorkspaceDelegationStore active grants", () => {
  test("fails closed for expired, revoked, wrong-owner and wrong-scope grants", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-store-"));
    try {
      const store = new WorkspaceDelegationStore(join(dir, "delegations.db"));
      const now = Date.now();
      const create = (id: string, expiresAt: number | null) => store.createDelegation({
        id,
        payload: {
          kind: WORKSPACE_DELEGATION_KIND,
          ownerNpub: "npub1admin",
          delegateNpub: "npub1agent",
          scopes: ["apps:operate"],
          billingMode: "owner",
          spendLimitSats: null,
          createdAt: now - 1000,
          expiresAt,
        },
        signedPayload: "signed",
        signature: "signature",
        createdBy: "npub1admin",
      });
      create("expired", now - 1);
      create("active", now + 60_000);
      expect(store.findActiveDelegation("npub1wrong", "npub1agent", "apps:operate")).toBeNull();
      expect(store.findActiveDelegation("npub1admin", "npub1agent", "apps:build")).toBeNull();
      expect(store.findActiveDelegation("npub1admin", "npub1agent", "apps:operate")?.id).toBe("active");
      store.revokeDelegation("active");
      expect(store.findActiveDelegation("npub1admin", "npub1agent", "apps:operate")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
