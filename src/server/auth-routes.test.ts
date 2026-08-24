import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { AccessActions } from "../auth/access-control";
import { LoginChallengeStore } from "../auth/login-challenge-store";
import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { handleAuthApi, type AuthApiContext } from "./auth-routes";

const makeNpub = () => nip19.npubEncode(getPublicKey(generateSecretKey()));

function createAuthContext(adminNpub: string, adminNpubs: string[] = [adminNpub]): AuthApiContext {
  const knownUsers = new Set<string>();
  const normalizedAdmins = adminNpubs.map((npub) => normaliseNpub(npub)).filter((npub): npub is string => Boolean(npub));
  return {
    config: {
      baseUrl: "",
      registrationEnabled: false,
      connectRelays: [],
      giteaUrl: null,
      giteaApiToken: null,
      giteaOwner: null,
    },
    adminNpub: normaliseNpub(adminNpub),
    isAdminNpub: (npub) => {
      const normalized = normaliseNpub(npub ?? null);
      return Boolean(normalized && normalizedAdmins.includes(normalized));
    },
    identityUserStore: {
      getByNormalized: (npub) => knownUsers.has(npub) ? { npub, pictureUrl: null } : null,
      touch: (npub) => {
        const normalized = normaliseNpub(npub);
        if (normalized) knownUsers.add(normalized);
      },
    },
    mintSessionCookie: (npub) => ({
      cookie: "wingman_identity_session=test; Path=/",
      expiresAt: 1,
      payload: { npub, nonce: "test", issuedAt: 0, expiresAt: 1 },
    }),
    getSessionCookieName: () => "wingman_identity_session",
    SessionCookieError: Error,
    SESSION_COOKIE_NAME: "wingman_identity_session",
    shouldUseSecureCookies: () => false,
    loginChallengeStore: new LoginChallengeStore(),
    generateIdentityAlias: (npub) => npub,
    handleKeyTeleport: () => Response.json({ ok: true }),
    handleKeyTeleportRegistration: () => Response.json({ ok: true }),
    ensureGiteaUser: async () => null,
    ensureApiAccess: async () => null,
    AccessActions: { UiRestricted: AccessActions.UiRestricted },
    getViewerNormalizedNpub: (auth) => normaliseNpub(auth.npub ?? null),
    normaliseOptionalString: (value) => typeof value === "string" && value.trim() ? value.trim() : null,
    resolveAndCacheNostrProfile: async () => ({ pictureUrl: null }),
  };
}

const requestAuthContext = (): RequestAuthContext => ({
  npub: null,
  actorNpub: null,
  session: null,
});

const signLoginEvent = (
  secretKey: Uint8Array,
  challenge: string,
  url = "http://localhost/api/auth/session",
) =>
  finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", "POST"],
        ["purpose", "wingman-login"],
        ["challenge", challenge],
      ],
      content: challenge,
    },
    secretKey,
  );

