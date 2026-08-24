import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import { normaliseBackendBaseUrl } from './tower-client';
import type { BackendConnectionGrantRecord, BackendConnectionRecord, WorkspaceSubscriptionRecord } from './types';

const DEFAULT_DB_PATH = databaseFile;

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseJsonValue<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function serialiseJsonValue(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

class BackendConnectionStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listForManagerNpub(npub: string): BackendConnectionRecord[] {
    return this.listWhere('managed_by_npub = ?1', [npub]);
  }

  listAvailableForManagerNpub(npub: string): BackendConnectionRecord[] {
    return this.db
      .query(
        `SELECT DISTINCT
           b.backend_connection_id, b.managed_by_npub, b.backend_base_url, b.service_npub,
           b.setup_workspace_owner_npub, b.setup_source_app_npub, b.setup_source_app_schema_namespace,
           b.setup_connection_token_ref, b.setup_capability_defaults_json,
           b.relay_urls_json, b.openapi_url, b.docs_url, b.health_url, b.supported_version,
           b.share_policy, b.health_status, b.last_health_result_json, b.created_at, b.updated_at
         FROM backend_connections b
         LEFT JOIN backend_connection_grants g
           ON g.backend_connection_id = b.backend_connection_id
          AND g.grant_kind = 'manager_npub'
          AND g.grantee_npub = ?1
          AND b.share_policy = 'selected_users'
         WHERE b.managed_by_npub = ?1
            OR g.grantee_npub = ?1
            OR b.share_policy = 'shared_service'
         ORDER BY b.updated_at DESC`,
      )
      .all(npub)
      .map((row) => this.mapRow(row as Record<string, string | null>));
  }

  getById(backendConnectionId: string): BackendConnectionRecord | null {
    return this.getWhere('backend_connection_id = ?1', [backendConnectionId]);
  }

  findReusable(input: {
    managedByNpub: string;
    backendBaseUrl: string;
    serviceNpub?: string | null;
  }): BackendConnectionRecord | null {
    if (input.serviceNpub) {
      const match = this.getWhere(
        'managed_by_npub = ?1 AND backend_base_url = ?2 AND service_npub = ?3',
        [input.managedByNpub, input.backendBaseUrl, input.serviceNpub],
      );
      if (match) {
        return match;
      }
    }
    return this.getWhere(
      'managed_by_npub = ?1 AND backend_base_url = ?2 AND service_npub IS NULL',
      [input.managedByNpub, input.backendBaseUrl],
    );
  }

  createDefault(input: {
    managedByNpub: string;
    backendBaseUrl: string;
    serviceNpub?: string | null;
    setupWorkspaceOwnerNpub?: string | null;
    setupSourceAppNpub?: string | null;
    setupSourceAppSchemaNamespace?: string | null;
    setupConnectionTokenRef?: string | null;
    setupCapabilityDefaults?: BackendConnectionRecord['setupCapabilityDefaults'];
    relayUrls?: string[];
    openapiUrl?: string | null;
    docsUrl?: string | null;
    healthUrl?: string | null;
    supportedVersion?: string | null;
  }): BackendConnectionRecord {
    const now = new Date().toISOString();
    return {
      backendConnectionId: randomUUID(),
      managedByNpub: input.managedByNpub,
      backendBaseUrl: input.backendBaseUrl,
      serviceNpub: input.serviceNpub ?? null,
      setupWorkspaceOwnerNpub: input.setupWorkspaceOwnerNpub ?? null,
      setupSourceAppNpub: input.setupSourceAppNpub ?? null,
      setupSourceAppSchemaNamespace: input.setupSourceAppSchemaNamespace ?? null,
      setupConnectionTokenRef: input.setupConnectionTokenRef ?? null,
      setupCapabilityDefaults: input.setupCapabilityDefaults ?? [],
      relayUrls: input.relayUrls ?? [],
      openapiUrl: input.openapiUrl ?? null,
      docsUrl: input.docsUrl ?? null,
      healthUrl: input.healthUrl ?? null,
      supportedVersion: input.supportedVersion ?? null,
      sharePolicy: 'private',
      healthStatus: 'degraded',
      lastHealthResult: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  save(record: BackendConnectionRecord): BackendConnectionRecord {
    this.db.query(
      `INSERT INTO backend_connections (
         backend_connection_id, managed_by_npub, backend_base_url, service_npub,
         setup_workspace_owner_npub, setup_source_app_npub, setup_source_app_schema_namespace,
         setup_connection_token_ref, setup_capability_defaults_json,
         relay_urls_json, openapi_url, docs_url, health_url, supported_version,
         share_policy, health_status, last_health_result_json, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4,
         ?5, ?6, ?7, ?8, ?9,
         ?10, ?11, ?12, ?13, ?14,
         ?15, ?16, ?17, ?18, ?19
       )
       ON CONFLICT(backend_connection_id) DO UPDATE SET
         managed_by_npub = excluded.managed_by_npub,
         backend_base_url = excluded.backend_base_url,
         service_npub = excluded.service_npub,
         setup_workspace_owner_npub = excluded.setup_workspace_owner_npub,
         setup_source_app_npub = excluded.setup_source_app_npub,
         setup_source_app_schema_namespace = excluded.setup_source_app_schema_namespace,
         setup_connection_token_ref = excluded.setup_connection_token_ref,
         setup_capability_defaults_json = excluded.setup_capability_defaults_json,
         relay_urls_json = excluded.relay_urls_json,
         openapi_url = excluded.openapi_url,
         docs_url = excluded.docs_url,
         health_url = excluded.health_url,
         supported_version = excluded.supported_version,
         share_policy = excluded.share_policy,
         health_status = excluded.health_status,
         last_health_result_json = excluded.last_health_result_json,
         updated_at = excluded.updated_at`,
    ).run(
      record.backendConnectionId,
      record.managedByNpub,
      record.backendBaseUrl,
      record.serviceNpub,
      record.setupWorkspaceOwnerNpub,
      record.setupSourceAppNpub,
      record.setupSourceAppSchemaNamespace,
      record.setupConnectionTokenRef,
      serialiseJsonValue(record.setupCapabilityDefaults ?? []),
      serialiseJsonValue(record.relayUrls),
      record.openapiUrl,
      record.docsUrl,
      record.healthUrl,
      record.supportedVersion,
      record.sharePolicy,
      record.healthStatus,
      serialiseJsonValue(record.lastHealthResult),
      record.createdAt,
      record.updatedAt,
    );
    return this.getById(record.backendConnectionId) ?? record;
  }

  backfillFromLegacySubscription(subscription: WorkspaceSubscriptionRecord): BackendConnectionRecord | null {
    if (subscription.backendConnectionId || !subscription.managedByNpub || !subscription.backendBaseUrl) {
      return null;
    }

    const backendBaseUrl = normaliseBackendBaseUrl(subscription.backendBaseUrl);
    const existing = this.findReusable({
      managedByNpub: subscription.managedByNpub,
      backendBaseUrl,
      serviceNpub: null,
    });
    const baseRecord = existing ?? this.createDefault({
      managedByNpub: subscription.managedByNpub,
      backendBaseUrl,
    });
    return this.save({
      ...baseRecord,
      backendBaseUrl,
      setupWorkspaceOwnerNpub: baseRecord.setupWorkspaceOwnerNpub ?? subscription.workspaceOwnerNpub,
      setupSourceAppNpub: baseRecord.setupSourceAppNpub ?? subscription.sourceAppNpub,
      setupSourceAppSchemaNamespace: baseRecord.setupSourceAppSchemaNamespace ?? subscription.sourceAppSchemaNamespace ?? null,
      setupConnectionTokenRef: baseRecord.setupConnectionTokenRef ?? subscription.connectionTokenRef ?? null,
      setupCapabilityDefaults: baseRecord.setupCapabilityDefaults.length > 0
        ? baseRecord.setupCapabilityDefaults
        : subscription.capabilityDefaults ?? [],
      healthStatus: subscription.healthStatus,
      lastHealthResult: baseRecord.lastHealthResult ?? subscription.lastAuthResult ?? subscription.lastRecordPullResult ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  listGrants(backendConnectionId: string): BackendConnectionGrantRecord[] {
    return this.db
      .query(
        `SELECT backend_connection_id, grant_kind, grantee_npub, created_at, updated_at
         FROM backend_connection_grants
         WHERE backend_connection_id = ?1
         ORDER BY grant_kind ASC, grantee_npub ASC`,
      )
      .all(backendConnectionId)
      .map((row) => this.mapGrantRow(row as Record<string, string | null>));
  }

  grantToManager(backendConnectionId: string, granteeNpub: string): BackendConnectionGrantRecord {
    return this.saveGrant({
      backendConnectionId,
      grantKind: 'manager_npub',
      granteeNpub,
    });
  }

  grantToSharedService(backendConnectionId: string): BackendConnectionGrantRecord {
    return this.saveGrant({
      backendConnectionId,
      grantKind: 'shared_service',
      granteeNpub: null,
    });
  }

  replaceAvailabilityGrants(input: {
    backendConnectionId: string;
    managerNpubs?: string[];
    sharedService?: boolean;
  }): BackendConnectionGrantRecord[] {
    const managerNpubs = Array.from(new Set((input.managerNpubs ?? [])
      .map((npub) => npub.trim())
      .filter((npub) => npub.length > 0)));
    this.db
      .query('DELETE FROM backend_connection_grants WHERE backend_connection_id = ?1')
      .run(input.backendConnectionId);
    for (const granteeNpub of managerNpubs) {
      this.grantToManager(input.backendConnectionId, granteeNpub);
    }
    if (input.sharedService) {
      this.grantToSharedService(input.backendConnectionId);
    }
    const record = this.getById(input.backendConnectionId);
    if (record) {
      this.save({
        ...record,
        sharePolicy: input.sharedService
          ? 'shared_service'
          : managerNpubs.length > 0
            ? 'selected_users'
            : 'private',
        updatedAt: new Date().toISOString(),
      });
    }
    return this.listGrants(input.backendConnectionId);
  }

  hasManagerGrant(backendConnectionId: string, granteeNpub: string): boolean {
    const row = this.db
      .query(
        `SELECT 1
         FROM backend_connection_grants
         WHERE backend_connection_id = ?1
           AND grant_kind = 'manager_npub'
           AND grantee_npub = ?2
         LIMIT 1`,
      )
      .get(backendConnectionId, granteeNpub);
    return Boolean(row);
  }

  hasSharedServiceGrant(backendConnectionId: string): boolean {
    const row = this.db
      .query(
        `SELECT 1
         FROM backend_connection_grants
         WHERE backend_connection_id = ?1
           AND grant_kind = 'shared_service'
         LIMIT 1`,
      )
      .get(backendConnectionId);
    return Boolean(row);
  }

  private saveGrant(input: {
    backendConnectionId: string;
    grantKind: BackendConnectionGrantRecord['grantKind'];
    granteeNpub: string | null;
  }): BackendConnectionGrantRecord {
    const now = new Date().toISOString();
    this.db.query(
      `INSERT INTO backend_connection_grants (
         backend_connection_id, grant_kind, grantee_npub, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5
       )
       ON CONFLICT(backend_connection_id, grant_kind, grantee_npub) DO UPDATE SET
         updated_at = excluded.updated_at`,
    ).run(
      input.backendConnectionId,
      input.grantKind,
      input.granteeNpub ?? '',
      now,
      now,
    );
    return {
      backendConnectionId: input.backendConnectionId,
      grantKind: input.grantKind,
      granteeNpub: input.grantKind === 'shared_service' ? null : input.granteeNpub,
      createdAt: now,
      updatedAt: now,
    };
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): BackendConnectionRecord[] {
    return this.db
      .query(
        `SELECT
           backend_connection_id, managed_by_npub, backend_base_url, service_npub,
           setup_workspace_owner_npub, setup_source_app_npub, setup_source_app_schema_namespace,
           setup_connection_token_ref, setup_capability_defaults_json,
           relay_urls_json, openapi_url, docs_url, health_url, supported_version,
           share_policy, health_status, last_health_result_json, created_at, updated_at
         FROM backend_connections
         WHERE ${whereClause}
         ORDER BY updated_at DESC`,
      )
      .all(...args)
      .map((row) => this.mapRow(row as Record<string, string | null>));
  }

  private getWhere(whereClause: string, args: SQLQueryBindings[]): BackendConnectionRecord | null {
    const row = this.db
      .query(
        `SELECT
           backend_connection_id, managed_by_npub, backend_base_url, service_npub,
           setup_workspace_owner_npub, setup_source_app_npub, setup_source_app_schema_namespace,
           setup_connection_token_ref, setup_capability_defaults_json,
           relay_urls_json, openapi_url, docs_url, health_url, supported_version,
           share_policy, health_status, last_health_result_json, created_at, updated_at
         FROM backend_connections
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(...args) as Record<string, string | null> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, string | null>): BackendConnectionRecord {
    return {
      backendConnectionId: row.backend_connection_id!,
      managedByNpub: row.managed_by_npub!,
      backendBaseUrl: row.backend_base_url!,
      serviceNpub: row.service_npub ?? null,
      setupWorkspaceOwnerNpub: row.setup_workspace_owner_npub ?? null,
      setupSourceAppNpub: row.setup_source_app_npub ?? null,
      setupSourceAppSchemaNamespace: row.setup_source_app_schema_namespace ?? null,
      setupConnectionTokenRef: row.setup_connection_token_ref ?? null,
      setupCapabilityDefaults: parseJsonArray(row.setup_capability_defaults_json ?? null) as BackendConnectionRecord['setupCapabilityDefaults'],
      relayUrls: parseJsonArray(row.relay_urls_json ?? null),
      openapiUrl: row.openapi_url ?? null,
      docsUrl: row.docs_url ?? null,
      healthUrl: row.health_url ?? null,
      supportedVersion: row.supported_version ?? null,
      sharePolicy: row.share_policy as BackendConnectionRecord['sharePolicy'],
      healthStatus: row.health_status as BackendConnectionRecord['healthStatus'],
      lastHealthResult: parseJsonValue(row.last_health_result_json ?? null),
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    };
  }

  private mapGrantRow(row: Record<string, string | null>): BackendConnectionGrantRecord {
    const grantKind = row.grant_kind as BackendConnectionGrantRecord['grantKind'];
    return {
      backendConnectionId: row.backend_connection_id!,
      grantKind,
      granteeNpub: grantKind === 'shared_service' ? null : row.grantee_npub ?? null,
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    };
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backend_connections (
        backend_connection_id TEXT PRIMARY KEY,
        managed_by_npub TEXT NOT NULL,
        backend_base_url TEXT NOT NULL,
        service_npub TEXT,
        setup_workspace_owner_npub TEXT,
        setup_source_app_npub TEXT,
        setup_source_app_schema_namespace TEXT,
        setup_connection_token_ref TEXT,
        setup_capability_defaults_json TEXT,
        relay_urls_json TEXT,
        openapi_url TEXT,
        docs_url TEXT,
        health_url TEXT,
        supported_version TEXT,
        share_policy TEXT NOT NULL,
        health_status TEXT NOT NULL,
        last_health_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_backend_connections_manager
        ON backend_connections(managed_by_npub, updated_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_connections_manager_service
        ON backend_connections(managed_by_npub, backend_base_url, service_npub);

      CREATE TABLE IF NOT EXISTS backend_connection_grants (
        backend_connection_id TEXT NOT NULL,
        grant_kind TEXT NOT NULL,
        grantee_npub TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (backend_connection_id, grant_kind, grantee_npub),
        FOREIGN KEY (backend_connection_id)
          REFERENCES backend_connections(backend_connection_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_backend_connection_grants_grantee
        ON backend_connection_grants(grantee_npub, backend_connection_id);
    `);
    if (!hasColumn(this.db, 'backend_connections', 'setup_workspace_owner_npub')) {
      this.db.exec('ALTER TABLE backend_connections ADD COLUMN setup_workspace_owner_npub TEXT');
    }
    if (!hasColumn(this.db, 'backend_connections', 'setup_source_app_npub')) {
      this.db.exec('ALTER TABLE backend_connections ADD COLUMN setup_source_app_npub TEXT');
    }
    if (!hasColumn(this.db, 'backend_connections', 'setup_source_app_schema_namespace')) {
      this.db.exec('ALTER TABLE backend_connections ADD COLUMN setup_source_app_schema_namespace TEXT');
    }
    if (!hasColumn(this.db, 'backend_connections', 'setup_connection_token_ref')) {
      this.db.exec('ALTER TABLE backend_connections ADD COLUMN setup_connection_token_ref TEXT');
    }
    if (!hasColumn(this.db, 'backend_connections', 'setup_capability_defaults_json')) {
      this.db.exec('ALTER TABLE backend_connections ADD COLUMN setup_capability_defaults_json TEXT');
    }
  }
}

export const backendConnectionStore = new BackendConnectionStore();
export { BackendConnectionStore };
