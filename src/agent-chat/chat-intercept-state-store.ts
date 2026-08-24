import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import type {
  AgentInterceptDecision,
  ChatInterceptStateRecord,
  ChatInterceptStateStatus,
} from './types';
import { initialiseChatInterceptStateSchema } from './chat-intercept-state-schema';

const DEFAULT_DB_PATH = databaseFile;

function normalisePendingMessageCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function normaliseState(value: unknown): ChatInterceptStateStatus {
  switch (value) {
    case 'active':
    case 'interrupting':
    case 'interrupt_failed':
    case 'idle':
    case 'archived':
    case 'blocked_auth':
    case 'blocked_decrypt':
      return value;
    default:
      return 'pending';
  }
}

function normaliseDecision(value: unknown): AgentInterceptDecision {
  switch (value) {
    case 'respond':
    case 'ignore':
    case 'failed':
      return value;
    default:
      return 'pending';
  }
}

class ChatInterceptStateStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listBySubscriptionId(subscriptionId: string): ChatInterceptStateRecord[] {
    return this.listWhere('subscription_id = ?1', [subscriptionId]);
  }

  listAll(): ChatInterceptStateRecord[] {
    return this.listWhere('1 = 1', []);
  }

  getByRoutingKey(routingKey: string): ChatInterceptStateRecord | null {
    return this.getWhere('routing_key = ?1', [routingKey]);
  }

  save(record: ChatInterceptStateRecord): ChatInterceptStateRecord {
    this.db.query(
      `INSERT INTO chat_intercept_state (
         routing_key, subscription_id, agent_id, session_id, session_generation, previous_session_ids_json,
         session_class, workspace_owner_npub, source_app_npub, tower_service_npub, workspace_id,
         channel_id, thread_id, target_bot_npub, last_message_id_seen, last_event_cursor_seen,
         last_human_message_id_delivered, last_agent_message_id_published, last_completed_turn_id, pending_message_count,
         state, last_decision, last_activity_at, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
         ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
         ?21, ?22, ?23, ?24, ?25
       )
       ON CONFLICT(routing_key) DO UPDATE SET
         subscription_id = excluded.subscription_id,
         agent_id = excluded.agent_id,
         session_id = excluded.session_id,
         session_generation = excluded.session_generation,
         previous_session_ids_json = excluded.previous_session_ids_json,
         session_class = excluded.session_class,
         workspace_owner_npub = excluded.workspace_owner_npub,
         source_app_npub = excluded.source_app_npub,
         tower_service_npub = excluded.tower_service_npub,
         workspace_id = excluded.workspace_id,
         channel_id = excluded.channel_id,
         thread_id = excluded.thread_id,
         target_bot_npub = excluded.target_bot_npub,
         last_message_id_seen = excluded.last_message_id_seen,
         last_event_cursor_seen = excluded.last_event_cursor_seen,
         last_human_message_id_delivered = excluded.last_human_message_id_delivered,
         last_agent_message_id_published = excluded.last_agent_message_id_published,
         last_completed_turn_id = excluded.last_completed_turn_id,
         pending_message_count = excluded.pending_message_count,
         state = excluded.state,
         last_decision = excluded.last_decision,
         last_activity_at = excluded.last_activity_at,
         updated_at = excluded.updated_at`,
    ).run(
      record.routingKey,
      record.subscriptionId,
      record.agentId,
      record.sessionId,
      record.sessionGeneration ?? 1,
      JSON.stringify(record.previousSessionIds ?? []),
      record.sessionClass,
      record.workspaceOwnerNpub,
      record.sourceAppNpub,
      record.towerServiceNpub ?? '',
      record.workspaceId ?? '',
      record.channelId,
      record.threadId,
      record.botNpub,
      record.lastMessageIdSeen,
      record.lastEventCursorSeen ?? null,
      record.lastHumanMessageIdDelivered ?? null,
      record.lastAgentMessageIdPublished ?? null,
      record.lastCompletedTurnId ?? null,
      record.pendingMessageCount,
      record.state,
      record.lastDecision,
      record.lastActivityAt,
      record.createdAt,
      record.updatedAt,
    );

    return this.getByRoutingKey(record.routingKey) ?? record;
  }

  upsertMessage(input: {
    routingKey: string;
    legacyRoutingKey?: string | null;
    subscriptionId: string;
    agentId: string;
    workspaceOwnerNpub: string;
    sourceAppNpub: string;
    towerServiceNpub?: string;
    workspaceId?: string;
    channelId: string;
    threadId: string;
    botNpub: string;
    messageId: string;
    messageRevision?: number | null;
    eventCursor?: string | null;
    at?: string;
  }): { record: ChatInterceptStateRecord; wasDuplicate: boolean } {
    const now = input.at ?? new Date().toISOString();
    const canonical = this.getByRoutingKey(input.routingKey);
    const legacy = !canonical && input.legacyRoutingKey
      ? this.getByRoutingKey(input.legacyRoutingKey)
      : null;
    const existing = canonical
      ?? (legacy?.subscriptionId === input.subscriptionId ? legacy : null);
    const shouldMigrateLegacy = Boolean(
      existing
      && existing.routingKey !== input.routingKey
      && existing.routingKey === input.legacyRoutingKey,
    );
    const deliveryWasDuplicate = input.messageRevision == null
      ? false
      : !this.claimMessageRevision(input.routingKey, input.messageId, input.messageRevision, now);
    const wasDuplicate = deliveryWasDuplicate || (input.messageRevision == null && existing?.lastMessageIdSeen === input.messageId);
    if (existing && wasDuplicate) {
      if (!shouldMigrateLegacy) {
        const acknowledged = input.eventCursor && input.eventCursor !== existing.lastEventCursorSeen
          ? this.save({ ...existing, lastEventCursorSeen: input.eventCursor, updatedAt: now })
          : existing;
        return { record: acknowledged, wasDuplicate: true };
      }
      const migrated = this.save({
        ...existing,
        routingKey: input.routingKey,
        updatedAt: now,
      });
      this.deleteByRoutingKey(existing.routingKey);
      return { record: migrated, wasDuplicate: true };
    }
    const nextCount = existing
      ? existing.pendingMessageCount + 1
      : 1;

    const record = this.save({
      routingKey: input.routingKey,
      subscriptionId: input.subscriptionId,
      agentId: input.agentId,
      sessionId: existing?.sessionId ?? null,
      sessionGeneration: existing?.sessionGeneration ?? 1,
      previousSessionIds: existing?.previousSessionIds ?? [],
      sessionClass: 'chat',
      workspaceOwnerNpub: input.workspaceOwnerNpub,
      sourceAppNpub: input.sourceAppNpub,
      towerServiceNpub: input.towerServiceNpub ?? existing?.towerServiceNpub ?? '',
      workspaceId: input.workspaceId ?? existing?.workspaceId ?? '',
      channelId: input.channelId,
      threadId: input.threadId,
      botNpub: input.botNpub,
      lastMessageIdSeen: input.messageId,
      lastEventCursorSeen: input.eventCursor ?? existing?.lastEventCursorSeen ?? null,
      lastHumanMessageIdDelivered: existing?.lastHumanMessageIdDelivered ?? null,
      lastAgentMessageIdPublished: existing?.lastAgentMessageIdPublished ?? null,
      lastCompletedTurnId: existing?.lastCompletedTurnId ?? null,
      pendingMessageCount: nextCount,
      state: existing?.sessionId ? existing.state : 'pending',
      lastDecision: 'pending',
      lastActivityAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (shouldMigrateLegacy) {
      this.deleteByRoutingKey(existing!.routingKey);
    }
    return { record, wasDuplicate };
  }

  private claimMessageRevision(routingKey: string, messageId: string, revision: number, createdAt: string): boolean {
    const result = this.db.query(
      `INSERT OR IGNORE INTO chat_intercept_message_revisions
       (routing_key, message_id, message_revision, created_at) VALUES (?1, ?2, ?3, ?4)`,
    ).run(routingKey, messageId, revision, createdAt);
    return Number(result.changes) === 1;
  }

  private deleteByRoutingKey(routingKey: string): void {
    this.db.query('DELETE FROM chat_intercept_state WHERE routing_key = ?1').run(routingKey);
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): ChatInterceptStateRecord[] {
    return this.db
      .query(
        `SELECT
           routing_key,
           subscription_id,
           agent_id,
           session_id,
           session_generation,
           previous_session_ids_json,
           session_class,
           workspace_owner_npub,
           source_app_npub,
           tower_service_npub,
           workspace_id,
           channel_id,
           thread_id,
           target_bot_npub,
           last_message_id_seen,
           last_event_cursor_seen,
           last_human_message_id_delivered,
           last_agent_message_id_published,
           last_completed_turn_id,
           pending_message_count,
           state,
           last_decision,
           last_activity_at,
           created_at,
           updated_at
         FROM chat_intercept_state
         WHERE ${whereClause}
         ORDER BY updated_at DESC, routing_key ASC`,
      )
      .all(...args)
      .map((row) => this.mapRow(row as Record<string, string | number | null>));
  }

  private getWhere(whereClause: string, args: SQLQueryBindings[]): ChatInterceptStateRecord | null {
    const row = this.db
      .query(
        `SELECT
           routing_key,
           subscription_id,
           agent_id,
           session_id,
           session_generation,
           previous_session_ids_json,
           session_class,
           workspace_owner_npub,
           source_app_npub,
           tower_service_npub,
           workspace_id,
           channel_id,
           thread_id,
           target_bot_npub,
           last_message_id_seen,
           last_event_cursor_seen,
           last_human_message_id_delivered,
           last_agent_message_id_published,
           last_completed_turn_id,
           pending_message_count,
           state,
           last_decision,
           last_activity_at,
           created_at,
           updated_at
         FROM chat_intercept_state
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(...args) as Record<string, string | number | null> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, string | number | null>): ChatInterceptStateRecord {
    return {
      routingKey: String(row.routing_key ?? ''),
      subscriptionId: String(row.subscription_id ?? ''),
      agentId: String(row.agent_id ?? ''),
      sessionId: typeof row.session_id === 'string' ? row.session_id : null,
      sessionGeneration: Math.max(1, Number(row.session_generation ?? 1)),
      previousSessionIds: parseStringArray(row.previous_session_ids_json),
      sessionClass: 'chat',
      workspaceOwnerNpub: String(row.workspace_owner_npub ?? ''),
      sourceAppNpub: String(row.source_app_npub ?? ''),
      towerServiceNpub: String(row.tower_service_npub ?? ''),
      workspaceId: String(row.workspace_id ?? ''),
      channelId: String(row.channel_id ?? ''),
      threadId: String(row.thread_id ?? ''),
      botNpub: String(row.target_bot_npub ?? ''),
      lastMessageIdSeen: typeof row.last_message_id_seen === 'string' ? row.last_message_id_seen : null,
      lastEventCursorSeen: typeof row.last_event_cursor_seen === 'string' ? row.last_event_cursor_seen : null,
      lastHumanMessageIdDelivered: typeof row.last_human_message_id_delivered === 'string' ? row.last_human_message_id_delivered : null,
      lastAgentMessageIdPublished: typeof row.last_agent_message_id_published === 'string' ? row.last_agent_message_id_published : null,
      lastCompletedTurnId: typeof row.last_completed_turn_id === 'string' ? row.last_completed_turn_id : null,
      pendingMessageCount: normalisePendingMessageCount(row.pending_message_count),
      state: normaliseState(row.state),
      lastDecision: normaliseDecision(row.last_decision),
      lastActivityAt: String(row.last_activity_at ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  private initialise() {
    initialiseChatInterceptStateSchema(this.db);
  }
}

export const chatInterceptStateStore = new ChatInterceptStateStore();
export { ChatInterceptStateStore };
