import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import type {
  DelegationBillingMode,
  DelegationResourceFilters,
  WorkspaceDelegationPayload,
} from "../auth/delegation-payload";
import { normaliseNpub } from "../identity/npub-utils";

const DEFAULT_DB_PATH = new URL("../../data/workspace-delegations.db", import.meta.url).pathname;

export interface WorkspaceDelegationRecord {
  id: string;
  ownerNpub: string;
  delegateNpub: string;
  scopes: string[];
  resourceFilters: DelegationResourceFilters | null;
  billingMode: DelegationBillingMode;
  spendLimitSats: number | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  signedPayload: string;
  signature: string;
  eventId: string | null;
  createdBy: string;
}

interface CreateWorkspaceDelegationInput {
  payload: WorkspaceDelegationPayload;
  signedPayload: string;
  signature: string;
  eventId?: string | null;
  createdBy: string;
  id?: string;
}

type DelegationRow = {
  id: string;
  ownerNpub: string;
  delegateNpub: string;
  scopes: string;
  resourceFilters: string | null;
  billingMode: string;
  spendLimitSats: number | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  signedPayload: string;
  signature: string;
  eventId: string | null;
  createdBy: string;
};

function parseScopes(input: string | null | undefined): string[] {
  if (!input) {
    return [];
  }
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function parseResourceFilters(input: string | null | undefined): DelegationResourceFilters | null {
  if (!input) {
    return null;
  }
  try {
    const parsed = JSON.parse(input) as DelegationResourceFilters | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function toRecord(row: DelegationRow | null | undefined): WorkspaceDelegationRecord | null {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    ownerNpub: row.ownerNpub,
    delegateNpub: row.delegateNpub,
    scopes: parseScopes(row.scopes),
    resourceFilters: parseResourceFilters(row.resourceFilters),
    billingMode:
      row.billingMode === "owner" || row.billingMode === "shared" ? row.billingMode : "delegate",
    spendLimitSats: typeof row.spendLimitSats === "number" ? row.spendLimitSats : null,
    createdAt: row.createdAt,
    expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : null,
    revokedAt: typeof row.revokedAt === "number" ? row.revokedAt : null,
    signedPayload: row.signedPayload,
    signature: row.signature,
    eventId: row.eventId ?? null,
    createdBy: row.createdBy,
  };
}

class WorkspaceDelegationStore {
  private readonly db: Database;

  constructor(filePath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_delegations (
        id TEXT PRIMARY KEY,
        owner_npub TEXT NOT NULL,
        delegate_npub TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource_filters TEXT,
        billing_mode TEXT NOT NULL DEFAULT 'delegate',
        spend_limit_sats INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        signed_payload TEXT NOT NULL,
        signature TEXT NOT NULL,
        event_id TEXT,
        created_by TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_delegations_owner
        ON workspace_delegations(owner_npub);
      CREATE INDEX IF NOT EXISTS idx_workspace_delegations_delegate
        ON workspace_delegations(delegate_npub);
      CREATE INDEX IF NOT EXISTS idx_workspace_delegations_owner_delegate
        ON workspace_delegations(owner_npub, delegate_npub);
      CREATE INDEX IF NOT EXISTS idx_workspace_delegations_expires_at
        ON workspace_delegations(expires_at);
    `);
  }

  createDelegation(input: CreateWorkspaceDelegationInput): WorkspaceDelegationRecord {
    const id = input.id ?? randomUUID();
    const ownerNpub = normaliseNpub(input.payload.ownerNpub);
    const delegateNpub = normaliseNpub(input.payload.delegateNpub);
    const createdBy = normaliseNpub(input.createdBy);
    if (!ownerNpub || !delegateNpub || !createdBy) {
      throw new Error("Delegation owner, delegate, and creator are required");
    }
    this.db
      .query(
        `INSERT INTO workspace_delegations (
           id,
           owner_npub,
           delegate_npub,
           scopes,
           resource_filters,
           billing_mode,
           spend_limit_sats,
           created_at,
           expires_at,
           revoked_at,
           signed_payload,
           signature,
           event_id,
           created_by
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13)`,
      )
      .run(
        id,
        ownerNpub,
        delegateNpub,
        JSON.stringify(input.payload.scopes),
        input.payload.resourceFilters ? JSON.stringify(input.payload.resourceFilters) : null,
        input.payload.billingMode,
        input.payload.spendLimitSats,
        input.payload.createdAt,
        input.payload.expiresAt,
        input.signedPayload,
        input.signature,
        input.eventId ?? null,
        createdBy,
      );

    const created = this.getDelegationById(id);
    if (!created) {
      throw new Error("Failed to create workspace delegation");
    }
    return created;
  }

  getDelegationById(id: string): WorkspaceDelegationRecord | null {
    const row = this.db
      .query<DelegationRow, [string]>(
        `SELECT
           id,
           owner_npub AS ownerNpub,
           delegate_npub AS delegateNpub,
           scopes,
           resource_filters AS resourceFilters,
           billing_mode AS billingMode,
           spend_limit_sats AS spendLimitSats,
           created_at AS createdAt,
           expires_at AS expiresAt,
           revoked_at AS revokedAt,
           signed_payload AS signedPayload,
           signature,
           event_id AS eventId,
           created_by AS createdBy
         FROM workspace_delegations
         WHERE id = ?1`,
      )
      .get(id);
    return toRecord(row);
  }

  listDelegationsForOwner(ownerNpub: string): WorkspaceDelegationRecord[] {
    const normalizedOwner = normaliseNpub(ownerNpub);
    if (!normalizedOwner) {
      return [];
    }
    const rows = this.db
      .query<DelegationRow, [string]>(
        `SELECT
           id,
           owner_npub AS ownerNpub,
           delegate_npub AS delegateNpub,
           scopes,
           resource_filters AS resourceFilters,
           billing_mode AS billingMode,
           spend_limit_sats AS spendLimitSats,
           created_at AS createdAt,
           expires_at AS expiresAt,
           revoked_at AS revokedAt,
           signed_payload AS signedPayload,
           signature,
           event_id AS eventId,
           created_by AS createdBy
         FROM workspace_delegations
         WHERE owner_npub = ?1
         ORDER BY created_at DESC`,
      )
      .all(normalizedOwner);
    return rows.map((row) => toRecord(row)).filter((row): row is WorkspaceDelegationRecord => Boolean(row));
  }

  listDelegationsForDelegate(delegateNpub: string): WorkspaceDelegationRecord[] {
    const normalizedDelegate = normaliseNpub(delegateNpub);
    if (!normalizedDelegate) {
      return [];
    }
    const rows = this.db
      .query<DelegationRow, [string]>(
        `SELECT
           id,
           owner_npub AS ownerNpub,
           delegate_npub AS delegateNpub,
           scopes,
           resource_filters AS resourceFilters,
           billing_mode AS billingMode,
           spend_limit_sats AS spendLimitSats,
           created_at AS createdAt,
           expires_at AS expiresAt,
           revoked_at AS revokedAt,
           signed_payload AS signedPayload,
           signature,
           event_id AS eventId,
           created_by AS createdBy
         FROM workspace_delegations
         WHERE delegate_npub = ?1
         ORDER BY created_at DESC`,
      )
      .all(normalizedDelegate);
    return rows.map((row) => toRecord(row)).filter((row): row is WorkspaceDelegationRecord => Boolean(row));
  }

  listDelegationsVisibleTo(npub: string): WorkspaceDelegationRecord[] {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      return [];
    }
    const rows = this.db
      .query<DelegationRow, [string, string]>(
        `SELECT
           id,
           owner_npub AS ownerNpub,
           delegate_npub AS delegateNpub,
           scopes,
           resource_filters AS resourceFilters,
           billing_mode AS billingMode,
           spend_limit_sats AS spendLimitSats,
           created_at AS createdAt,
           expires_at AS expiresAt,
           revoked_at AS revokedAt,
           signed_payload AS signedPayload,
           signature,
           event_id AS eventId,
           created_by AS createdBy
         FROM workspace_delegations
         WHERE owner_npub = ?1 OR delegate_npub = ?2
         ORDER BY created_at DESC`,
      )
      .all(normalized, normalized);
    return rows.map((row) => toRecord(row)).filter((row): row is WorkspaceDelegationRecord => Boolean(row));
  }

  findActiveDelegation(
    ownerNpub: string,
    delegateNpub: string,
    scope?: string,
  ): WorkspaceDelegationRecord | null {
    const normalizedOwner = normaliseNpub(ownerNpub);
    const normalizedDelegate = normaliseNpub(delegateNpub);
    if (!normalizedOwner || !normalizedDelegate) {
      return null;
    }
    const now = Date.now();
    const rows = this.db
      .query<DelegationRow, [string, string, number]>(
        `SELECT
           id,
           owner_npub AS ownerNpub,
           delegate_npub AS delegateNpub,
           scopes,
           resource_filters AS resourceFilters,
           billing_mode AS billingMode,
           spend_limit_sats AS spendLimitSats,
           created_at AS createdAt,
           expires_at AS expiresAt,
           revoked_at AS revokedAt,
           signed_payload AS signedPayload,
           signature,
           event_id AS eventId,
           created_by AS createdBy
         FROM workspace_delegations
         WHERE owner_npub = ?1
           AND delegate_npub = ?2
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?3)
         ORDER BY created_at DESC`,
      )
      .all(normalizedOwner, normalizedDelegate, now);
    const records = rows
      .map((row) => toRecord(row))
      .filter((row): row is WorkspaceDelegationRecord => Boolean(row));
    if (!scope) {
      return records[0] ?? null;
    }
    return records.find((record) => record.scopes.includes(scope)) ?? null;
  }

  revokeDelegation(id: string): boolean {
    const result = this.db
      .query(
        `UPDATE workspace_delegations
         SET revoked_at = ?2
         WHERE id = ?1 AND revoked_at IS NULL`,
      )
      .run(id, Date.now());
    return result.changes > 0;
  }
}

export { WorkspaceDelegationStore };
