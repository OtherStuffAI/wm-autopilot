/**
 * Bot Key Manager
 *
 * Handles generation, encryption, and in-memory holding of per-user bot
 * keypairs. Uses NIP-44 v2 for encryption and SHA-256 derived escrow keys.
 *
 * Crypto flow:
 *   - User path: NIP-44 encrypt nsec_hex from root key → user pubkey
 *   - Escrow path: NIP-44 encrypt nsec_hex from escrow_secret → bot pubkey
 *   - escrow_secret = sha256(keyteleport_secret_bytes || uuid_hex_bytes)
 */

import { randomBytes } from "node:crypto";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import { nip44Encrypt, nip44Decrypt } from "../nostr/nip44-crypto";
import { getKeyTeleportIdentity } from "../config";
import { signBotProfileEvent, getBotDisplayName } from "./bot-identity-publisher";
import type { SignedNostrEvent } from "./bot-identity-publisher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratedBotKey {
  botPubkeyHex: string;
  botNpub: string;
  encryptedToUser: string;
  encryptedEscrow: string;
  escrowUuid: string;
  displayName: string;
  signedProfileEvent: SignedNostrEvent;
}

export interface UnlockedBotKey {
  secretKey: Uint8Array;
  pubkeyHex: string;
  npub: string;
  unlockMethod: "browser" | "escrow";
}

// ---------------------------------------------------------------------------
// Escrow key derivation
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Derive a 32-byte escrow secret from the server key and a UUID.
 * escrow_secret = sha256(keyteleport_secret_bytes || uuid_hex_bytes)
 */
