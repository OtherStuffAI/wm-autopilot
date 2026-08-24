/**
 * NIP-98 Grants Store
 *
 * SQLite store for Tier 2 user-delegation grants.
 * Follows the CaproverStore pattern — shared database file, class-based API.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";
import type { EndpointPattern, Nip98Grant, SignerType } from "./types";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateGrantInput {
  domain: string;
  userNpub: string;
  sessionId?: string | null;
  signerType: SignerType;
  durationHours: number;
  reason: string;
  endpoints?: EndpointPattern[] | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class Nip98GrantStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  /** Create a new grant. Returns the persisted record. */
  createGrant(input: CreateGrantInput): Nip98Grant {
    const id = randomUUID();
    const now = Date.now();
    const expiresAt = now + input.durationHours * 60 * 60 * 1000;

    this.db
      .query(
        `INSERT INTO nip98_grants (
           id, domain, user_npub, session_id, signer_type,
           granted_at, expires_at, reason, endpoints
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .run(
        id,
        input.domain,
        input.userNpub,
        input.sessionId ?? null,
        input.signerType,
        now,
        expiresAt,
        input.reason,
        input.endpoints ? JSON.stringify(input.endpoints) : null,
      );

    const created = this.getGrant(id);
    if (!created) {
      throw new Error("Failed to create NIP-98 grant");
    }
    return created;
  }

  /** Retrieve a single grant by ID. */
  getGrant(id: string): Nip98Grant | null {
    const row = this.db
      .query<GrantRow, [string]>(
        `SELECT id, domain, user_npub, session_id, signer_type,
                granted_at, expires_at, reason, endpoints
         FROM nip98_grants
         WHERE id = ?1`,
      )
      .get(id);
    return row ? rowToGrant(row) : null;
  }

  /**
   * Find an active (non-expired) grant for a domain + user.
   * Optionally scoped to a specific session.
   */
  findActiveGrant(
    domain: string,
    userNpub: string,
    sessionId?: string,
  ): Nip98Grant | null {
    const now = Date.now();

    // Try session-specific grant first, then any-session grant.
    if (sessionId) {
      const sessionRow = this.db
        .query<GrantRow, [string, string, string, number]>(
          `SELECT id, domain, user_npub, session_id, signer_type,
                  granted_at, expires_at, reason, endpoints
           FROM nip98_grants
           WHERE domain = ?1 AND user_npub = ?2 AND session_id = ?3
             AND expires_at > ?4
           ORDER BY expires_at DESC
           LIMIT 1`,
        )
        .get(domain, userNpub, sessionId, now);
      if (sessionRow) return rowToGrant(sessionRow);
    }

    // Fall back to user-wide grant (session_id IS NULL).
    const row = this.db
      .query<GrantRow, [string, string, number]>(
        `SELECT id, domain, user_npub, session_id, signer_type,
                granted_at, expires_at, reason, endpoints
         FROM nip98_grants
         WHERE domain = ?1 AND user_npub = ?2 AND session_id IS NULL
           AND expires_at > ?3
         ORDER BY expires_at DESC
         LIMIT 1`,
      )
      .get(domain, userNpub, now);
    return row ? rowToGrant(row) : null;
  }

  /** List all active grants for a user. */
  listActiveGrants(userNpub: string): Nip98Grant[] {
    const now = Date.now();
    const rows = this.db
      .query<GrantRow, [string, number]>(
        `SELECT id, domain, user_npub, session_id, signer_type,
                granted_at, expires_at, reason, endpoints
         FROM nip98_grants
         WHERE user_npub = ?1 AND expires_at > ?2
         ORDER BY expires_at DESC`,
      )
      .all(userNpub, now);
    return rows.map(rowToGrant);
  }

  /** List active grants visible to a specific session. */
  listGrantsForSession(sessionId: string, userNpub: string): Nip98Grant[] {
    const now = Date.now();
    const rows = this.db
      .query<GrantRow, [string, string, number]>(
        `SELECT id, domain, user_npub, session_id, signer_type,
                granted_at, expires_at, reason, endpoints
         FROM nip98_grants
         WHERE user_npub = ?1
           AND (session_id = ?2 OR session_id IS NULL)
           AND expires_at > ?3
         ORDER BY expires_at DESC`,
      )
      .all(userNpub, sessionId, now);
    return rows.map(rowToGrant);
  }

  /** Revoke (delete) a grant. Returns true if a row was removed. */
  revokeGrant(id: string): boolean {
    const result = this.db
      .query("DELETE FROM nip98_grants WHERE id = ?1")
      .run(id);
    return result.changes > 0;
  }

  /** Remove all expired grants. Returns the number of rows purged. */
  purgeExpired(): number {
    const now = Date.now();
    const result = this.db
      .query("DELETE FROM nip98_grants WHERE expires_at <= ?1")
      .run(now);
    return result.changes;
  }

  // ----------------------------------------------------------
  // Schema
  // ----------------------------------------------------------

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nip98_grants (
        id           TEXT PRIMARY KEY,
        domain       TEXT NOT NULL,
        user_npub    TEXT NOT NULL,
        session_id   TEXT,
        signer_type  TEXT NOT NULL DEFAULT 'ephemeral',
        granted_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        reason       TEXT NOT NULL DEFAULT '',
        endpoints    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_nip98_grants_domain
        ON nip98_grants(domain);
      CREATE INDEX IF NOT EXISTS idx_nip98_grants_user
        ON nip98_grants(user_npub);
      CREATE INDEX IF NOT EXISTS idx_nip98_grants_expires
        ON nip98_grants(expires_at);
    `);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GrantRow {
  id: string;
  domain: string;
  user_npub: string;
  session_id: string | null;
  signer_type: string;
  granted_at: number;
  expires_at: number;
  reason: string;
  endpoints: string | null;
}

function rowToGrant(row: GrantRow): Nip98Grant {
  return {
    id: row.id,
    domain: row.domain,
    userNpub: row.user_npub,
    sessionId: row.session_id,
    signerType: row.signer_type as SignerType,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    reason: row.reason,
    endpoints: row.endpoints ? JSON.parse(row.endpoints) : null,
  };
}

export { Nip98GrantStore };
