// Must be set BEFORE any imports that trigger getSessionSecretBytes()
// Guard: the session-secret module freezes this property after first access.
if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { describe, test, expect } from "bun:test";

import { encryptTeamProviderKey, decryptTeamProviderKey, type EncryptedTeamKey } from "./team-key-crypto";

describe("team-key-crypto", () => {
  // ── roundtrip ──────────────────────────────────────────────

  test("encrypt then decrypt roundtrip returns original plaintext", () => {
    const plaintext = "sk-or-v1-abc123-secret-key";
    const encrypted = encryptTeamProviderKey(plaintext);
    const decrypted = decryptTeamProviderKey(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test("different plaintexts produce different ciphertexts", () => {
    const a = encryptTeamProviderKey("key-alpha");
    const b = encryptTeamProviderKey("key-beta");
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("two encryptions of same plaintext produce different ciphertexts (random IV)", () => {
    const text = "same-plaintext-value";
    const first = encryptTeamProviderKey(text);
    const second = encryptTeamProviderKey(text);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  // ── tamper detection ───────────────────────────────────────

  test("tampered ciphertext throws on decrypt", () => {
    const encrypted = encryptTeamProviderKey("sensitive-key");
    const tampered: EncryptedTeamKey = {
      ...encrypted,
      ciphertext: Buffer.from("tampered-data").toString("base64"),
    };
    expect(() => decryptTeamProviderKey(tampered)).toThrow();
  });

  test("tampered authTag throws on decrypt", () => {
    const encrypted = encryptTeamProviderKey("sensitive-key");
    const tampered: EncryptedTeamKey = {
      ...encrypted,
      authTag: Buffer.from("0000000000000000").toString("base64"),
    };
    expect(() => decryptTeamProviderKey(tampered)).toThrow();
  });

  test("tampered IV throws on decrypt", () => {
    const encrypted = encryptTeamProviderKey("sensitive-key");
    const tampered: EncryptedTeamKey = {
      ...encrypted,
      iv: Buffer.from("000000000000").toString("base64"),
    };
    expect(() => decryptTeamProviderKey(tampered)).toThrow();
  });

  // ── edge cases ─────────────────────────────────────────────

  test("empty string encrypts and decrypts correctly", () => {
    const encrypted = encryptTeamProviderKey("");
    const decrypted = decryptTeamProviderKey(encrypted);
    expect(decrypted).toBe("");
  });

  test("long plaintext (1000+ chars) encrypts and decrypts correctly", () => {
    const long = "A".repeat(1500);
    const encrypted = encryptTeamProviderKey(long);
    const decrypted = decryptTeamProviderKey(encrypted);
    expect(decrypted).toBe(long);
  });
});
