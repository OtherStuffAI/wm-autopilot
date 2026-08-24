import { afterEach, describe, expect, test } from "bun:test";

import {
  AccessActions,
  clearAccessRules,
  evaluateAccess,
  registerAccessRule,
  requireAuthentication,
} from "./access-control";
import type { RequestAuthContext } from "./request-context";

const makeAuth = (overrides?: Partial<RequestAuthContext>): RequestAuthContext => ({
  npub: null,
  actorNpub: null,
  session: null,
  ...overrides,
});

const makeContext = (auth: RequestAuthContext) => ({
  request: new Request("http://localhost:3021/api/test"),
  url: new URL("http://localhost:3021/api/test"),
  auth,
});

describe("requireAuthentication", () => {
  afterEach(() => {
    clearAccessRules();
  });

  test("allows cookie-backed sessions by default", async () => {
    registerAccessRule(AccessActions.SessionsManage, requireAuthentication());
    const decision = await evaluateAccess(
      AccessActions.SessionsManage,
      makeContext(makeAuth({ npub: "npub1user", session: { npub: "npub1user" } as any })),
    );
    expect(decision.allowed).toBe(true);
  });

  test("denies NIP-98 auth unless allowNip98 is enabled", async () => {
    registerAccessRule(AccessActions.SessionsManage, requireAuthentication());
    const decision = await evaluateAccess(
      AccessActions.SessionsManage,
      makeContext(makeAuth({ npub: "npub1user", authMethod: "nip98" })),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(401);
  });

  test("allows verified NIP-98 auth when allowNip98 is enabled", async () => {
    registerAccessRule(AccessActions.SessionsManage, requireAuthentication({ allowNip98: true }));
    const decision = await evaluateAccess(
      AccessActions.SessionsManage,
      makeContext(makeAuth({ npub: "npub1user", actorNpub: "npub1bot", authMethod: "nip98", delegatedByBot: true })),
    );
    expect(decision.allowed).toBe(true);
  });
});
