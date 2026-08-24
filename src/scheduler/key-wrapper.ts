/**
 * Key Wrapper
 *
 * Encrypts/decrypts the escrow UUID for scheduled jobs using
 * XChaCha20-Poly1305 derived from IDENTITY_SESSION_SECRET.
 * This lets the scheduler engine unlock bot keys at cron time
 * without needing browser context.
 */

import { randomBytes } from "node:crypto";

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte symmetric key from the session secret.
 * The session secret is variable-length, so we SHA-256 hash it.
 */
function deriveWrappingKey(sessionSecretBytes: Uint8Array): Uint8Array {
  return sha256(sessionSecretBytes);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WrappedKey {
  ciphertext: string; // hex
  nonce: string;      // hex
}

/**
 * Encrypt an escrow UUID so it can be stored alongside the scheduled job.
 * Uses XChaCha20-Poly1305 with a random 24-byte nonce.
 */
export function wrapEscrowUuid(
  escrowUuid: string,
  sessionSecretBytes: Uint8Array,
): WrappedKey {
  const key = deriveWrappingKey(sessionSecretBytes);
  const nonce = randomBytes(24);
  const plaintext = new TextEncoder().encode(escrowUuid);

  const cipher = xchacha20poly1305(key, nonce);
  const sealed = cipher.encrypt(plaintext);

  return {
    ciphertext: bytesToHex(sealed),
    nonce: bytesToHex(nonce),
  };
}

/**
 * Decrypt a wrapped escrow UUID back to plaintext.
 */
export function unwrapEscrowUuid(
  wrapped: WrappedKey,
  sessionSecretBytes: Uint8Array,
): string {
  const key = deriveWrappingKey(sessionSecretBytes);
  const nonce = hexToBytes(wrapped.nonce);
  const sealed = hexToBytes(wrapped.ciphertext);

  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(sealed);

  return new TextDecoder().decode(plaintext);
}
