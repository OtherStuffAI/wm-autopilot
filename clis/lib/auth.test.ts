import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { buildAuthConfig, parseCommonFlags, resolveSecretKey } from "./auth";

describe("resolveSecretKey — CLI auth env resolution", () => {
  const originalEnv = { ...Bun.env };

  afterEach(() => {
    // Restore env
    delete Bun.env.AGENT_NSEC;
    delete Bun.env.WINGMAN_NSEC;
    delete Bun.env.WINGMAN_NIP98_NSEC;
    delete Bun.env.KEYTELEPORT_PRIVKEY;
    delete Bun.env.SESSION_ID;
    delete Bun.env.WINGMAN_CAPABILITY;
    delete Bun.env.WINGMAN_BROKER_URL;
    delete Bun.env.WINGMAN_URL;
  });

  test("resolves from explicit keyInput arg", () => {
    const hex = "a".repeat(64);
    const result = resolveSecretKey(hex);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  test("resolves from WINGMAN_NSEC env var", () => {
    const hex = "b".repeat(64);
    delete Bun.env.AGENT_NSEC;
    Bun.env.WINGMAN_NSEC = hex;
    const result = resolveSecretKey();
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  test("does not accept legacy AGENT_NSEC from an agent environment", () => {
    Bun.env.AGENT_NSEC = "a".repeat(64);
    delete Bun.env.WINGMAN_NSEC;
    expect(() => resolveSecretKey()).toThrow(/capability broker/);
  });

  test("does not fall back to WINGMAN_NIP98_NSEC", () => {
    delete Bun.env.AGENT_NSEC;
    Bun.env.WINGMAN_NIP98_NSEC = "c".repeat(64);
    expect(() => resolveSecretKey()).toThrow(/capability broker.*WINGMAN_NSEC/);
  });

  test("does not fall back to KEYTELEPORT_PRIVKEY", () => {
    delete Bun.env.AGENT_NSEC;
    Bun.env.KEYTELEPORT_PRIVKEY = "d".repeat(64);
    expect(() => resolveSecretKey()).toThrow(/capability broker.*WINGMAN_NSEC/);
  });

  test("throws with helpful message mentioning WINGMAN_NSEC when no key available", () => {
    delete Bun.env.AGENT_NSEC;
    expect(() => resolveSecretKey()).toThrow(/capability broker.*WINGMAN_NSEC/);
  });

  test("prefers explicit keyInput over WINGMAN_NSEC env", () => {
    const inputHex = "a".repeat(64);
    const envHex = "b".repeat(64);
    Bun.env.WINGMAN_NSEC = envHex;
    const result = resolveSecretKey(inputHex);
    // Verify the result matches the input, not the env
    const { hexToBytes } = require("@noble/hashes/utils");
    expect(result).toEqual(hexToBytes(inputHex));
  });

  test("builds brokered auth without resolving or falling back to an operator key", () => {
    Bun.env.SESSION_ID = "session-a";
    Bun.env.WINGMAN_CAPABILITY = "opaque-capability";
    Bun.env.WINGMAN_NSEC = "not-a-valid-key";

    expect(buildAuthConfig("http://localhost:3600", undefined, true)).toEqual({
      baseUrl: "http://localhost:3600",
      brokerUrl: "http://localhost:3600",
      botCrypto: true,
    });
  });

  test("keeps the local capability broker separate from a remote API target", () => {
    Bun.env.SESSION_ID = "session-a";
    Bun.env.WINGMAN_CAPABILITY = "opaque-capability";
    Bun.env.WINGMAN_URL = "http://127.0.0.1:3256";

    expect(buildAuthConfig("https://remote.example", undefined, true)).toEqual({
      baseUrl: "https://remote.example",
      brokerUrl: "http://127.0.0.1:3256",
      botCrypto: true,
    });
  });

  test("fails closed when brokered context is incomplete", () => {
    Bun.env.SESSION_ID = "session-a";
    Bun.env.WINGMAN_NSEC = "a".repeat(64);

    expect(() => buildAuthConfig(undefined, undefined, true)).toThrow(/WINGMAN_CAPABILITY/);
  });

  test("rejects mixing brokered and raw-key modes", () => {
    Bun.env.SESSION_ID = "session-a";
    Bun.env.WINGMAN_CAPABILITY = "opaque-capability";

    expect(() => buildAuthConfig(undefined, "a".repeat(64), true)).toThrow(/cannot be combined/);
  });

  test("selects brokered auth automatically inside an agent session", () => {
    Bun.env.SESSION_ID = "session-a";
    Bun.env.WINGMAN_CAPABILITY = "opaque-capability";

    expect(parseCommonFlags(["list", "--json"])).toMatchObject({
      args: ["list"],
      asJson: true,
      botCrypto: true,
    });
  });

  test("keeps an explicit operator key out of brokered mode", () => {
    Bun.env.SESSION_ID = "session-a";
    Bun.env.WINGMAN_CAPABILITY = "opaque-capability";

    expect(parseCommonFlags(["list", "--key", "a".repeat(64)]).botCrypto).toBeFalse();
  });
});
