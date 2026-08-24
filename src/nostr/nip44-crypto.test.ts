import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";

import { encryptToMultipleRecipients, nip44Decrypt, nip44Encrypt } from "./nip44-crypto";

describe("NIP-44 crypto primitives", () => {
  test("encrypts and decrypts for one recipient", () => {
    const senderSecret = generateSecretKey();
    const recipientSecret = generateSecretKey();
    const ciphertext = nip44Encrypt("preserved primitive", senderSecret, getPublicKey(recipientSecret));

    expect(nip44Decrypt(ciphertext, recipientSecret, getPublicKey(senderSecret))).toBe("preserved primitive");
  });

  test("encrypts independently for multiple recipients", () => {
    const senderSecret = generateSecretKey();
    const recipients = [generateSecretKey(), generateSecretKey()];
    const recipientPubkeys = recipients.map(getPublicKey);
    const ciphertexts = encryptToMultipleRecipients("shared payload", senderSecret, recipientPubkeys);

    expect(Object.keys(ciphertexts).sort()).toEqual([...recipientPubkeys].sort());
    for (const [index, recipientSecret] of recipients.entries()) {
      expect(nip44Decrypt(ciphertexts[recipientPubkeys[index]!]!, recipientSecret, getPublicKey(senderSecret))).toBe("shared payload");
    }
  });
});
