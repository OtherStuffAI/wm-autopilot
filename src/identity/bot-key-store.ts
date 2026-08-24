/**
 * Bot Key Store
 *
 * SQLite store for per-user encrypted bot keypairs.
 * Each user gets a unique bot identity (secp256k1 keypair) that replaces
 * the shared KEYTELEPORT_PRIVKEY for Tier 1 signing and NIP-44 crypto.
 *
 * The private key is stored encrypted via two paths:
 *   1. User path — NIP-44 encrypted from root key → user pubkey
 *   2. Escrow path — NIP-44 encrypted using a derived escrow key
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotKeyRecord {
  id: string;
  userNpub: string;
  botPubkeyHex: string;
  botNpub: string;
  displayName: string;
  encryptedToUser: string;
  encryptedEscrow: string;
  escrowUuid: string;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBotKeyInput {
  userNpub: string;
  botPubkeyHex: string;
  botNpub: string;
  displayName: string;
  encryptedToUser: string;
  encryptedEscrow: string;
  escrowUuid: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = new URL("../../data/bot-keys.db", import.meta.url).pathname;

class BotKeyStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  getActiveKeyForUser(npub: string): BotKeyRecord | null {
    const result = this.db
      .query<BotKeyRecord, [string]>(
        `SELECT
           id,
           user_npub AS userNpub,
           bot_pubkey_hex AS botPubkeyHex,
           bot_npub AS botNpub,
           COALESCE(display_name, '') AS displayName,
           encrypted_to_user AS encryptedToUser,
           encrypted_escrow AS encryptedEscrow,
           escrow_uuid AS escrowUuid,
           is_active AS isActive,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM bot_keys
         WHERE user_npub = ?1 AND is_active = 1
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      )
      .get(npub);
    return result ?? null;
  }

  listActiveKeysForUser(npub: string): BotKeyRecord[] {
    return this.listActiveKeys().filter((record) => record.userNpub === npub);
  }

  listActiveKeys(): BotKeyRecord[] {
    return this.db.query<BotKeyRecord, []>(
      `SELECT id, user_npub AS userNpub, bot_pubkey_hex AS botPubkeyHex,
        bot_npub AS botNpub, COALESCE(display_name, '') AS displayName,
        encrypted_to_user AS encryptedToUser, encrypted_escrow AS encryptedEscrow,
        escrow_uuid AS escrowUuid, is_active AS isActive, created_at AS createdAt,
        updated_at AS updatedAt FROM bot_keys WHERE is_active = 1 ORDER BY created_at ASC`,
    ).all();
  }

  getActiveKeyForBotNpub(botNpub: string): BotKeyRecord | null {
    const result = this.db
      .query<BotKeyRecord, [string]>(
        `SELECT
           id,
           user_npub AS userNpub,
           bot_pubkey_hex AS botPubkeyHex,
           bot_npub AS botNpub,
           COALESCE(display_name, '') AS displayName,
           encrypted_to_user AS encryptedToUser,
           encrypted_escrow AS encryptedEscrow,
           escrow_uuid AS escrowUuid,
           is_active AS isActive,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM bot_keys
         WHERE bot_npub = ?1 AND is_active = 1`,
      )
      .get(botNpub);
    return result ?? null;
  }

  createKey(input: CreateBotKeyInput): BotKeyRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .query(
        `INSERT INTO bot_keys (
           id, user_npub, bot_pubkey_hex, bot_npub, display_name,
           encrypted_to_user, encrypted_escrow, escrow_uuid,
           is_active, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10)`,
      )
      .run(
        id,
        input.userNpub,
        input.botPubkeyHex,
        input.botNpub,
        input.displayName,
        input.encryptedToUser,
        input.encryptedEscrow,
        input.escrowUuid,
        now,
        now,
      );

    const created = this.getById(id);
    if (!created) {
      throw new Error("Failed to create bot key record");
    }
    return created;
  }

  updateEscrow(id: string, encryptedEscrow: string, escrowUuid: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE bot_keys
         SET encrypted_escrow = ?2, escrow_uuid = ?3, updated_at = ?4
         WHERE id = ?1`,
      )
      .run(id, encryptedEscrow, escrowUuid, now);
  }

  deactivateKey(id: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE bot_keys SET is_active = 0, updated_at = ?2 WHERE id = ?1`,
      )
      .run(id, now);
  }

  deleteKey(id: string): void {
    this.db.query(`DELETE FROM bot_keys WHERE id = ?1`).run(id);
  }

  private getById(id: string): BotKeyRecord | null {
    const result = this.db
      .query<BotKeyRecord, [string]>(
        `SELECT
           id,
           user_npub AS userNpub,
           bot_pubkey_hex AS botPubkeyHex,
           bot_npub AS botNpub,
           COALESCE(display_name, '') AS displayName,
           encrypted_to_user AS encryptedToUser,
           encrypted_escrow AS encryptedEscrow,
           escrow_uuid AS escrowUuid,
           is_active AS isActive,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM bot_keys
         WHERE id = ?1`,
      )
      .get(id);
    return result ?? null;
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_keys (
        id TEXT PRIMARY KEY,
        user_npub TEXT NOT NULL,
        bot_pubkey_hex TEXT NOT NULL,
        bot_npub TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        encrypted_to_user TEXT NOT NULL,
        encrypted_escrow TEXT NOT NULL,
        escrow_uuid TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      DROP INDEX IF EXISTS idx_bot_keys_user_active;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_keys_bot_active
        ON bot_keys(bot_npub) WHERE is_active = 1;
    `);

    // Migration: add display_name column to existing tables
    try {
      this.db.exec(`ALTER TABLE bot_keys ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists — expected after first migration
    }
  }
}

export { BotKeyStore };
