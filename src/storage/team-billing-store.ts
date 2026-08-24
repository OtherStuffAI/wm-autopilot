import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

export type BillingMode = "subscription" | "credits";

export interface TeamBillingConfig {
  teamUuid: string;
  externalTeamId: string | null;
  useCredits: boolean;
  baseAllocationUsdCents: number;
  perMemberUsdCents: number;
  markupBps: number;
  updatedAt: string;
}

export interface TeamProviderKeyRecord {
  id: string;
  provider: string;
  keyHash: string | null;
  encryptedValue: string;
  iv: string;
  authTag: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageLedgerRecord {
  id: string;
  sessionId: string | null;
  npub: string | null;
  agent: string | null;
  endpoint: string;
  method: string;
  statusCode: number | null;
  provider: string;
  providerRequestId: string | null;
  upstreamCostMicrosUsd: number;
  wingmanCostMicrosUsd: number;
  createdAt: string;
}

export interface UsageLedgerInput {
  sessionId?: string | null;
  npub?: string | null;
  agent?: string | null;
  endpoint: string;
  method: string;
  statusCode?: number | null;
  provider?: string;
  providerRequestId?: string | null;
  upstreamCostMicrosUsd: number;
  wingmanCostMicrosUsd: number;
}

const DEFAULT_DB_PATH = new URL("../../data/team-billing.db", import.meta.url).pathname;
const CONFIG_ROW_ID = 1;

const DEFAULT_BASE_ALLOCATION_USD_CENTS = 5_000;
const DEFAULT_PER_MEMBER_USD_CENTS = 1_000;
const DEFAULT_MARKUP_BPS = 2_100;

const clampNonNegativeInt = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
};

