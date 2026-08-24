import { describe, expect, test } from "bun:test";

import { getEffectiveOwnerAuthContext, getEffectiveOwnerNpub } from "./effective-owner";
import type { RequestAuthContext } from "./request-context";

const makeAuth = (overrides?: Partial<RequestAuthContext>): RequestAuthContext => ({
  npub: "npub1owner",
  actorNpub: "npub1owner",
  signerNpub: "npub1owner",
  subjectNpub: "npub1owner",
  targetOwnerNpub: "npub1owner",
  delegatedOwnerNpub: null,
  delegateRelationshipId: null,
  delegateScopes: null,
  session: null,
  authMethod: "session",
  delegatedByBot: false,
  ...overrides,
});

describe("effective owner helpers", () => {
  test("prefers delegated owner for delegated bot auth", () => {
    const auth = makeAuth({
      npub: "npub1bot",
      actorNpub: "npub1bot",
      signerNpub: "npub1bot",
      subjectNpub: "npub1bot",
      targetOwnerNpub: "npub1bot",
      delegatedOwnerNpub: "npub1owner",
      authMethod: "nip98",
      delegatedByBot: true,
    });

    expect(getEffectiveOwnerNpub(auth)).toBe("npub1owner");
  });

  test("returns an owner-scoped auth context for delegated bot requests", () => {
    const auth = makeAuth({
      npub: "npub1bot",
      actorNpub: "npub1bot",
      signerNpub: "npub1bot",
      subjectNpub: "npub1bot",
      targetOwnerNpub: "npub1bot",
      delegatedOwnerNpub: "npub1owner",
      authMethod: "nip98",
      delegatedByBot: true,
    });

    expect(getEffectiveOwnerAuthContext(auth)).toMatchObject({
      npub: "npub1owner",
      targetOwnerNpub: "npub1owner",
      subjectNpub: "npub1bot",
    });
  });
});
