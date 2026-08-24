import { describe, expect, test } from "bun:test";
import { generateSecretKey, nip19 } from "nostr-tools";

import { loadWingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { handleSigningApi, type SigningApiContext } from "./signing-api";
import { mintSigningCapabilityToken } from "./capability-token";

const SECRET = "test-runner-signing-secret";
const wingmanSecret = generateSecretKey();
const wingmanIdentity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: nip19.nsecEncode(wingmanSecret) });
if (!wingmanIdentity) {
  throw new Error("expected test Wingman identity");
}

function makeSession() {
  return {
    id: "session-1",
    agent: "codex",
    port: 3700,
    name: "session",
    status: "running",
    startedAt: new Date().toISOString(),
    npub: "npub1operator",
    command: [],
    workingDirectory: "/tmp",
    logs: [],
  };
}

function makeCtx(overrides: Partial<SigningApiContext> = {}): SigningApiContext {
  return {
    signingSecret: SECRET,
    getSession: (sessionId) => (sessionId === "session-1" ? makeSession() as any : null),
    getInstanceIdentity: () => wingmanIdentity,
    ...overrides,
  };
}

function makeRequest(path: string, token: string, body: unknown): { request: Request; url: URL } {
  const url = new URL(`http://localhost:3600${path}`);
  return {
    url,
    request: new Request(url.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  };
}

describe("handleSigningApi", () => {
  test("signs NIP-98 when runner token allows target host", async () => {
    const token = mintSigningCapabilityToken(SECRET, {
      ttlSeconds: 60,
      sessionId: "session-1",
      nip98: { hosts: ["api.example.com"], methods: ["POST"] },
    });
    const { request, url } = makeRequest("/api/internal/signing/nip98", token, {
      sessionId: "session-1",
      url: "https://api.example.com/jobs",
      method: "POST",
    });

    const response = await handleSigningApi(request, url, "POST", makeCtx());
    expect(response?.status).toBe(200);
    const body = await response!.json() as { token: string; signedBy: string; signerType: string };
    expect(body.token.startsWith("Nostr ")).toBe(true);
    expect(body.signedBy).toBe(wingmanIdentity.npub);
    expect(body.signerType).toBe("wingman");
  });

  test("rejects NIP-98 signing outside token host scope", async () => {
    const token = mintSigningCapabilityToken(SECRET, {
      ttlSeconds: 60,
      nip98: { hosts: ["api.example.com"] },
    });
    const { request, url } = makeRequest("/api/internal/signing/nip98", token, {
      url: "https://other.example.net/jobs",
      method: "POST",
    });

    const response = await handleSigningApi(request, url, "POST", makeCtx());
    expect(response?.status).toBe(403);
  });

  test("signs Nostr events when kind is allowed", async () => {
    const token = mintSigningCapabilityToken(SECRET, {
      ttlSeconds: 60,
      nostr: { kinds: [30078] },
    });
    const { request, url } = makeRequest("/api/internal/signing/nostr-event", token, {
      event: {
        kind: 30078,
        content: "{}",
        tags: [["d", "config"]],
      },
    });

    const response = await handleSigningApi(request, url, "POST", makeCtx());
    expect(response?.status).toBe(200);
    const body = await response!.json() as { event: { kind: number; sig: string; pubkey: string }; signerPubkey: string };
    expect(body.event.kind).toBe(30078);
    expect(body.event.pubkey).toBe(wingmanIdentity.pubkeyHex);
    expect(body.event.sig.length).toBeGreaterThan(20);
    expect(body.signerPubkey).toBe(wingmanIdentity.pubkeyHex);
  });

  test("requires configured runner signing secret", async () => {
    const token = mintSigningCapabilityToken(SECRET, {
      ttlSeconds: 60,
      nip98: { hosts: ["api.example.com"] },
    });
    const { request, url } = makeRequest("/api/internal/signing/nip98", token, {
      url: "https://api.example.com/jobs",
      method: "POST",
    });

    const response = await handleSigningApi(request, url, "POST", makeCtx({ signingSecret: null }));
    expect(response?.status).toBe(503);
  });
});
