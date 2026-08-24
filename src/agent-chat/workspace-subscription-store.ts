import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import type { WorkspaceSubscriptionRecord } from './types';

const DEFAULT_DB_PATH = databaseFile;

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

function parseJsonArray(value: string | null): string[] {
  const parsed = parseJsonValue<unknown>(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

class WorkspaceSubscriptionStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listForManagerNpub(npub: string): WorkspaceSubscriptionRecord[] {
    return this.listWhere('managed_by_npub = ?1', [npub]);
  }

  listLegacyDirectSubscriptions(): WorkspaceSubscriptionRecord[] {
    return this.listWhere(
      'backend_connection_id IS NULL AND managed_by_npub IS NOT NULL',
      [],
    );
  }

  listStartupCandidates(): WorkspaceSubscriptionRecord[] {
    return this.listWhere(
      `sse_status != 'disabled'
        AND (
          health_status IN ('healthy', 'degraded')
          OR (
            onboarding_source = 'nostr_33357'
            AND workspace_id IS NOT NULL
            AND last_error_code = 'flightdeck_pg_access_failed'
          )
        )`,
      [],
    );
  }

  listAll(): WorkspaceSubscriptionRecord[] {
    return this.listWhere('1 = 1', []);
  }

  getBySubscriptionId(subscriptionId: string): WorkspaceSubscriptionRecord | null {
    return this.getWhere('subscription_id = ?1', [subscriptionId]);
  }

  getByWorkspaceAndBot(workspaceOwnerNpub: string, botNpub: string): WorkspaceSubscriptionRecord | null {
    return this.getWhere(
      'workspace_owner_npub = ?1 AND bot_npub = ?2',
      [workspaceOwnerNpub, botNpub],
    );
  }

  getBySubscriptionScope(input: {
    backendConnectionId?: string | null;
    managedByNpub: string;
    workspaceOwnerNpub: string;
    sourceAppNpub: string;
    botNpub: string;
    agentProfileId?: string | null;
    towerServiceNpub?: string | null;
    workspaceId?: string | null;
    workspaceServiceNpub?: string | null;
  }): WorkspaceSubscriptionRecord | null {
    return this.getWhere(
      `(backend_connection_id = ?1 OR (?1 IS NULL AND backend_connection_id IS NULL))
        AND managed_by_npub = ?2
        AND workspace_owner_npub = ?3
        AND source_app_npub = ?4
        AND bot_npub = ?5
        AND (agent_profile_id = ?6 OR (?6 IS NULL AND agent_profile_id IS NULL))
        AND (?7 IS NULL OR tower_service_npub = ?7 OR tower_service_npub IS NULL)
        AND (?8 IS NULL OR workspace_id = ?8 OR workspace_id IS NULL)
        AND (?9 IS NULL OR workspace_service_npub = ?9 OR workspace_service_npub IS NULL)`,
      [
        input.backendConnectionId ?? null,
        input.managedByNpub,
        input.workspaceOwnerNpub,
        input.sourceAppNpub,
        input.botNpub,
        input.agentProfileId ?? null,
        input.towerServiceNpub ?? null,
        input.workspaceId ?? null,
        input.workspaceServiceNpub ?? null,
      ],
    );
  }

  save(record: WorkspaceSubscriptionRecord): WorkspaceSubscriptionRecord {
    const bindings: SQLQueryBindings[] = [
      record.subscriptionId,
      record.backendConnectionId ?? null,
      record.workspaceOwnerNpub,
      record.backendBaseUrl,
      record.towerServiceNpub ?? null,
      record.workspaceId ?? null,
      record.workspaceServiceNpub ?? null,
      record.botNpub,
      record.sourceAppNpub,
      record.onboardingSource ?? 'manual',
      record.connectionTokenRef ?? null,
      record.agentProfileId ?? null,
      record.sourceAppSchemaNamespace ?? null,
      serialiseJsonValue(record.capabilityDefaults ?? []),
      serialiseJsonValue(record.dispatchRouteIds ?? []),
      record.lastSyncCursor ?? null,
      record.lastEventPollOkAt ?? null,
      record.lastEventPollErrorAt ?? null,
      record.lastEventPollErrorCode ?? null,
      record.lastEventPollEventCount ?? null,
      record.lastEventPollLagMs ?? null,
      record.lastPipelineRunId ?? null,
      record.wsKeyNpub,
      record.wsKeyStatus,
      record.groupKeyStatus,
      record.sseStatus,
      record.healthStatus,
      record.triggerConfigRecordId,
      record.lastSseEventId,
      record.lastAuthOkAt,
      record.lastGroupRefreshAt,
      record.lastErrorCode,
      record.lastErrorAt,
      record.createdAt,
      record.updatedAt,
      record.managedByNpub ?? null,
      record.wsKeyBlobJson,
      record.wrappedGroupKeysJson,
      serialiseJsonValue(record.lastAuthResult),
      serialiseJsonValue(record.lastGroupRefreshResult),
      serialiseJsonValue(record.lastRecordPullResult),
      serialiseJsonValue(record.lastDecryptResult),
      serialiseJsonValue(record.lastRoutingResult),
      serialiseJsonValue(record.lastSseEvent),
      serialiseJsonValue(record.recentSseEvents ?? []),
      serialiseJsonValue(record.recentDispatches ?? []),
      record.lastSuccessfulStartupReloadAt,
    ];

    this.db.query(
      `INSERT INTO workspace_subscriptions (
         subscription_id, backend_connection_id, workspace_owner_npub, backend_base_url,
         tower_service_npub, workspace_id, workspace_service_npub, bot_npub, source_app_npub,
         onboarding_source, connection_token_ref, agent_profile_id, source_app_schema_namespace, capability_defaults_json,
         dispatch_route_ids_json, last_sync_cursor, last_event_poll_ok_at, last_event_poll_error_at,
         last_event_poll_error_code, last_event_poll_event_count, last_event_poll_lag_ms, last_pipeline_run_id,
         ws_key_npub, ws_key_status, group_key_status, sse_status, health_status,
         trigger_config_record_id, last_sse_event_id, last_auth_ok_at, last_group_refresh_at,
         last_error_code, last_error_at, created_at, updated_at, managed_by_npub,
         ws_key_blob_json, wrapped_group_keys_json, last_auth_result_json,
         last_group_refresh_result_json, last_record_pull_result_json, last_decrypt_result_json, last_routing_result_json,
         last_sse_event_json, recent_sse_events_json, recent_dispatches_json, last_successful_startup_reload_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6,
         ?7, ?8, ?9,
         ?10, ?11, ?12, ?13, ?14,
         ?15, ?16, ?17, ?18,
         ?19, ?20, ?21, ?22,
         ?23, ?24, ?25, ?26, ?27,
         ?28, ?29, ?30, ?31,
         ?32, ?33, ?34, ?35, ?36,
         ?37, ?38, ?39,
         ?40, ?41, ?42, ?43,
         ?44, ?45, ?46, ?47
       )
       ON CONFLICT(subscription_id) DO UPDATE SET
         backend_connection_id = excluded.backend_connection_id,
         workspace_owner_npub = excluded.workspace_owner_npub,
         backend_base_url = excluded.backend_base_url,
         tower_service_npub = excluded.tower_service_npub,
         workspace_id = excluded.workspace_id,
         workspace_service_npub = excluded.workspace_service_npub,
         bot_npub = excluded.bot_npub,
         source_app_npub = excluded.source_app_npub,
         onboarding_source = excluded.onboarding_source,
         connection_token_ref = excluded.connection_token_ref,
         agent_profile_id = excluded.agent_profile_id,
         source_app_schema_namespace = excluded.source_app_schema_namespace,
         capability_defaults_json = excluded.capability_defaults_json,
         dispatch_route_ids_json = excluded.dispatch_route_ids_json,
         last_sync_cursor = excluded.last_sync_cursor,
         last_event_poll_ok_at = excluded.last_event_poll_ok_at,
         last_event_poll_error_at = excluded.last_event_poll_error_at,
         last_event_poll_error_code = excluded.last_event_poll_error_code,
         last_event_poll_event_count = excluded.last_event_poll_event_count,
         last_event_poll_lag_ms = excluded.last_event_poll_lag_ms,
         last_pipeline_run_id = excluded.last_pipeline_run_id,
         ws_key_npub = excluded.ws_key_npub,
         ws_key_status = excluded.ws_key_status,
         group_key_status = excluded.group_key_status,
         sse_status = excluded.sse_status,
         health_status = excluded.health_status,
         trigger_config_record_id = excluded.trigger_config_record_id,
         last_sse_event_id = excluded.last_sse_event_id,
         last_auth_ok_at = excluded.last_auth_ok_at,
         last_group_refresh_at = excluded.last_group_refresh_at,
         last_error_code = excluded.last_error_code,
         last_error_at = excluded.last_error_at,
         updated_at = excluded.updated_at,
         managed_by_npub = excluded.managed_by_npub,
         ws_key_blob_json = excluded.ws_key_blob_json,
         wrapped_group_keys_json = excluded.wrapped_group_keys_json,
         last_auth_result_json = excluded.last_auth_result_json,
         last_group_refresh_result_json = excluded.last_group_refresh_result_json,
         last_record_pull_result_json = excluded.last_record_pull_result_json,
         last_decrypt_result_json = excluded.last_decrypt_result_json,
         last_routing_result_json = excluded.last_routing_result_json,
         last_sse_event_json = excluded.last_sse_event_json,
         recent_sse_events_json = excluded.recent_sse_events_json,
         recent_dispatches_json = excluded.recent_dispatches_json,
         last_successful_startup_reload_at = excluded.last_successful_startup_reload_at`,
    ).run(...bindings);

    return this.getBySubscriptionId(record.subscriptionId) ?? record;
  }

  createDefault(input: {
    managedByNpub: string;
    workspaceOwnerNpub: string;
    backendBaseUrl: string;
    towerServiceNpub?: string | null;
    workspaceId?: string | null;
    workspaceServiceNpub?: string | null;
    botNpub: string;
    sourceAppNpub: string;
    backendConnectionId?: string | null;
    onboardingSource?: WorkspaceSubscriptionRecord['onboardingSource'];
    connectionTokenRef?: string | null;
    agentProfileId?: string | null;
    sourceAppSchemaNamespace?: string | null;
    capabilityDefaults?: WorkspaceSubscriptionRecord['capabilityDefaults'];
    dispatchRouteIds?: string[];
    triggerConfigRecordId?: string | null;
  }): WorkspaceSubscriptionRecord {
    const now = new Date().toISOString();
    return {
      subscriptionId: randomUUID(),
      backendConnectionId: input.backendConnectionId ?? null,
      workspaceOwnerNpub: input.workspaceOwnerNpub,
      backendBaseUrl: input.backendBaseUrl,
      towerServiceNpub: input.towerServiceNpub ?? null,
      workspaceId: input.workspaceId ?? null,
      workspaceServiceNpub: input.workspaceServiceNpub ?? null,
      botNpub: input.botNpub,
      sourceAppNpub: input.sourceAppNpub,
      onboardingSource: input.onboardingSource ?? 'manual',
      connectionTokenRef: input.connectionTokenRef ?? null,
      agentProfileId: input.agentProfileId ?? null,
      sourceAppSchemaNamespace: input.sourceAppSchemaNamespace ?? null,
      capabilityDefaults: input.capabilityDefaults ?? [],
      dispatchRouteIds: input.dispatchRouteIds ?? [],
      lastSyncCursor: null,
      lastEventPollOkAt: null,
      lastEventPollErrorAt: null,
      lastEventPollErrorCode: null,
      lastEventPollEventCount: null,
      lastEventPollLagMs: null,
      lastPipelineRunId: null,
      wsKeyNpub: null,
      wsKeyStatus: 'pending',
      groupKeyStatus: 'pending',
      sseStatus: 'disconnected',
      healthStatus: 'degraded',
      triggerConfigRecordId: input.triggerConfigRecordId ?? null,
      lastSseEventId: null,
      lastAuthOkAt: null,
      lastGroupRefreshAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
      createdAt: now,
      updatedAt: now,
      managedByNpub: input.managedByNpub,
      wsKeyBlobJson: null,
      wrappedGroupKeysJson: null,
      lastAuthResult: null,
      lastGroupRefreshResult: null,
      lastRecordPullResult: null,
      lastDecryptResult: null,
      lastRoutingResult: null,
      lastSseEvent: null,
      recentSseEvents: [],
      recentDispatches: [],
      lastSuccessfulStartupReloadAt: null,
    };
  }

  delete(subscriptionId: string): boolean {
    const result = this.db
      .query('DELETE FROM workspace_subscriptions WHERE subscription_id = ?1')
      .run(subscriptionId);
    return result.changes > 0;
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): WorkspaceSubscriptionRecord[] {
    return this.db
      .query(
        `SELECT
           subscription_id,
           backend_connection_id,
           workspace_owner_npub,
           backend_base_url,
           tower_service_npub,
           workspace_id,
           workspace_service_npub,
           bot_npub,
           source_app_npub,
           onboarding_source,
           connection_token_ref,
           agent_profile_id,
           source_app_schema_namespace,
           capability_defaults_json,
           dispatch_route_ids_json,
           last_sync_cursor,
           last_event_poll_ok_at,
           last_event_poll_error_at,
           last_event_poll_error_code,
           last_event_poll_event_count,
           last_event_poll_lag_ms,
           last_pipeline_run_id,
           ws_key_npub,
           ws_key_status,
           group_key_status,
           sse_status,
           health_status,
           trigger_config_record_id,
           last_sse_event_id,
           last_auth_ok_at,
           last_group_refresh_at,
           last_error_code,
           last_error_at,
           created_at,
           updated_at,
           managed_by_npub,
           ws_key_blob_json,
           wrapped_group_keys_json,
           last_auth_result_json,
           last_group_refresh_result_json,
           last_record_pull_result_json,
           last_decrypt_result_json,
           last_routing_result_json,
           last_sse_event_json,
           recent_sse_events_json,
           recent_dispatches_json,
           last_successful_startup_reload_at
         FROM workspace_subscriptions
         WHERE ${whereClause}
         ORDER BY updated_at DESC`,
      )
      .all(...args)
      .map((row) => this.mapRow(row as Record<string, string | null>));
  }

  private getWhere(whereClause: string, args: SQLQueryBindings[]): WorkspaceSubscriptionRecord | null {
    const row = this.db
      .query(
        `SELECT
           subscription_id,
           backend_connection_id,
           workspace_owner_npub,
           backend_base_url,
           tower_service_npub,
           workspace_id,
           workspace_service_npub,
           bot_npub,
           source_app_npub,
           onboarding_source,
           connection_token_ref,
           agent_profile_id,
           source_app_schema_namespace,
           capability_defaults_json,
           dispatch_route_ids_json,
           last_sync_cursor,
           last_event_poll_ok_at,
           last_event_poll_error_at,
           last_event_poll_error_code,
           last_event_poll_event_count,
           last_event_poll_lag_ms,
           last_pipeline_run_id,
           ws_key_npub,
           ws_key_status,
           group_key_status,
           sse_status,
           health_status,
           trigger_config_record_id,
           last_sse_event_id,
           last_auth_ok_at,
           last_group_refresh_at,
           last_error_code,
           last_error_at,
           created_at,
           updated_at,
           managed_by_npub,
           ws_key_blob_json,
           wrapped_group_keys_json,
           last_auth_result_json,
           last_group_refresh_result_json,
           last_record_pull_result_json,
           last_decrypt_result_json,
           last_routing_result_json,
           last_sse_event_json,
           recent_sse_events_json,
           recent_dispatches_json,
           last_successful_startup_reload_at
         FROM workspace_subscriptions
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(...args) as Record<string, string | null> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, string | null>): WorkspaceSubscriptionRecord {
    return {
      subscriptionId: row.subscription_id!,
      backendConnectionId: row.backend_connection_id ?? null,
      workspaceOwnerNpub: row.workspace_owner_npub!,
      backendBaseUrl: row.backend_base_url!,
      towerServiceNpub: row.tower_service_npub ?? null,
      workspaceId: row.workspace_id ?? null,
      workspaceServiceNpub: row.workspace_service_npub ?? null,
      botNpub: row.bot_npub!,
      sourceAppNpub: row.source_app_npub!,
      onboardingSource: row.onboarding_source as WorkspaceSubscriptionRecord['onboardingSource'] || 'manual',
      connectionTokenRef: row.connection_token_ref ?? null,
      agentProfileId: row.agent_profile_id ?? null,
      sourceAppSchemaNamespace: row.source_app_schema_namespace ?? null,
      capabilityDefaults: parseJsonArray(row.capability_defaults_json ?? null) as WorkspaceSubscriptionRecord['capabilityDefaults'],
      dispatchRouteIds: parseJsonArray(row.dispatch_route_ids_json ?? null),
      lastSyncCursor: row.last_sync_cursor ?? null,
      lastEventPollOkAt: row.last_event_poll_ok_at ?? null,
      lastEventPollErrorAt: row.last_event_poll_error_at ?? null,
      lastEventPollErrorCode: row.last_event_poll_error_code ?? null,
      lastEventPollEventCount: row.last_event_poll_event_count == null ? null : Number(row.last_event_poll_event_count),
      lastEventPollLagMs: row.last_event_poll_lag_ms == null ? null : Number(row.last_event_poll_lag_ms),
      lastPipelineRunId: row.last_pipeline_run_id ?? null,
      wsKeyNpub: row.ws_key_npub ?? null,
      wsKeyStatus: row.ws_key_status as WorkspaceSubscriptionRecord['wsKeyStatus'],
      groupKeyStatus: row.group_key_status as WorkspaceSubscriptionRecord['groupKeyStatus'],
      sseStatus: row.sse_status as WorkspaceSubscriptionRecord['sseStatus'],
      healthStatus: row.health_status as WorkspaceSubscriptionRecord['healthStatus'],
      triggerConfigRecordId: row.trigger_config_record_id ?? null,
      lastSseEventId: row.last_sse_event_id ?? null,
      lastAuthOkAt: row.last_auth_ok_at ?? null,
      lastGroupRefreshAt: row.last_group_refresh_at ?? null,
      lastErrorCode: row.last_error_code ?? null,
      lastErrorAt: row.last_error_at ?? null,
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
      managedByNpub: row.managed_by_npub ?? null,
      wsKeyBlobJson: row.ws_key_blob_json ?? null,
      wrappedGroupKeysJson: row.wrapped_group_keys_json ?? null,
      lastAuthResult: parseJsonValue(row.last_auth_result_json ?? null),
      lastGroupRefreshResult: parseJsonValue(row.last_group_refresh_result_json ?? null),
      lastRecordPullResult: parseJsonValue(row.last_record_pull_result_json ?? null),
      lastDecryptResult: parseJsonValue(row.last_decrypt_result_json ?? null),
      lastRoutingResult: parseJsonValue(row.last_routing_result_json ?? null),
      lastSseEvent: parseJsonValue(row.last_sse_event_json ?? null),
      recentSseEvents: parseJsonValue(row.recent_sse_events_json ?? null) ?? [],
      recentDispatches: parseJsonValue(row.recent_dispatches_json ?? null) ?? [],
      lastSuccessfulStartupReloadAt: row.last_successful_startup_reload_at ?? null,
    };
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        backend_connection_id TEXT,
        workspace_owner_npub TEXT NOT NULL,
        backend_base_url TEXT NOT NULL,
        tower_service_npub TEXT,
        workspace_id TEXT,
        workspace_service_npub TEXT,
        bot_npub TEXT NOT NULL,
        source_app_npub TEXT NOT NULL,
        onboarding_source TEXT NOT NULL DEFAULT 'manual',
        connection_token_ref TEXT,
        agent_profile_id TEXT,
        source_app_schema_namespace TEXT,
        capability_defaults_json TEXT,
        dispatch_route_ids_json TEXT,
        last_sync_cursor TEXT,
        last_event_poll_ok_at TEXT,
        last_event_poll_error_at TEXT,
        last_event_poll_error_code TEXT,
        last_event_poll_event_count INTEGER,
        last_event_poll_lag_ms INTEGER,
        last_pipeline_run_id TEXT,
        ws_key_npub TEXT,
        ws_key_status TEXT NOT NULL,
        group_key_status TEXT NOT NULL,
        sse_status TEXT NOT NULL,
        health_status TEXT NOT NULL,
        trigger_config_record_id TEXT,
        last_sse_event_id TEXT,
        last_auth_ok_at TEXT,
        last_group_refresh_at TEXT,
        last_error_code TEXT,
        last_error_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        managed_by_npub TEXT,
        ws_key_blob_json TEXT,
        wrapped_group_keys_json TEXT,
        last_auth_result_json TEXT,
        last_group_refresh_result_json TEXT,
        last_record_pull_result_json TEXT,
        last_decrypt_result_json TEXT,
        last_routing_result_json TEXT,
        last_sse_event_json TEXT,
        recent_sse_events_json TEXT,
        recent_dispatches_json TEXT,
        last_successful_startup_reload_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_managed_by
        ON workspace_subscriptions(managed_by_npub);

      CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_health
        ON workspace_subscriptions(health_status, sse_status);
    `);

    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_record_pull_result_json')) {
      this.db.exec(`
        ALTER TABLE workspace_subscriptions
          ADD COLUMN last_record_pull_result_json TEXT
      `);
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_routing_result_json')) {
      this.db.exec(`
        ALTER TABLE workspace_subscriptions
          ADD COLUMN last_routing_result_json TEXT
      `);
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'recent_sse_events_json')) {
      this.db.exec(`
        ALTER TABLE workspace_subscriptions
          ADD COLUMN recent_sse_events_json TEXT
      `);
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'recent_dispatches_json')) {
      this.db.exec(`
        ALTER TABLE workspace_subscriptions
          ADD COLUMN recent_dispatches_json TEXT
      `);
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'backend_connection_id')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN backend_connection_id TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'connection_token_ref')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN connection_token_ref TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'onboarding_source')) {
      this.db.exec("ALTER TABLE workspace_subscriptions ADD COLUMN onboarding_source TEXT NOT NULL DEFAULT 'manual'");
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'agent_profile_id')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN agent_profile_id TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'source_app_schema_namespace')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN source_app_schema_namespace TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'capability_defaults_json')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN capability_defaults_json TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'dispatch_route_ids_json')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN dispatch_route_ids_json TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_sync_cursor')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN last_sync_cursor TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_event_poll_ok_at')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN last_event_poll_ok_at TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_event_poll_error_at')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN last_event_poll_error_at TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_event_poll_error_code')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN last_event_poll_error_code TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_event_poll_event_count')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN last_event_poll_event_count INTEGER');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_event_poll_lag_ms')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN last_event_poll_lag_ms INTEGER');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'last_pipeline_run_id')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN last_pipeline_run_id TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'tower_service_npub')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN tower_service_npub TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'workspace_id')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN workspace_id TEXT');
    }
    if (!hasColumn(this.db, 'workspace_subscriptions', 'workspace_service_npub')) {
      this.db.exec('ALTER TABLE workspace_subscriptions ADD COLUMN workspace_service_npub TEXT');
    }
    this.db.exec(`
      DROP INDEX IF EXISTS idx_workspace_subscriptions_workspace_bot;
      DROP INDEX IF EXISTS idx_workspace_subscriptions_scope;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_subscriptions_scope
        ON workspace_subscriptions(
          backend_connection_id,
          managed_by_npub,
          agent_profile_id,
          workspace_owner_npub,
          tower_service_npub,
          workspace_id,
          workspace_service_npub,
          source_app_npub,
          bot_npub
        );
    `);
  }
}

export const workspaceSubscriptionStore = new WorkspaceSubscriptionStore();
export { WorkspaceSubscriptionStore };
