import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { mintSessionCookie } from "../auth/session-cookie";
import { createBotKeyApiHandler } from "./bot-key-api";
import { loadWingmanInstanceIdentity } from "./wingman-instance-identity";

function makeCookie(npub: string): string {
  return mintSessionCookie(npub, { secure: false }).cookie;
}

function createStoreStub() {
  return {
    getActiveKeyForUser: () => null,
    createKey: () => {
      throw new Error("legacy bot key creation should not be called");
    },
  } as any;
}

function createRequest(path: string, npub: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: makeCookie(npub) },
  });
}

function createPostRequest(path: string, npub: string, body: Record<string, unknown> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: makeCookie(npub),
    },
    body: JSON.stringify(body),
  });
}

describe("bot key API with Wingman instance identity", () => {
  test("returns stable public identity and rejects raw-key unlock", async () => {
    const userNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const agentSecret = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecret);
    const agentNpub = nip19.npubEncode(agentPubkey);
    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: nip19.nsecEncode(generateSecretKey()) });
    if (!identity) throw new Error("expected identity");
    const record = {
      id: "stable-agent", userNpub, botPubkeyHex: agentPubkey, botNpub: agentNpub,
      displayName: "Example Agent", encryptedToUser: "ciphertext", encryptedEscrow: "escrow",
      escrowUuid: "uuid", isActive: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const handler = createBotKeyApiHandler({
      store: { ...createStoreStub(), getActiveKeyForUser: () => record },
      getSession: () => undefined,
      getInstanceIdentity: () => identity,
      isAdminNpub: () => true,
    });

    const me = await handler(createRequest("/api/bot-keys/me", userNpub), new URL("http://localhost/api/bot-keys/me"), "GET");
    expect(await me!.json()).toMatchObject({ botNpub: agentNpub, source: "stable_agent_key", canExportNsec: false });

    const unlocked = await handler(
      createPostRequest("/api/bot-keys/unlock", userNpub),
      new URL("http://localhost/api/bot-keys/unlock"),
      "POST",
    );
    expect(unlocked!.status).toBe(404);
    agentSecret.fill(0);
  });

  test("returns only public Wingman details to non-admin users", async () => {
    const userNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const wingmanNsec = nip19.nsecEncode(generateSecretKey());
    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: wingmanNsec });
    if (!identity) throw new Error("expected identity");

    const handler = createBotKeyApiHandler({
      store: createStoreStub(),
      getSession: () => undefined,
      getInstanceIdentity: () => identity,
      isAdminNpub: () => false,
    });

    const response = await handler(createRequest("/api/bot-keys/me", userNpub), new URL("http://localhost/api/bot-keys/me"), "GET");
    const body = await response!.json() as Record<string, unknown>;

    expect(response!.status).toBe(200);
    expect(body.hasKey).toBe(true);
    expect(body.botNpub).toBe(identity.npub);
    expect(body.botPubkeyHex).toBe(identity.pubkeyHex);
    expect(body.source).toBe("wingman_priv");
    expect(body.canExportNsec).toBe(false);
    expect(body.nsec).toBeUndefined();
    expect(body.nsecHex).toBeUndefined();
  });

  test("does not export the instance nsec for users or admins", async () => {
    const adminNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const userNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const wingmanNsec = nip19.nsecEncode(generateSecretKey());
    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: wingmanNsec });
    if (!identity) throw new Error("expected identity");

    const handler = createBotKeyApiHandler({
      store: createStoreStub(),
      getSession: () => undefined,
      getInstanceIdentity: () => identity,
      isAdminNpub: (npub) => npub === adminNpub,
    });

    const denied = await handler(
      createRequest("/api/bot-keys/admin-nsec", userNpub),
      new URL("http://localhost/api/bot-keys/admin-nsec"),
      "GET",
    );
    expect(denied!.status).toBe(404);

    const allowed = await handler(
      createRequest("/api/bot-keys/admin-nsec", adminNpub),
      new URL("http://localhost/api/bot-keys/admin-nsec"),
      "GET",
    );
    expect(allowed!.status).toBe(404);
    expect(JSON.stringify(await allowed!.json())).not.toContain(identity.nsec);
  });

  test("does not fall back to per-user key generation when WINGMAN_PRIV is missing", async () => {
    const userNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const handler = createBotKeyApiHandler({
      store: createStoreStub(),
      getSession: () => undefined,
      getInstanceIdentity: () => null,
      isAdminNpub: () => false,
    });

    const forceSync = await handler(
      createPostRequest("/api/bot-keys/force-sync", userNpub),
      new URL("http://localhost/api/bot-keys/force-sync"),
      "POST",
    );
    expect(forceSync!.status).toBe(400);
    expect((await forceSync!.json() as { error: string }).error).toContain("WINGMAN_PRIV");

    const replace = await handler(
      createPostRequest("/api/bot-keys/replace", userNpub, { userPubkeyHex: "0".repeat(64) }),
      new URL("http://localhost/api/bot-keys/replace"),
      "POST",
    );
    expect(replace!.status).toBe(400);
    expect((await replace!.json() as { error: string }).error).toContain("generation is disabled");
  });
});