describe("auth routes", () => {
  test("issues a no-store login challenge", async () => {
    const adminNpub = makeNpub();
    const ctx = createAuthContext(adminNpub);
    const request = new Request("http://localhost/api/auth/challenge");

    const response = await handleAuthApi(request, new URL(request.url), "GET", requestAuthContext(), ctx);
    const payload = await response!.json() as { challenge: string; expiresAt: number };

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(payload.challenge).toBeString();
    expect(payload.challenge.length).toBeGreaterThanOrEqual(40);
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
  });

  test("rejects login without a signed event", async () => {
    const adminNpub = makeNpub();
    const ctx = createAuthContext(adminNpub);
    const challenge = ctx.loginChallengeStore.issue().challenge;
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub: adminNpub, challenge }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      ctx,
    );

    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({ error: "signedEvent is required" });
  });

  test("allows a configured admin with a valid challenge signature to bootstrap", async () => {
    const primaryAdminNpub = makeNpub();
    const secondaryAdminSecretKey = generateSecretKey();
    const secondaryAdminNpub = nip19.npubEncode(getPublicKey(secondaryAdminSecretKey));
    const ctx = createAuthContext(primaryAdminNpub, [primaryAdminNpub, secondaryAdminNpub]);
    const challenge = ctx.loginChallengeStore.issue().challenge;
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({
        npub: secondaryAdminNpub,
        challenge,
        signedEvent: signLoginEvent(secondaryAdminSecretKey, challenge),
      }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      ctx,
    );

    expect(response?.status).toBe(200);
  });

  test("blocks unknown users when registration is disabled", async () => {
    const secretKey = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(secretKey));
    const ctx = createAuthContext(makeNpub());
    const challenge = ctx.loginChallengeStore.issue().challenge;
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub, challenge, signedEvent: signLoginEvent(secretKey, challenge) }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      ctx,
    );

    expect(response?.status).toBe(403);
    await expect(response!.json()).resolves.toMatchObject({
      error: "Registration is currently disabled",
    });
  });

  test("accepts a verified signed login event for the submitted npub", async () => {
    const secretKey = generateSecretKey();
    const adminNpub = nip19.npubEncode(getPublicKey(secretKey));
    const ctx = createAuthContext(adminNpub);
    const challenge = ctx.loginChallengeStore.issue().challenge;
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub: adminNpub, challenge, signedEvent: signLoginEvent(secretKey, challenge) }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      ctx,
    );

    expect(response?.status).toBe(200);
  });

  test("rejects a signed login event from a different npub", async () => {
    const submittedNpub = makeNpub();
    const signerSecretKey = generateSecretKey();
    const ctx = createAuthContext(submittedNpub);
    const challenge = ctx.loginChallengeStore.issue().challenge;
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ npub: submittedNpub, challenge, signedEvent: signLoginEvent(signerSecretKey, challenge) }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      ctx,
    );

    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({
      error: "signedEvent.pubkey must match npub",
    });
  });

  test("rejects a replayed login challenge", async () => {
    const secretKey = generateSecretKey();
    const adminNpub = nip19.npubEncode(getPublicKey(secretKey));
    const ctx = createAuthContext(adminNpub);
    const challenge = ctx.loginChallengeStore.issue().challenge;
    const body = JSON.stringify({
      npub: adminNpub,
      challenge,
      signedEvent: signLoginEvent(secretKey, challenge),
    });

    const firstRequest = new Request("http://localhost/api/auth/session", { method: "POST", body });
    const firstResponse = await handleAuthApi(
      firstRequest,
      new URL(firstRequest.url),
      "POST",
      requestAuthContext(),
      ctx,
    );
    expect(firstResponse?.status).toBe(200);

    const replayRequest = new Request("http://localhost/api/auth/session", { method: "POST", body });
    const replayResponse = await handleAuthApi(
      replayRequest,
      new URL(replayRequest.url),
      "POST",
      requestAuthContext(),
      ctx,
    );
    expect(replayResponse?.status).toBe(401);
    await expect(replayResponse!.json()).resolves.toMatchObject({
      error: "Login challenge is invalid, expired, or already used",
    });
  });

  test("rejects a signature bound to a different challenge", async () => {
    const secretKey = generateSecretKey();
    const adminNpub = nip19.npubEncode(getPublicKey(secretKey));
    const ctx = createAuthContext(adminNpub);
    const submittedChallenge = ctx.loginChallengeStore.issue().challenge;
    const signedChallenge = ctx.loginChallengeStore.issue().challenge;
    const request = new Request("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({
        npub: adminNpub,
        challenge: submittedChallenge,
        signedEvent: signLoginEvent(secretKey, signedChallenge),
      }),
    });

    const response = await handleAuthApi(
      request,
      new URL(request.url),
      "POST",
      requestAuthContext(),
      ctx,
    );

    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({
      error: "signedEvent challenge tag does not match login challenge",
    });
  });
});