export function deriveEscrowSecret(
  keyteleportSecret: Uint8Array,
  uuid: string,
): Uint8Array {
  const uuidBytes = new TextEncoder().encode(uuid);
  const combined = new Uint8Array(keyteleportSecret.length + uuidBytes.length);
  combined.set(keyteleportSecret, 0);
  combined.set(uuidBytes, keyteleportSecret.length);
  return sha256(combined);
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generate a new bot keypair and encrypt the secret key via both paths.
 *
 * @param userPubkeyHex - The user's Nostr public key (64-char hex)
 * @returns Encrypted blobs and metadata (raw secret is wiped before return)
 */
export function generateBotKey(
  userPubkeyHex: string,
  profile: { name?: string | null; picture?: string | null; about?: string | null; nip05?: string | null } = {},
): GeneratedBotKey {
  const identity = getKeyTeleportIdentity();
  if (!identity) {
    throw new Error("KEYTELEPORT_PRIVKEY not configured — cannot generate bot key");
  }

  // Generate a fresh keypair
  const botSecret = generateSecretKey();
  const botPubkeyHex = getPublicKey(botSecret);
  const botNpub = nip19.npubEncode(botPubkeyHex);
  const nsecHex = bytesToHex(botSecret);

  // Generate escrow UUID (16 hex chars = 8 bytes)
  const escrowUuid = bytesToHex(randomBytes(8));

  // User path: encrypt nsec from root key → user pubkey
  const encryptedToUser = nip44Encrypt(nsecHex, identity.secretKey, userPubkeyHex);

  // Escrow path: encrypt nsec from escrow_secret → bot pubkey
  const escrowSecret = deriveEscrowSecret(identity.secretKey, escrowUuid);
  const encryptedEscrow = nip44Encrypt(nsecHex, escrowSecret, botPubkeyHex);

  // Sign kind 0 profile event BEFORE wiping the secret key
  const displayName = profile.name?.trim() || getBotDisplayName(botPubkeyHex);
  const signedProfileEvent = signBotProfileEvent(botSecret, displayName, profile);

  // Wipe raw secret from memory
  botSecret.fill(0);

  return {
    botPubkeyHex,
    botNpub,
    encryptedToUser,
    encryptedEscrow,
    escrowUuid,
    displayName,
    signedProfileEvent,
  };
}

// ---------------------------------------------------------------------------
// Escrow unlock
// ---------------------------------------------------------------------------

/**
 * Decrypt the bot secret key using the escrow path.
 *
 * @param encryptedEscrow - NIP-44 ciphertext from the escrow path
 * @param botPubkeyHex - Expected bot public key for validation
 * @param escrowUuid - The escrow UUID used during encryption
 * @returns The decrypted secret key as Uint8Array
 */
export function unlockViaEscrow(
  encryptedEscrow: string,
  botPubkeyHex: string,
  escrowUuid: string,
): Uint8Array {
  const identity = getKeyTeleportIdentity();
  if (!identity) {
    throw new Error("KEYTELEPORT_PRIVKEY not configured — cannot unlock via escrow");
  }

  return unlockViaEscrowWithSecret(
    encryptedEscrow,
    botPubkeyHex,
    escrowUuid,
    identity.secretKey,
  );
}

/**
 * One-time compatibility unwrap for records created when the escrow wrapping
 * key was supplied under another control-process setting. The caller owns the
 * wrapping key and the returned agent key; neither is logged or exported.
 */
export function unlockViaEscrowWithSecret(
  encryptedEscrow: string,
  botPubkeyHex: string,
  escrowUuid: string,
  wrappingSecretKey: Uint8Array,
): Uint8Array {
  if (wrappingSecretKey.byteLength !== 32) {
    throw new Error("Escrow wrapping key must contain exactly 32 bytes");
  }

  const escrowSecret = deriveEscrowSecret(wrappingSecretKey, escrowUuid);
  let nsecHex: string;
  try {
    nsecHex = nip44Decrypt(encryptedEscrow, escrowSecret, botPubkeyHex);
  } finally {
    escrowSecret.fill(0);
  }

  // Validate: derive pubkey from decrypted secret and compare
  const secretKey = hexToBytes(nsecHex);
  const derivedPubkey = getPublicKey(secretKey);
  if (derivedPubkey !== botPubkeyHex) {
    secretKey.fill(0);
    throw new Error("Escrow unlock failed: derived pubkey does not match stored bot pubkey");
  }

  return secretKey;
}

/**
 * Rotate the escrow UUID: re-encrypt the bot secret with a new UUID.
 * Requires current UUID to decrypt first.
 */
export function rotateEscrowUuid(
  encryptedEscrow: string,
  botPubkeyHex: string,
  currentUuid: string,
): { newEncryptedEscrow: string; newEscrowUuid: string } {
  const identity = getKeyTeleportIdentity();
  if (!identity) {
    throw new Error("KEYTELEPORT_PRIVKEY not configured — cannot rotate escrow");
  }

  // Decrypt with current UUID
  const secretKey = unlockViaEscrow(encryptedEscrow, botPubkeyHex, currentUuid);
  const nsecHex = bytesToHex(secretKey);
  secretKey.fill(0);

  // Re-encrypt with new UUID
  const newEscrowUuid = bytesToHex(randomBytes(8));
  const escrowSecret = deriveEscrowSecret(identity.secretKey, newEscrowUuid);
  const newEncryptedEscrow = nip44Encrypt(nsecHex, escrowSecret, botPubkeyHex);

  return { newEncryptedEscrow, newEscrowUuid };
}

// ---------------------------------------------------------------------------
// In-memory key holder
// ---------------------------------------------------------------------------

const activeKeys = new Map<string, UnlockedBotKey>();

/**
 * Store a decrypted bot key in memory for runtime signing.
 */
export function storeBotKeyInMemory(
  npub: string,
  secretKey: Uint8Array,
  pubkeyHex: string,
  unlockMethod: "browser" | "escrow",
): void {
  activeKeys.set(npub, {
    secretKey,
    pubkeyHex,
    npub: nip19.npubEncode(pubkeyHex),
    unlockMethod,
  });
  console.log(`[bot-key] Stored bot key in memory for ${npub.slice(0, 20)}… (${unlockMethod})`);
}

/**
 * Get a decrypted bot key from memory.
 */
export function getDecryptedBotKey(npub: string): UnlockedBotKey | null {
  return activeKeys.get(npub) ?? null;
}

/**
 * Clear a bot key from memory (e.g. when last session for user stops).
 */
export function clearBotKey(npub: string): void {
  const existing = activeKeys.get(npub);
  if (existing) {
    existing.secretKey.fill(0);
    activeKeys.delete(npub);
    console.log(`[bot-key] Cleared bot key from memory for ${npub.slice(0, 20)}…`);
  }
}

/**
 * Check if a bot key is currently unlocked in memory.
 */
export function isBotKeyUnlocked(npub: string): boolean {
  return activeKeys.has(npub);
}
