import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import { nip44Encrypt } from "../nostr/nip44-crypto";
import { deriveEscrowSecret, unlockViaEscrowWithSecret } from "./bot-key-manager";

describe("legacy broker vault migration", () => {
  test("unwraps an agent key with a supplied control-process wrapping key", () => {
    const wrappingKey = generateSecretKey();
    const agentKey = generateSecretKey();
    const agentPubkey = getPublicKey(agentKey);
    const uuid = "0123456789abcdef";
    const escrowKey = deriveEscrowSecret(wrappingKey, uuid);
    const encrypted = nip44Encrypt(bytesToHex(agentKey), escrowKey, agentPubkey);
    escrowKey.fill(0);

    const unwrapped = unlockViaEscrowWithSecret(encrypted, agentPubkey, uuid, wrappingKey);
    expect(getPublicKey(unwrapped)).toBe(agentPubkey);
    expect(bytesToHex(unwrapped)).toBe(bytesToHex(agentKey));

    unwrapped.fill(0);
    agentKey.fill(0);
    wrappingKey.fill(0);
  });

  test("rejects a different wrapping key without returning agent material", () => {
    const originalWrappingKey = generateSecretKey();
    const wrongWrappingKey = generateSecretKey();
    const agentKey = generateSecretKey();
    const agentPubkey = getPublicKey(agentKey);
    const uuid = "fedcba9876543210";
    const escrowKey = deriveEscrowSecret(originalWrappingKey, uuid);
    const encrypted = nip44Encrypt(bytesToHex(agentKey), escrowKey, agentPubkey);
    escrowKey.fill(0);

    expect(() => unlockViaEscrowWithSecret(encrypted, agentPubkey, uuid, wrongWrappingKey)).toThrow();

    agentKey.fill(0);
    wrongWrappingKey.fill(0);
    originalWrappingKey.fill(0);
  });
});
