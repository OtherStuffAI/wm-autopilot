import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../../storage/message-store';
import type {
  AgentCapability,
  CreateDispatchRouteInput,
  DispatchActivePolicy,
  DispatchRouteRecord,
  DispatchTriggerKind,
} from '../types';
import {
  DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
  normaliseBuiltInDispatchPipelineId,
  normaliseDispatchPipelineVersionPolicy,
} from './pipeline-policy';

const DEFAULT_DB_PATH = databaseFile;

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normaliseTriggerKind(value: string): DispatchTriggerKind {
  if (
    value === 'chat'
    || value === 'task'
    || value === 'document'
    || value === 'flow'
    || value === 'task_review'
    || value === 'approval'
    || value === 'comment'
  ) {
    return value;
  }
  return 'chat';
}

function normaliseCapability(value: string): AgentCapability {
  if (
    value === 'chat_intercept'
    || value === 'task_dispatch'
    || value === 'comment_dispatch'
    || value === 'flow_dispatch'
    || value === 'task_review'
    || value === 'approval_dispatch'
  ) {
    return value;
  }
  return 'chat_intercept';
}

function normaliseActivePolicy(value: string | null | undefined): DispatchActivePolicy {
  if (value === 'queue' || value === 'start_new' || value === 'skip') {
    return value;
  }
  return 'skip';
}

