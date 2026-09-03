import { describe, expect, test } from "bun:test";

import { AccessActions } from "./access-control";
import { createTrustedExecutionRule, type ExecutionAuditEntry } from "./trusted-execution";
import type { RequestAuthContext } from "./request-context";

const admin = "npub1admin";
const secondAdmin = "npub1admin2";
const delegate = "npub1agent";

function auth(overrides: Partial<RequestAuthContext>): RequestAuthContext {
  return {
    npub: overrides.npub ?? delegate,
    actorNpub: overrides.actorNpub ?? overrides.npub ?? delegate,
    signerNpub: overrides.signerNpub ?? overrides.npub ?? delegate,
    subjectNpub: overrides.subjectNpub ?? overrides.npub ?? delegate,
    targetOwnerNpub: overrides.targetOwnerNpub ?? overrides.npub ?? delegate,
    delegatedOwnerNpub: overrides.delegatedOwnerNpub ?? null,
    delegateRelationshipId: overrides.delegateRelationshipId ?? null,
    delegateScopes: overrides.delegateScopes ?? null,
    delegateExecutionScope: overrides.delegateExecutionScope ?? null,
    authMethod: overrides.authMethod,
    capabilitySessionId: overrides.capabilitySessionId ?? null,
    session: overrides.session ?? null,
  };
}

describe("trusted execution authorization", () => {
  test.each([
    ["PATCH", "/api/sessions/session-self/metadata", "metadata update"],
    ["DELETE", "/api/sessions/session-self", "stop"],
  ])("allows capability-bound own-session %s %s", async (method, pathname) => {
    const rule = createTrustedExecutionRule({ kind: "sessions", isAdminNpub: () => false });
    const request = new Request(`http://localhost${pathname}`, { method });
    const decision = await rule({
      action: AccessActions.SessionsManage,
      request,
      url: new URL(request.url),
      auth: auth({ authMethod: "nip98", capabilitySessionId: "session-self" }),
    });
    expect(decision?.allowed).toBeTrue();
  });

  test.each([
    ["PATCH", "/api/sessions/session-other/metadata"],
    ["DELETE", "/api/sessions/session-other"],
  ])("denies capability-bound cross-session %s %s", async (method, pathname) => {
    const rule = createTrustedExecutionRule({ kind: "sessions", isAdminNpub: () => false });
    const request = new Request(`http://localhost${pathname}`, { method });
    const decision = await rule({
      action: AccessActions.SessionsManage,
      request,
      url: new URL(request.url),
      auth: auth({ authMethod: "nip98", capabilitySessionId: "session-self" }),
    });
    expect(decision?.allowed).toBeFalse();
    expect(decision?.reason).toBe("admin-or-execution-delegation-required");
  });

  test("does not widen self-session authority to other session mutations", async () => {
    const rule = createTrustedExecutionRule({ kind: "sessions", isAdminNpub: () => false });
    for (const [method, pathname] of [
      ["PATCH", "/api/sessions/session-self"],
      ["POST", "/api/sessions/session-self/messages"],
      ["DELETE", "/api/archive/session-self"],
    ]) {
      const request = new Request(`http://localhost${pathname}`, { method });
      const decision = await rule({
        action: AccessActions.SessionsManage,
        request,
        url: new URL(request.url),
        auth: auth({ authMethod: "nip98", capabilitySessionId: "session-self" }),
      });
      expect(decision?.allowed).toBeFalse();
    }
  });

  test("allows approved users to administer sessions on the shared instance", async () => {
    const rule = createTrustedExecutionRule({
      kind: "sessions",
      isAdminNpub: () => false,
      isApprovedNpub: (value) => value === "npub1approved",
    });
    for (const [method, pathname] of [
      ["POST", "/api/sessions"],
      ["POST", "/api/sessions/archived-session/resume-native"],
      ["DELETE", "/api/sessions/another-users-session"],
    ]) {
      const request = new Request(`http://localhost${pathname}`, { method });
      const decision = await rule({
        action: AccessActions.SessionsManage,
        request,
        url: new URL(request.url),
        auth: auth({ npub: "npub1approved" }),
      });
      expect(decision?.allowed).toBeTrue();
    }
  });

  test("allows every configured Admin but denies approved or owner-associated actors without a grant", async () => {
    const rule = createTrustedExecutionRule({ kind: "apps", isAdminNpub: (value) => value === admin || value === secondAdmin });
    const request = new Request("http://localhost/api/apps", { method: "POST" });
    const url = new URL(request.url);
    const decide = (requestAuth: RequestAuthContext) => rule({
      action: AccessActions.AppsManage,
      request,
      url,
      auth: requestAuth,
    });
    expect((await decide(auth({ npub: admin })))?.allowed).toBeTrue();
    expect((await decide(auth({ npub: secondAdmin })))?.allowed).toBeTrue();
    expect((await decide(auth({ npub: "npub1approved" })))?.allowed).toBeFalse();
    expect((await decide(auth({
      advisoryOwnerNpub: admin,
      delegatedOwnerNpub: admin,
      targetOwnerNpub: admin,
      delegatedByBot: true,
    })))?.allowed).toBeFalse();
  });

  test("requires an explicit Admin-owner delegation with the exact active route scope and audits identities", async () => {
    const audit: ExecutionAuditEntry[] = [];
    const rule = createTrustedExecutionRule({
      kind: "apps",
      isAdminNpub: (value) => value === admin,
      audit: (entry) => audit.push(entry),
      now: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    const request = new Request("http://localhost/api/owners/npub1admin/apps/app-1/actions", { method: "POST" });
    const url = new URL(request.url);
    const decide = (requestAuth: RequestAuthContext) => rule({
      action: AccessActions.AppsManage,
      request,
      url,
      auth: requestAuth,
    });
    const delegated = auth({
      targetOwnerNpub: admin,
      delegatedOwnerNpub: admin,
      delegateRelationshipId: "delegation-1",
      delegateScopes: ["apps:operate"],
      delegateExecutionScope: "apps:operate",
    });
    expect((await decide(delegated))?.allowed).toBeTrue();
    expect((await decide({ ...delegated, delegateExecutionScope: "apps:build" }))?.allowed).toBeFalse();
    expect((await decide({
      ...delegated,
      targetOwnerNpub: "npub1wrong",
      delegatedOwnerNpub: "npub1wrong",
    }))?.allowed).toBeFalse();
    expect(audit[0]).toMatchObject({
      actorNpub: delegate,
      ownerNpub: admin,
      delegationId: "delegation-1",
      scope: "apps:operate",
      outcome: "allowed",
      timestamp: "2026-08-04T00:00:00.000Z",
    });
  });
});
