import { describe, expect, test } from "bun:test";

import { resolveNip98AuthContext } from "./nip98-auth";
import type { RequestAuthContext } from "./request-context";

const makeAuth = (overrides?: Partial<RequestAuthContext>): RequestAuthContext => ({
  npub: null,
  actorNpub: null,
  session: null,
  ...overrides,
});

describe("resolveNip98AuthContext", () => {
  const request = new Request("http://localhost:3021/api/apps", {
    headers: { authorization: "Nostr test" },
  });
  const url = new URL(request.url);

  test("keeps cookie-backed auth unchanged when no NIP-98 header is supplied", async () => {
    const auth = makeAuth({ npub: "npub1cookie", actorNpub: "npub1cookie", session: { npub: "npub1cookie" } as any });
    const cookieRequest = new Request(request.url);
    const resolved = await resolveNip98AuthContext(cookieRequest, url, auth, {
      verifyNip98AuthHeader: async () => ({ signerNpub: "npub1ignored" }),
      lookupBotOwnerNpub: () => "npub1owner",
    });
    expect(resolved).toBe(auth);
  });

  test("prefers valid NIP-98 proof over cookie-backed auth when both are supplied", async () => {
    const auth = makeAuth({ npub: "npub1cookie", actorNpub: "npub1cookie", session: { npub: "npub1cookie" } as any });
    const resolved = await resolveNip98AuthContext(request, url, auth, {
      verifyNip98AuthHeader: async () => ({ signerNpub: "npub1signed" }),
    });
    expect(resolved.npub).toBe("npub1signed");
    expect(resolved.actorNpub).toBe("npub1signed");
    expect(resolved.authMethod).toBe("nip98");
    expect(resolved.session).toBeNull();
  });

  test("uses signer npub directly for user-signed NIP-98", async () => {
    const resolved = await resolveNip98AuthContext(request, url, makeAuth(), {
      verifyNip98AuthHeader: async () => ({ signerNpub: "npub1user" }),
    });
    expect(resolved.npub).toBe("npub1user");
    expect(resolved.actorNpub).toBe("npub1user");
    expect(resolved.authMethod).toBe("nip98");
    expect(resolved.delegatedByBot).toBe(false);
  });

  test("preserves bot signer identity while surfacing legacy owner linkage", async () => {
    const resolved = await resolveNip98AuthContext(request, url, makeAuth(), {
      verifyNip98AuthHeader: async () => ({ signerNpub: "npub1bot", capabilitySessionId: "session-1" }),
      lookupBotOwnerNpub: (botNpub) => (botNpub === "npub1bot" ? "npub1owner" : null),
    });
    expect(resolved.npub).toBe("npub1bot");
    expect(resolved.actorNpub).toBe("npub1bot");
    expect(resolved.subjectNpub).toBe("npub1bot");
    expect(resolved.delegatedOwnerNpub).toBeNull();
    expect(resolved.advisoryOwnerNpub).toBe("npub1owner");
    expect(resolved.authMethod).toBe("nip98");
    expect(resolved.capabilitySessionId).toBe("session-1");
    expect(resolved.delegatedByBot).toBe(true);
  });
});

test("invalid explicit NIP-98 cannot fall back to an admin cookie", async () => {
  const request = new Request("https://example/api/admin/users", { headers: { authorization: "Nostr invalid" } });
  const resolved = await resolveNip98AuthContext(request, new URL(request.url), {
    npub: "npub1admin", actorNpub: "npub1admin", session: { npub: "npub1admin" } as any,
  }, { verifyNip98AuthHeader: async () => null });
  expect(resolved.npub).toBeNull();
  expect(resolved.session).toBeNull();
});

test("live admin bot keeps advisory custody separate from its effective owner", async () => {
  const request = new Request("https://example/api/scheduler/jobs", { headers: { authorization: "Nostr proof" } });
  const resolved = await resolveNip98AuthContext(request, new URL(request.url), { npub: null, session: null }, {
    verifyNip98AuthHeader: async () => ({ signerNpub: "npub1bot" }), lookupBotOwnerNpub: () => "npub1custodian",
  });
  expect(resolved.subjectNpub).toBe("npub1bot");
  expect(resolved.targetOwnerNpub).toBe("npub1bot");
  expect(resolved.delegatedOwnerNpub).toBeNull();
  expect(resolved.advisoryOwnerNpub).toBe("npub1custodian");
});