export class DispatchRouteStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listForManager(managedByNpub: string): DispatchRouteRecord[] {
    return this.listWhere('managed_by_npub = ?1', [managedByNpub]);
  }

  listForSubscription(subscriptionId: string): DispatchRouteRecord[] {
    return this.listWhere('subscription_id = ?1', [subscriptionId]);
  }

  listForSubscriptionTrigger(input: {
    subscriptionId: string;
    triggerKind: DispatchTriggerKind;
    capability: AgentCapability;
  }): DispatchRouteRecord[] {
    return this.listWhere(
      'subscription_id = ?1 AND trigger_kind = ?2 AND capability = ?3',
      [input.subscriptionId, input.triggerKind, input.capability],
    );
  }

  getByRouteId(routeId: string): DispatchRouteRecord | null {
    return this.getWhere('route_id = ?1', [routeId]);
  }

  save(input: CreateDispatchRouteInput & { routeId?: string; createdAt?: string }): DispatchRouteRecord {
    const now = new Date().toISOString();
    const record: DispatchRouteRecord = {
      routeId: input.routeId ?? randomUUID(),
      managedByNpub: input.managedByNpub,
      subscriptionId: input.subscriptionId,
      workspaceOwnerNpub: input.workspaceOwnerNpub,
      botNpub: input.botNpub,
      sourceAppNpub: input.sourceAppNpub,
      triggerKind: input.triggerKind,
      capability: input.capability,
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(input.pipelineDefinitionId) ?? input.pipelineDefinitionId,
      pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(input.pipelineVersionPolicy),
      enabled: input.enabled !== false,
      priority: Number.isFinite(input.priority) ? Number(input.priority) : 100,
      matchJson: input.matchJson ?? {},
      inputTemplateJson: input.inputTemplateJson ?? {},
      concurrencyKeyTemplate: input.concurrencyKeyTemplate || defaultConcurrencyTemplate(input.triggerKind),
      activePolicy: input.activePolicy ?? defaultActivePolicy(input.triggerKind),
      dedupeWindowSeconds: Number.isFinite(input.dedupeWindowSeconds) ? Number(input.dedupeWindowSeconds) : 300,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };

    this.db.query(`
      INSERT INTO agent_dispatch_pipeline_routes (
        route_id, managed_by_npub, subscription_id, workspace_owner_npub, bot_npub,
        source_app_npub, trigger_kind, capability, pipeline_definition_id, pipeline_version_policy, enabled,
        priority, match_json, input_template_json, concurrency_key_template,
        active_policy, dedupe_window_seconds, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
      )
      ON CONFLICT(route_id) DO UPDATE SET
        managed_by_npub = excluded.managed_by_npub,
        subscription_id = excluded.subscription_id,
        workspace_owner_npub = excluded.workspace_owner_npub,
        bot_npub = excluded.bot_npub,
        source_app_npub = excluded.source_app_npub,
        trigger_kind = excluded.trigger_kind,
        capability = excluded.capability,
        pipeline_definition_id = excluded.pipeline_definition_id,
        pipeline_version_policy = excluded.pipeline_version_policy,
        enabled = excluded.enabled,
        priority = excluded.priority,
        match_json = excluded.match_json,
        input_template_json = excluded.input_template_json,
        concurrency_key_template = excluded.concurrency_key_template,
        active_policy = excluded.active_policy,
        dedupe_window_seconds = excluded.dedupe_window_seconds,
        updated_at = excluded.updated_at
    `).run(
      record.routeId,
      record.managedByNpub,
      record.subscriptionId,
      record.workspaceOwnerNpub,
      record.botNpub,
      record.sourceAppNpub,
      record.triggerKind,
      record.capability,
      record.pipelineDefinitionId,
      record.pipelineVersionPolicy,
      record.enabled ? 1 : 0,
      record.priority,
      JSON.stringify(record.matchJson),
      JSON.stringify(record.inputTemplateJson),
      record.concurrencyKeyTemplate,
      record.activePolicy,
      record.dedupeWindowSeconds,
      record.createdAt,
      record.updatedAt,
    );
    return this.getByRouteId(record.routeId) ?? record;
  }

  deleteForManager(routeId: string, managedByNpub: string): boolean {
    const result = this.db
      .query('DELETE FROM agent_dispatch_pipeline_routes WHERE route_id = ?1 AND managed_by_npub = ?2')
      .run(routeId, managedByNpub);
    return result.changes > 0;
  }

  deleteForSubscriptionForManager(subscriptionId: string, managedByNpub: string): number {
    const result = this.db
      .query('DELETE FROM agent_dispatch_pipeline_routes WHERE subscription_id = ?1 AND managed_by_npub = ?2')
      .run(subscriptionId, managedByNpub);
    return result.changes;
  }

  private listWhere(whereSql: string, bindings: SQLQueryBindings[]): DispatchRouteRecord[] {
    const rows = this.db
      .query(`SELECT * FROM agent_dispatch_pipeline_routes WHERE ${whereSql} ORDER BY priority ASC, updated_at DESC`)
      .all(...bindings) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  private getWhere(whereSql: string, bindings: SQLQueryBindings[]): DispatchRouteRecord | null {
    const row = this.db
      .query(`SELECT * FROM agent_dispatch_pipeline_routes WHERE ${whereSql} LIMIT 1`)
      .get(...bindings) as Record<string, unknown> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, unknown>): DispatchRouteRecord {
    return {
      routeId: String(row.route_id ?? ''),
      managedByNpub: String(row.managed_by_npub ?? ''),
      subscriptionId: String(row.subscription_id ?? ''),
      workspaceOwnerNpub: String(row.workspace_owner_npub ?? ''),
      botNpub: String(row.bot_npub ?? ''),
      sourceAppNpub: String(row.source_app_npub ?? ''),
      triggerKind: normaliseTriggerKind(String(row.trigger_kind ?? 'chat')),
      capability: normaliseCapability(String(row.capability ?? 'chat_intercept')),
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(String(row.pipeline_definition_id ?? '')) ?? '',
      pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(
        typeof row.pipeline_version_policy === 'string' ? row.pipeline_version_policy : null,
      ),
      enabled: Number(row.enabled ?? 0) === 1,
      priority: Number(row.priority ?? 100),
      matchJson: parseJsonObject(typeof row.match_json === 'string' ? row.match_json : null),
      inputTemplateJson: parseJsonObject(typeof row.input_template_json === 'string' ? row.input_template_json : null),
      concurrencyKeyTemplate: String(row.concurrency_key_template ?? ''),
      activePolicy: normaliseActivePolicy(typeof row.active_policy === 'string' ? row.active_policy : null),
      dedupeWindowSeconds: Number(row.dedupe_window_seconds ?? 300),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  private initialise(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_dispatch_pipeline_routes (
        route_id TEXT PRIMARY KEY,
        managed_by_npub TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        workspace_owner_npub TEXT NOT NULL,
        bot_npub TEXT NOT NULL,
        source_app_npub TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        capability TEXT NOT NULL,
        pipeline_definition_id TEXT NOT NULL,
        pipeline_version_policy TEXT NOT NULL DEFAULT 'latest',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        match_json TEXT,
        input_template_json TEXT,
        concurrency_key_template TEXT NOT NULL,
        active_policy TEXT NOT NULL,
        dedupe_window_seconds INTEGER NOT NULL DEFAULT 300,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_dispatch_routes_subscription
        ON agent_dispatch_pipeline_routes(subscription_id, trigger_kind, capability, enabled, priority);

      CREATE INDEX IF NOT EXISTS idx_agent_dispatch_routes_manager
        ON agent_dispatch_pipeline_routes(managed_by_npub, updated_at DESC);
    `);

    if (!hasColumn(this.db, 'agent_dispatch_pipeline_routes', 'pipeline_version_policy')) {
      this.db.exec(`ALTER TABLE agent_dispatch_pipeline_routes ADD COLUMN pipeline_version_policy TEXT NOT NULL DEFAULT '${DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY}'`);
    }
  }
}

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function defaultActivePolicy(triggerKind: DispatchTriggerKind): DispatchActivePolicy {
  return triggerKind === 'chat' ? 'queue' : 'skip';
}

function defaultConcurrencyTemplate(triggerKind: DispatchTriggerKind): string {
  return triggerKind === 'chat'
    ? '${workspace.subscriptionId}:${routing.threadId}:${route.routeId}'
    : '${workspace.subscriptionId}:${record.recordId}:${route.routeId}';
}

export const dispatchRouteStore = new DispatchRouteStore();
