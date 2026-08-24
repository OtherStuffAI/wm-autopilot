import { nip44 } from "nostr-tools";

export function nip44Encrypt(
  plaintext: string,
  secretKey: Uint8Array,
  recipientPubkeyHex: string,
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, recipientPubkeyHex);
  return nip44.v2.encrypt(plaintext, conversationKey);
}

export function nip44Decrypt(
  ciphertext: string,
  secretKey: Uint8Array,
  senderPubkeyHex: string,
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, senderPubkeyHex);
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

export function encryptToMultipleRecipients(
  plaintext: string,
  secretKey: Uint8Array,
  pubkeys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pubkey of pubkeys) {
    result[pubkey] = nip44Encrypt(plaintext, secretKey, pubkey);
  }
  return result;
}
