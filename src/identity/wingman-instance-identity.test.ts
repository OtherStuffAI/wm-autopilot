if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import { buildWingmanIdentityEnv, loadWingmanInstanceIdentity } from "./wingman-instance-identity";
import { SharedStateStore } from "../storage/shared-state-store";

const makeTempDb = () => join(tmpdir(), `wingman-instance-identity-${randomUUID()}.sqlite`);

describe("Wingman instance identity", () => {
  let dbPath: string;
  let store: SharedStateStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new SharedStateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
  });

  test("loads WINGMAN_PRIV nsec and derives public identity", () => {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);
    const pubkeyHex = getPublicKey(secretKey);

    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: nsec }, store);

    expect(identity?.nsec).toBe(nsec);
    expect(identity?.nsecHex).toBe(bytesToHex(secretKey));
    expect(identity?.pubkeyHex).toBe(pubkeyHex);
    expect(identity?.npub).toBe(nip19.npubEncode(pubkeyHex));
    expect(identity?.source).toBe("env");
  });

  test("builds public-only instance env without exposing any private key", () => {
    const secretKey = generateSecretKey();
    const identity = loadWingmanInstanceIdentity({ WINGMAN_PRIV: nip19.nsecEncode(secretKey) }, store);

    if (!identity) throw new Error("expected identity");
    const env = buildWingmanIdentityEnv(identity);

    expect(env.WINGMAN_NPUB).toBe(identity.npub);
    expect(env.BOT_NPUB).toBeUndefined();
    expect(env.BOT_PUBKEY_HEX).toBeUndefined();
    expect(env.AGENT_NSEC).toBeUndefined();
    expect(env.WINGMAN_PRIV).toBeUndefined();
  });

  test("loads encrypted shared state when WINGMAN_PRIV is absent", () => {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);
    store.set("wingman_priv", nsec);

    const identity = loadWingmanInstanceIdentity({}, store);

    expect(identity?.nsec).toBe(nsec);
    expect(identity?.source).toBe("shared_state");
  });

  test("generates and persists encrypted shared state when WINGMAN_PRIV is absent", () => {
    const identity = loadWingmanInstanceIdentity({}, store);

    expect(identity?.nsec.startsWith("nsec1")).toBe(true);
    expect(identity?.source).toBe("generated");
    expect(store.get("wingman_priv")).toBe(identity?.nsec);
  });

  test("throws when WINGMAN_PRIV is present but invalid", () => {
    expect(() => loadWingmanInstanceIdentity({ WINGMAN_PRIV: "not-an-nsec" }, store)).toThrow(
      "WINGMAN_PRIV",
    );
  });
});