export class TeamBillingStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
    this.ensureDefaultConfig();
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_billing_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        team_uuid TEXT NOT NULL,
        external_team_id TEXT,
        use_credits INTEGER NOT NULL DEFAULT 0,
        base_allocation_usd_cents INTEGER NOT NULL DEFAULT ${DEFAULT_BASE_ALLOCATION_USD_CENTS},
        per_member_usd_cents INTEGER NOT NULL DEFAULT ${DEFAULT_PER_MEMBER_USD_CENTS},
        markup_bps INTEGER NOT NULL DEFAULT ${DEFAULT_MARKUP_BPS},
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_members (
        normalized_npub TEXT PRIMARY KEY,
        npub TEXT NOT NULL,
        added_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_provider_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        key_hash TEXT,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_team_provider_keys_active
        ON team_provider_keys(provider) WHERE is_active = 1;

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        npub TEXT,
        agent TEXT,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        status_code INTEGER,
        provider TEXT NOT NULL,
        provider_request_id TEXT,
        upstream_cost_micros_usd INTEGER NOT NULL,
        wingman_cost_micros_usd INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_ledger_created_at
        ON usage_ledger(created_at DESC);
    `);
  }

  private ensureDefaultConfig() {
    const existing = this.db
      .query<{ id: number }, []>("SELECT id FROM team_billing_config WHERE id = 1")
      .get();
    if (existing) return;
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO team_billing_config
         (id, team_uuid, external_team_id, use_credits, base_allocation_usd_cents, per_member_usd_cents, markup_bps, updated_at)
         VALUES (?1, ?2, NULL, 0, ?3, ?4, ?5, ?6)`,
      )
      .run(
        CONFIG_ROW_ID,
        randomUUID(),
        DEFAULT_BASE_ALLOCATION_USD_CENTS,
        DEFAULT_PER_MEMBER_USD_CENTS,
        DEFAULT_MARKUP_BPS,
        now,
      );
  }

  getConfig(): TeamBillingConfig {
    this.ensureDefaultConfig();
    const row = this.db
      .query<{
        teamUuid: string;
        externalTeamId: string | null;
        useCredits: number;
        baseAllocationUsdCents: number;
        perMemberUsdCents: number;
        markupBps: number;
        updatedAt: string;
      }, []>(
        `SELECT
           team_uuid AS teamUuid,
           external_team_id AS externalTeamId,
           use_credits AS useCredits,
           base_allocation_usd_cents AS baseAllocationUsdCents,
           per_member_usd_cents AS perMemberUsdCents,
           markup_bps AS markupBps,
           updated_at AS updatedAt
         FROM team_billing_config
         WHERE id = 1`,
      )
      .get();
    if (!row) {
      throw new Error("Failed to load team billing config");
    }
    return {
      teamUuid: row.teamUuid,
      externalTeamId: row.externalTeamId,
      useCredits: row.useCredits === 1,
      baseAllocationUsdCents: clampNonNegativeInt(row.baseAllocationUsdCents, DEFAULT_BASE_ALLOCATION_USD_CENTS),
      perMemberUsdCents: clampNonNegativeInt(row.perMemberUsdCents, DEFAULT_PER_MEMBER_USD_CENTS),
      markupBps: clampNonNegativeInt(row.markupBps, DEFAULT_MARKUP_BPS),
      updatedAt: row.updatedAt,
    };
  }

  updateConfig(
    patch: Partial<{
      externalTeamId: string | null;
      useCredits: boolean;
      baseAllocationUsdCents: number;
      perMemberUsdCents: number;
      markupBps: number;
    }>,
  ): TeamBillingConfig {
    const current = this.getConfig();
    const next = {
      externalTeamId:
        typeof patch.externalTeamId === "string"
          ? patch.externalTeamId.trim() || null
          : patch.externalTeamId === null
            ? null
            : current.externalTeamId,
      useCredits:
        typeof patch.useCredits === "boolean" ? patch.useCredits : current.useCredits,
      baseAllocationUsdCents:
        typeof patch.baseAllocationUsdCents === "number"
          ? clampNonNegativeInt(patch.baseAllocationUsdCents, current.baseAllocationUsdCents)
          : current.baseAllocationUsdCents,
      perMemberUsdCents:
        typeof patch.perMemberUsdCents === "number"
          ? clampNonNegativeInt(patch.perMemberUsdCents, current.perMemberUsdCents)
          : current.perMemberUsdCents,
      markupBps:
        typeof patch.markupBps === "number"
          ? clampNonNegativeInt(patch.markupBps, current.markupBps)
          : current.markupBps,
    };
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE team_billing_config
         SET external_team_id = ?1,
             use_credits = ?2,
             base_allocation_usd_cents = ?3,
             per_member_usd_cents = ?4,
             markup_bps = ?5,
             updated_at = ?6
         WHERE id = 1`,
      )
      .run(
        next.externalTeamId,
        next.useCredits ? 1 : 0,
        next.baseAllocationUsdCents,
        next.perMemberUsdCents,
        next.markupBps,
        now,
      );
    return this.getConfig();
  }

  upsertMember(normalizedNpub: string, npub: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO team_members (normalized_npub, npub, added_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(normalized_npub) DO UPDATE SET npub = excluded.npub`,
      )
      .run(normalizedNpub, npub, now);
  }

  listMembers(): Array<{ normalizedNpub: string; npub: string; addedAt: string }> {
    return this.db
      .query<{ normalizedNpub: string; npub: string; addedAt: string }, []>(
        `SELECT
           normalized_npub AS normalizedNpub,
           npub,
           added_at AS addedAt
         FROM team_members
         ORDER BY added_at ASC`,
      )
      .all();
  }

  getMemberCount(): number {
    const row = this.db.query<{ count: number }, []>("SELECT COUNT(1) AS count FROM team_members").get();
    return clampNonNegativeInt(row?.count, 0);
  }

  setActiveProviderKey(input: {
    provider: string;
    keyHash?: string | null;
    encryptedValue: string;
    iv: string;
    authTag: string;
  }): TeamProviderKeyRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const provider = input.provider.trim().toLowerCase();

    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE team_provider_keys SET is_active = 0, updated_at = ?2 WHERE provider = ?1 AND is_active = 1")
        .run(provider, now);
      this.db
        .query(
          `INSERT INTO team_provider_keys
           (id, provider, key_hash, encrypted_value, iv, auth_tag, is_active, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)`,
        )
        .run(
          id,
          provider,
          input.keyHash ?? null,
          input.encryptedValue,
          input.iv,
          input.authTag,
          now,
          now,
        );
    });
    tx();
    const created = this.getActiveProviderKey(provider);
    if (!created) {
      throw new Error("Failed to activate provider key");
    }
    return created;
  }

  getActiveProviderKey(provider: string): TeamProviderKeyRecord | null {
    const normalized = provider.trim().toLowerCase();
    const row = this.db
      .query<TeamProviderKeyRecord, [string]>(
        `SELECT
           id,
           provider,
           key_hash AS keyHash,
           encrypted_value AS encryptedValue,
           iv,
           auth_tag AS authTag,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM team_provider_keys
         WHERE provider = ?1
           AND is_active = 1`,
      )
      .get(normalized);
    return row ?? null;
  }

  appendUsage(input: UsageLedgerInput): UsageLedgerRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const provider = (input.provider ?? "openrouter").trim().toLowerCase() || "openrouter";
    const method = input.method.trim().toUpperCase();
    const endpoint = input.endpoint.trim();
    const statusCode =
      typeof input.statusCode === "number" && Number.isFinite(input.statusCode)
        ? Math.trunc(input.statusCode)
        : null;
    const upstreamCost = clampNonNegativeInt(input.upstreamCostMicrosUsd, 0);
    const wingmanCost = clampNonNegativeInt(input.wingmanCostMicrosUsd, 0);

    this.db
      .query(
        `INSERT INTO usage_ledger
         (id, session_id, npub, agent, endpoint, method, status_code, provider, provider_request_id, upstream_cost_micros_usd, wingman_cost_micros_usd, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .run(
        id,
        input.sessionId ?? null,
        input.npub ?? null,
        input.agent ?? null,
        endpoint,
        method,
        statusCode,
        provider,
        input.providerRequestId ?? null,
        upstreamCost,
        wingmanCost,
        now,
      );

    return {
      id,
      sessionId: input.sessionId ?? null,
      npub: input.npub ?? null,
      agent: input.agent ?? null,
      endpoint,
      method,
      statusCode,
      provider,
      providerRequestId: input.providerRequestId ?? null,
      upstreamCostMicrosUsd: upstreamCost,
      wingmanCostMicrosUsd: wingmanCost,
      createdAt: now,
    };
  }

  listRecentUsage(limit = 100): UsageLedgerRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    return this.db
      .query<UsageLedgerRecord, [number]>(
        `SELECT
           id,
           session_id AS sessionId,
           npub,
           agent,
           endpoint,
           method,
           status_code AS statusCode,
           provider,
           provider_request_id AS providerRequestId,
           upstream_cost_micros_usd AS upstreamCostMicrosUsd,
           wingman_cost_micros_usd AS wingmanCostMicrosUsd,
           created_at AS createdAt
         FROM usage_ledger
         ORDER BY created_at DESC
         LIMIT ?1`,
      )
      .all(safeLimit);
  }
}

export const teamBillingStore = new TeamBillingStore();
