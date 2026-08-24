import { describe, expect, test } from "bun:test";

import {
  assertNip98SigningAllowed,
  assertNostrSigningAllowed,
  mintSigningCapabilityToken,
  verifySigningCapabilityToken,
} from "./capability-token";

const SECRET = "test-signing-secret";
const NOW = 1_700_000_000_000;

describe("runner signing capability tokens", () => {
  test("mints and verifies a scoped token", () => {
    const token = mintSigningCapabilityToken(SECRET, {
      ttlSeconds: 60,
      sessionId: "session-1",
      nip98: { hosts: ["api.example.com"], methods: ["POST"] },
      nostr: { kinds: [30078] },
    }, NOW);

    const result = verifySigningCapabilityToken(SECRET, token, NOW + 10_000);
    expect(result.ok).toBe(true);
    if (result.ok === false) throw new Error(result.reason);

    expect(result.payload.sessionId).toBe("session-1");
    expect(assertNip98SigningAllowed(result.payload, "https://api.example.com/v1/jobs", "POST")).toBeNull();
    expect(assertNostrSigningAllowed(result.payload, 30078)).toBeNull();
  });

  test("rejects tampered tokens", () => {
    const token = mintSigningCapabilityToken(SECRET, {
      ttlSeconds: 60,
      nip98: { hosts: ["api.example.com"] },
    }, NOW);

    const parts = token.split(".");
    parts[1] = Buffer.from(JSON.stringify({
      aud: "wingman-runner-signing",
      v: 1,
      exp: Math.floor(NOW / 1000) + 60,
      nip98: { hosts: ["evil.example.com"] },
    }), "utf8").toString("base64url");

    const result = verifySigningCapabilityToken(SECRET, parts.join("."), NOW);
    expect(result.ok).toBe(false);
  });

  test("enforces host, method, and event-kind restrictions", () => {
    const token = mintSigningCapabilityToken(SECRET, {
      ttlSeconds: 60,
      nip98: { hosts: ["*.example.com"], methods: ["GET"], pathPrefixes: ["/allowed"] },
      nostr: { kinds: [1] },
    }, NOW);
    const result = verifySigningCapabilityToken(SECRET, token, NOW);
    expect(result.ok).toBe(true);
    if (result.ok === false) throw new Error(result.reason);

    expect(assertNip98SigningAllowed(result.payload, "https://api.example.com/allowed/item", "GET")).toBeNull();
    expect(assertNip98SigningAllowed(result.payload, "https://api.example.com/blocked/item", "GET")).toContain("path");
    expect(assertNip98SigningAllowed(result.payload, "https://api.example.com/allowed/item", "POST")).toContain("method");
    expect(assertNip98SigningAllowed(result.payload, "https://other.test/allowed/item", "GET")).toContain("host");
    expect(assertNostrSigningAllowed(result.payload, 30078)).toContain("kind");
  });
});
