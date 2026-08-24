import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { databaseFile } from '../storage/message-store';

export type DirectChatTurnState =
  | 'accepted'
  | 'awaiting_reply'
  | 'reply_ready'
  | 'publishing'
  | 'retry_wait'
  | 'blocked_auth'
  | 'published'
  | 'suppressed'
  | 'integrity_halt'
  | 'completed'
  | 'failed';

export interface DirectChatPublicationPayload {
  body: string;
  threadId: string;
  metadata: {
    source: 'autopilot_session';
    session_id: string | null;
    turn_id: string;
    prompt_type: 'direct_chat';
    source_message_ids: string[];
    agent_npub: string;
  };
}

export interface DirectChatTurnRecord {
  turnId: string;
  routingKey: string;
  sourceMessageIds: string[];
  clientRequestId: string;
  replyBody: string | null;
  publishedMessageId: string | null;
  state: DirectChatTurnState;
  createdAt: string;
  updatedAt: string;
  subscriptionId?: string | null;
  backendBaseUrl?: string | null;
  towerServiceNpub?: string | null;
  workspaceId?: string | null;
  sourceAppNpub?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  agentId?: string | null;
  agentNpub?: string | null;
  sessionId?: string | null;
  prompt?: string | null;
  promptType?: string | null;
  triggerMessageId?: string | null;
  publicationPayload?: DirectChatPublicationPayload | null;
  payloadHash?: string | null;
  attemptCount?: number;
  nextAttemptAt?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  lastErrorClass?: string | null;
  receivedAt?: string | null;
  acceptedAt?: string | null;
  replyReadyAt?: string | null;
  publishedAt?: string | null;
}

export interface DirectChatDeliveryHealth {
  counts: Record<string, number>;
  oldestAwaitingReplyAt: string | null;
  oldestAwaitingReplyAgeMs: number | null;
  oldestReplyReadyAt: string | null;
  oldestReplyReadyAgeMs: number | null;
  retryCount: number;
  failedCount: number;
  attemptCount: number;
  publishedCount: number;
  averageReplyLatencyMs: number | null;
  averagePublishLatencyMs: number | null;
  healthStatus: 'healthy' | 'degraded' | 'unhealthy';
}

const deliveryColumns: Record<string, string> = {
  subscription_id: 'TEXT', backend_base_url: 'TEXT', tower_service_npub: 'TEXT', workspace_id: 'TEXT',
  source_app_npub: 'TEXT', channel_id: 'TEXT', thread_id: 'TEXT', agent_id: 'TEXT', agent_npub: 'TEXT',
  session_id: 'TEXT', prompt: 'TEXT', prompt_type: 'TEXT', trigger_message_id: 'TEXT',
  publication_payload_json: 'TEXT', payload_hash: 'TEXT', attempt_count: 'INTEGER NOT NULL DEFAULT 0',
  next_attempt_at: 'TEXT', lease_owner: 'TEXT', lease_expires_at: 'TEXT', last_error: 'TEXT',
  last_error_class: 'TEXT', received_at: 'TEXT', accepted_at: 'TEXT', reply_ready_at: 'TEXT', published_at: 'TEXT',
};

function payloadHash(payload: DirectChatPublicationPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildDirectChatPublicationPayload(record: DirectChatTurnRecord, body: string): DirectChatPublicationPayload {
  if (!record.threadId || !record.agentNpub) throw new Error(`Agent Direct delivery ${record.turnId} lacks immutable thread/agent binding.`);
  return { body, threadId: record.threadId, metadata: { source: 'autopilot_session', session_id: record.sessionId ?? null,
    turn_id: record.turnId, prompt_type: 'direct_chat', source_message_ids: record.sourceMessageIds, agent_npub: record.agentNpub } };
}

export class DirectChatTurnStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_direct_chat_turns (
      turn_id TEXT PRIMARY KEY, routing_key TEXT NOT NULL, source_message_ids_json TEXT NOT NULL,
      client_request_id TEXT NOT NULL UNIQUE, reply_body TEXT, published_message_id TEXT,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const columns = new Set((this.db.query('PRAGMA table_info(agent_direct_chat_turns)').all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, definition] of Object.entries(deliveryColumns)) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE agent_direct_chat_turns ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_direct_turns_routing ON agent_direct_chat_turns(routing_key, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_direct_delivery_due ON agent_direct_chat_turns(state, next_attempt_at, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_agent_direct_delivery_subscription ON agent_direct_chat_turns(subscription_id, state, created_at);`);
    this.backfillBindings();
    this.requeueLegacySubscriptionSignerHalts();
  }

  get(turnId: string): DirectChatTurnRecord | null {
    const row = this.db.query('SELECT * FROM agent_direct_chat_turns WHERE turn_id = ?1').get(turnId);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  getPending(routingKey: string): DirectChatTurnRecord | null {
    const row = this.db.query("SELECT * FROM agent_direct_chat_turns WHERE routing_key = ?1 AND state NOT IN ('completed','published','suppressed','integrity_halt','failed') ORDER BY created_at ASC LIMIT 1").get(routingKey);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  listRecoverable(limit = 250): DirectChatTurnRecord[] {
    return (this.db.query("SELECT * FROM agent_direct_chat_turns WHERE state NOT IN ('completed','published','suppressed','integrity_halt','failed') ORDER BY created_at LIMIT ?1")
      .all(limit) as Record<string, unknown>[]).map((row) => this.map(row));
  }

  save(record: DirectChatTurnRecord): DirectChatTurnRecord {
    this.db.query(`INSERT INTO agent_direct_chat_turns
      (turn_id,routing_key,source_message_ids_json,client_request_id,reply_body,published_message_id,state,created_at,updated_at,
       subscription_id,backend_base_url,tower_service_npub,workspace_id,source_app_npub,channel_id,thread_id,agent_id,agent_npub,
       session_id,prompt,prompt_type,trigger_message_id,publication_payload_json,payload_hash,attempt_count,next_attempt_at,
       lease_owner,lease_expires_at,last_error,last_error_class,received_at,accepted_at,reply_ready_at,published_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34)
      ON CONFLICT(turn_id) DO UPDATE SET
        source_message_ids_json=excluded.source_message_ids_json, reply_body=COALESCE(agent_direct_chat_turns.reply_body,excluded.reply_body),
        published_message_id=COALESCE(agent_direct_chat_turns.published_message_id,excluded.published_message_id), state=excluded.state,
        updated_at=excluded.updated_at, subscription_id=COALESCE(agent_direct_chat_turns.subscription_id,excluded.subscription_id),
        backend_base_url=COALESCE(agent_direct_chat_turns.backend_base_url,excluded.backend_base_url),
        tower_service_npub=COALESCE(agent_direct_chat_turns.tower_service_npub,excluded.tower_service_npub),
        workspace_id=COALESCE(agent_direct_chat_turns.workspace_id,excluded.workspace_id), source_app_npub=COALESCE(agent_direct_chat_turns.source_app_npub,excluded.source_app_npub),
        channel_id=COALESCE(agent_direct_chat_turns.channel_id,excluded.channel_id), thread_id=COALESCE(agent_direct_chat_turns.thread_id,excluded.thread_id),
        agent_id=COALESCE(agent_direct_chat_turns.agent_id,excluded.agent_id), agent_npub=COALESCE(agent_direct_chat_turns.agent_npub,excluded.agent_npub),
        session_id=COALESCE(excluded.session_id,agent_direct_chat_turns.session_id), prompt=COALESCE(agent_direct_chat_turns.prompt,excluded.prompt),
        prompt_type=COALESCE(agent_direct_chat_turns.prompt_type,excluded.prompt_type), trigger_message_id=COALESCE(agent_direct_chat_turns.trigger_message_id,excluded.trigger_message_id),
        publication_payload_json=COALESCE(agent_direct_chat_turns.publication_payload_json,excluded.publication_payload_json),
        payload_hash=COALESCE(agent_direct_chat_turns.payload_hash,excluded.payload_hash), attempt_count=MAX(agent_direct_chat_turns.attempt_count,excluded.attempt_count),
        next_attempt_at=excluded.next_attempt_at, lease_owner=excluded.lease_owner, lease_expires_at=excluded.lease_expires_at,
        last_error=excluded.last_error,last_error_class=excluded.last_error_class,received_at=COALESCE(agent_direct_chat_turns.received_at,excluded.received_at),
        accepted_at=COALESCE(agent_direct_chat_turns.accepted_at,excluded.accepted_at),reply_ready_at=COALESCE(agent_direct_chat_turns.reply_ready_at,excluded.reply_ready_at),
        published_at=COALESCE(agent_direct_chat_turns.published_at,excluded.published_at)`)
      .run(record.turnId, record.routingKey, JSON.stringify(record.sourceMessageIds), record.clientRequestId, record.replyBody,
        record.publishedMessageId, record.state, record.createdAt, record.updatedAt, record.subscriptionId ?? null,
        record.backendBaseUrl ?? null, record.towerServiceNpub ?? null, record.workspaceId ?? null, record.sourceAppNpub ?? null,
        record.channelId ?? null, record.threadId ?? null, record.agentId ?? null, record.agentNpub ?? null, record.sessionId ?? null,
        record.prompt ?? null, record.promptType ?? null, record.triggerMessageId ?? record.sourceMessageIds.at(-1) ?? null,
        record.publicationPayload ? JSON.stringify(record.publicationPayload) : null, record.payloadHash ?? null,
        record.attemptCount ?? 0, record.nextAttemptAt ?? record.updatedAt, record.leaseOwner ?? null, record.leaseExpiresAt ?? null,
        record.lastError ?? null, record.lastErrorClass ?? null, record.receivedAt ?? record.createdAt,
        record.acceptedAt ?? (record.state === 'accepted' || record.state === 'awaiting_reply' ? record.createdAt : null),
        record.replyReadyAt ?? (record.replyBody ? record.updatedAt : null), record.publishedAt ?? null);
    return this.get(record.turnId)!;
  }

  freezeReply(turnId: string, body: string, at = new Date().toISOString()): DirectChatTurnRecord {
    const current = this.get(turnId);
    if (!current) throw new Error(`Unknown Agent Direct delivery ${turnId}.`);
    const payload = buildDirectChatPublicationPayload(current, body);
    const hash = payloadHash(payload);
    if (current.payloadHash && current.payloadHash !== hash) {
      this.markIntegrityHalt(turnId, 'immutable_payload_mismatch', 'Attempted to replace a frozen Agent Direct publication payload.', at);
      throw new Error(`Agent Direct delivery ${turnId} publication payload is immutable.`);
    }
    this.db.query(`UPDATE agent_direct_chat_turns SET reply_body=?2,publication_payload_json=?3,payload_hash=?4,
      state='reply_ready',reply_ready_at=COALESCE(reply_ready_at,?5),next_attempt_at=?5,lease_owner=NULL,lease_expires_at=NULL,
      last_error=NULL,last_error_class=NULL,updated_at=?5 WHERE turn_id=?1 AND state NOT IN ('completed','published','suppressed','integrity_halt')`)
      .run(turnId, body, JSON.stringify(payload), hash, at);
    return this.get(turnId)!;
  }

  claim(turnId: string, owner: string, now: string, leaseMs: number): DirectChatTurnRecord | null {
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const row = this.db.query(`UPDATE agent_direct_chat_turns SET lease_owner=?2,lease_expires_at=?3,
      state=CASE WHEN state IN ('reply_ready','retry_wait','publishing','blocked_auth') AND publication_payload_json IS NOT NULL THEN 'publishing' ELSE state END,
      attempt_count=CASE WHEN publication_payload_json IS NOT NULL THEN attempt_count+1 ELSE attempt_count END,updated_at=?4
      WHERE turn_id=?1 AND state NOT IN ('completed','published','suppressed','integrity_halt','failed')
        AND (next_attempt_at IS NULL OR next_attempt_at<=?4) AND (lease_expires_at IS NULL OR lease_expires_at<=?4)
      RETURNING *`).get(turnId, owner, leaseExpiresAt, now);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  releaseAwaiting(turnId: string, owner: string, nextAttemptAt: string, error?: { message: string; errorClass: string }): void {
    this.db.query(`UPDATE agent_direct_chat_turns SET state='awaiting_reply',next_attempt_at=?3,lease_owner=NULL,lease_expires_at=NULL,
      last_error=?4,last_error_class=?5,updated_at=?2 WHERE turn_id=?1 AND lease_owner=?6`)
      .run(turnId, new Date().toISOString(), nextAttemptAt, error?.message ?? null, error?.errorClass ?? null, owner);
  }

  markFailed(turnId: string, errorClass: string, error: string, at = new Date().toISOString(), owner?: string): void {
    this.db.query(`UPDATE agent_direct_chat_turns SET state='failed',next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,
      last_error=?3,last_error_class=?2,updated_at=?4 WHERE turn_id=?1 ${owner ? 'AND lease_owner=?5' : ''}`)
      .run(...(owner ? [turnId, errorClass, error, at, owner] : [turnId, errorClass, error, at]));
  }

  markRetry(turnId: string, owner: string, nextAttemptAt: string, error: string, errorClass: string, blockedAuth = false): void {
    this.db.query(`UPDATE agent_direct_chat_turns SET state=?3,next_attempt_at=?4,lease_owner=NULL,lease_expires_at=NULL,
      last_error=?5,last_error_class=?6,updated_at=?2 WHERE turn_id=?1 AND lease_owner=?7`)
      .run(turnId, new Date().toISOString(), blockedAuth ? 'blocked_auth' : 'retry_wait', nextAttemptAt, error, errorClass, owner);
  }

  markPublished(turnId: string, owner: string, messageId: string, at = new Date().toISOString()): DirectChatTurnRecord | null {
    this.db.query(`UPDATE agent_direct_chat_turns SET state='published',published_message_id=?3,published_at=?2,
      lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,last_error=NULL,last_error_class=NULL,updated_at=?2
      WHERE turn_id=?1 AND lease_owner=?4`).run(turnId, at, messageId, owner);
    return this.get(turnId);
  }

  markSuppressed(turnId: string, owner: string, at = new Date().toISOString()): DirectChatTurnRecord | null {
    this.db.query(`UPDATE agent_direct_chat_turns SET state='suppressed',published_at=NULL,published_message_id=NULL,
      lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
      last_error='Duplicate callback response suppressed before Tower publication.',
      last_error_class='duplicate_callback_within_window',updated_at=?2
      WHERE turn_id=?1 AND lease_owner=?3`).run(turnId, at, owner);
    return this.get(turnId);
  }

  markIntegrityHalt(turnId: string, errorClass: string, error: string, at = new Date().toISOString(), owner?: string): void {
    this.db.query(`UPDATE agent_direct_chat_turns SET state='integrity_halt',last_error=?3,last_error_class=?2,
      lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?4 WHERE turn_id=?1 ${owner ? 'AND lease_owner=?5' : ''}`)
      .run(...(owner ? [turnId, errorClass, error, at, owner] : [turnId, errorClass, error, at]));
  }

  releaseForeignLeases(ownerPrefix: string, at = new Date().toISOString()): number {
    return Number(this.db.query(`UPDATE agent_direct_chat_turns SET lease_owner=NULL,lease_expires_at=NULL,updated_at=?2
      WHERE lease_owner IS NOT NULL AND lease_owner NOT LIKE ?1`).run(`${ownerPrefix}%`, at).changes);
  }

  getHealth(subscriptionId: string, nowMs = Date.now(), thresholds: { awaitingDegradedMs?: number; awaitingUnhealthyMs?: number; replyDegradedMs?: number; replyUnhealthyMs?: number } = {}): DirectChatDeliveryHealth {
    const rows = this.db.query(`SELECT state,COUNT(*) count,
      MIN(CASE WHEN state IN ('reply_ready','publishing','retry_wait','blocked_auth') THEN COALESCE(reply_ready_at,updated_at) ELSE COALESCE(accepted_at,created_at) END) oldest,
      SUM(attempt_count) attempts,AVG(CASE WHEN reply_ready_at IS NOT NULL THEN (julianday(reply_ready_at)-julianday(COALESCE(accepted_at,created_at)))*86400000 END) reply_latency,
      AVG(CASE WHEN published_at IS NOT NULL THEN (julianday(published_at)-julianday(reply_ready_at))*86400000 END) publish_latency
      FROM agent_direct_chat_turns WHERE subscription_id=?1 GROUP BY state`).all(subscriptionId) as Array<Record<string, unknown>>;
    const counts: Record<string, number> = {};
    let oldestAwaitingReplyAt: string | null = null; let oldestReplyReadyAt: string | null = null;
    let attemptCount = 0; let replyLatencyTotal = 0; let replyLatencyRows = 0; let publishLatencyTotal = 0; let publishLatencyRows = 0;
    for (const row of rows) {
      const state = String(row.state); const count = Number(row.count ?? 0); counts[state] = count; attemptCount += Number(row.attempts ?? 0);
      if (['accepted', 'awaiting_reply'].includes(state)) oldestAwaitingReplyAt = oldest(oldestAwaitingReplyAt, String(row.oldest));
      if (['reply_ready', 'publishing', 'retry_wait', 'blocked_auth'].includes(state)) oldestReplyReadyAt = oldest(oldestReplyReadyAt, String(row.oldest));
      if (row.reply_latency != null) { replyLatencyTotal += Number(row.reply_latency) * count; replyLatencyRows += count; }
      if (row.publish_latency != null) { publishLatencyTotal += Number(row.publish_latency) * count; publishLatencyRows += count; }
    }
    const age = (at: string | null) => at && Number.isFinite(Date.parse(at)) ? Math.max(0, nowMs - Date.parse(at)) : null;
    const awaitingAge = age(oldestAwaitingReplyAt); const replyAge = age(oldestReplyReadyAt);
    const awaitingDegraded = thresholds.awaitingDegradedMs ?? 10 * 60_000; const awaitingUnhealthy = thresholds.awaitingUnhealthyMs ?? 2 * 60 * 60_000;
    const replyDegraded = thresholds.replyDegradedMs ?? 30_000; const replyUnhealthy = thresholds.replyUnhealthyMs ?? 15 * 60_000;
    const failedCount = (counts.integrity_halt ?? 0) + (counts.failed ?? 0); const retryCount = (counts.retry_wait ?? 0) + (counts.blocked_auth ?? 0);
    const healthStatus = failedCount > 0 || (awaitingAge ?? 0) >= awaitingUnhealthy || (replyAge ?? 0) >= replyUnhealthy ? 'unhealthy'
      : (awaitingAge ?? 0) >= awaitingDegraded || (replyAge ?? 0) >= replyDegraded || retryCount > 0 ? 'degraded' : 'healthy';
    return { counts, oldestAwaitingReplyAt, oldestAwaitingReplyAgeMs: awaitingAge, oldestReplyReadyAt, oldestReplyReadyAgeMs: replyAge,
      retryCount, failedCount, attemptCount, publishedCount: (counts.published ?? 0) + (counts.completed ?? 0),
      averageReplyLatencyMs: replyLatencyRows ? Math.round(replyLatencyTotal / replyLatencyRows) : null,
      averagePublishLatencyMs: publishLatencyRows ? Math.round(publishLatencyTotal / publishLatencyRows) : null, healthStatus };
  }

  audit(): Array<{ turnId: string; state: DirectChatTurnState; classification: string; detail: string }> {
    return this.listRecoverable().map((record) => {
      if (!record.subscriptionId || !record.workspaceId || !record.channelId || !record.threadId || !record.agentNpub) {
        return { turnId: record.turnId, state: record.state, classification: 'quarantine_missing_binding', detail: 'Immutable publication binding is incomplete.' };
      }
      if (record.replyBody && !record.payloadHash) return { turnId: record.turnId, state: record.state, classification: 'freeze_known_reply', detail: 'Known reply can be frozen and reconciled through Tower idempotency.' };
      if (record.replyBody) return { turnId: record.turnId, state: record.state, classification: 'reconcile_known_reply', detail: 'Frozen reply can be published or reconciled idempotently.' };
      if (!record.sessionId) return { turnId: record.turnId, state: record.state, classification: 'quarantine_missing_session_evidence', detail: 'Awaiting delivery has no response source.' };
      return { turnId: record.turnId, state: record.state, classification: 'reconcile_awaiting_reply', detail: 'Inspect the saved session transcript at the accepted prompt boundary.' };
    });
  }

  private backfillBindings(): void {
    const hasIntercepts = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_intercept_state'").get();
    if (hasIntercepts) this.db.exec(`UPDATE agent_direct_chat_turns SET
      subscription_id=COALESCE(subscription_id,(SELECT subscription_id FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      tower_service_npub=COALESCE(tower_service_npub,(SELECT tower_service_npub FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      workspace_id=COALESCE(workspace_id,(SELECT workspace_id FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      source_app_npub=COALESCE(source_app_npub,(SELECT source_app_npub FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      channel_id=COALESCE(channel_id,(SELECT channel_id FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      thread_id=COALESCE(thread_id,(SELECT thread_id FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      agent_id=COALESCE(agent_id,(SELECT agent_id FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      agent_npub=COALESCE(agent_npub,(SELECT target_bot_npub FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      session_id=COALESCE(session_id,(SELECT session_id FROM chat_intercept_state i WHERE i.routing_key=agent_direct_chat_turns.routing_key)),
      trigger_message_id=COALESCE(trigger_message_id,json_extract(source_message_ids_json,'$[#-1]')),
      received_at=COALESCE(received_at,created_at),accepted_at=COALESCE(accepted_at,CASE WHEN state='accepted' THEN created_at END),
      reply_ready_at=COALESCE(reply_ready_at,CASE WHEN reply_body IS NOT NULL THEN updated_at END),
      published_at=COALESCE(published_at,CASE WHEN state='completed' AND published_message_id IS NOT NULL THEN updated_at END),
      next_attempt_at=COALESCE(next_attempt_at,updated_at)`);
    const hasSubscriptions = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_subscriptions'").get();
    if (hasSubscriptions) this.db.exec(`UPDATE agent_direct_chat_turns SET
      backend_base_url=COALESCE(backend_base_url,(SELECT backend_base_url FROM workspace_subscriptions s WHERE s.subscription_id=agent_direct_chat_turns.subscription_id)),
      tower_service_npub=COALESCE(tower_service_npub,(SELECT tower_service_npub FROM workspace_subscriptions s WHERE s.subscription_id=agent_direct_chat_turns.subscription_id)),
      workspace_id=COALESCE(workspace_id,(SELECT workspace_id FROM workspace_subscriptions s WHERE s.subscription_id=agent_direct_chat_turns.subscription_id)),
      source_app_npub=COALESCE(source_app_npub,(SELECT source_app_npub FROM workspace_subscriptions s WHERE s.subscription_id=agent_direct_chat_turns.subscription_id))`);
    const hasLegacy = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='flightdeck_session_turn_publications'").get();
    if (hasLegacy) this.db.exec(`UPDATE agent_direct_chat_turns AS d SET
      session_id=COALESCE((SELECT p.session_id FROM flightdeck_session_turn_publications p WHERE p.turn_id=d.turn_id),session_id),
      prompt=COALESCE(prompt,(SELECT NULLIF(p.prompt,'') FROM flightdeck_session_turn_publications p WHERE p.turn_id=d.turn_id)),
      prompt_type=COALESCE(prompt_type,'direct_chat')
      WHERE EXISTS (SELECT 1 FROM flightdeck_session_turn_publications p WHERE p.turn_id=d.turn_id);
      UPDATE agent_direct_chat_turns AS d SET state='integrity_halt',last_error_class='legacy_publication_mismatch',
      last_error='Legacy publication evidence uses the same turn with a different client request id or reply body.',next_attempt_at=NULL
      WHERE d.state NOT IN ('completed','published','suppressed','integrity_halt') AND EXISTS (SELECT 1 FROM flightdeck_session_turn_publications p
        WHERE p.turn_id=d.turn_id AND p.state='completed' AND p.published_message_id IS NOT NULL
        AND (p.client_request_id!=d.client_request_id OR (d.reply_body IS NOT NULL AND p.reply_body!=d.reply_body)));
      UPDATE agent_direct_chat_turns AS d SET state='published',published_message_id=(SELECT p.published_message_id FROM flightdeck_session_turn_publications p WHERE p.turn_id=d.turn_id),
      published_at=COALESCE(published_at,(SELECT p.updated_at FROM flightdeck_session_turn_publications p WHERE p.turn_id=d.turn_id)),last_error=NULL,last_error_class=NULL
      WHERE d.state NOT IN ('completed','published','suppressed') AND EXISTS (SELECT 1 FROM flightdeck_session_turn_publications p WHERE p.turn_id=d.turn_id AND p.state='completed'
        AND p.published_message_id IS NOT NULL AND p.client_request_id=d.client_request_id AND (d.reply_body IS NULL OR p.reply_body=d.reply_body));`);
  }

  private requeueLegacySubscriptionSignerHalts(): void {
    this.db.exec(`UPDATE agent_direct_chat_turns SET state='retry_wait',next_attempt_at=updated_at,
      lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,last_error_class=NULL
      WHERE state='integrity_halt' AND last_error_class='agent_identity_mismatch'
        AND publication_payload_json IS NOT NULL AND agent_id IS NOT NULL AND agent_npub IS NOT NULL`);
  }

  private map(row: Record<string, unknown>): DirectChatTurnRecord {
    let sourceMessageIds: string[] = []; let publicationPayload: DirectChatPublicationPayload | null = null;
    try { sourceMessageIds = JSON.parse(String(row.source_message_ids_json ?? '[]')); } catch {}
    try { publicationPayload = row.publication_payload_json ? JSON.parse(String(row.publication_payload_json)) : null; } catch {}
    const text = (key: string) => typeof row[key] === 'string' ? String(row[key]) : null;
    return { turnId: String(row.turn_id), routingKey: String(row.routing_key), sourceMessageIds,
      clientRequestId: String(row.client_request_id), replyBody: text('reply_body'), publishedMessageId: text('published_message_id'),
      state: String(row.state) as DirectChatTurnState, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      subscriptionId: text('subscription_id'), backendBaseUrl: text('backend_base_url'), towerServiceNpub: text('tower_service_npub'),
      workspaceId: text('workspace_id'), sourceAppNpub: text('source_app_npub'), channelId: text('channel_id'), threadId: text('thread_id'),
      agentId: text('agent_id'), agentNpub: text('agent_npub'), sessionId: text('session_id'), prompt: text('prompt'), promptType: text('prompt_type'),
      triggerMessageId: text('trigger_message_id'), publicationPayload, payloadHash: text('payload_hash'), attemptCount: Number(row.attempt_count ?? 0),
      nextAttemptAt: text('next_attempt_at'), leaseOwner: text('lease_owner'), leaseExpiresAt: text('lease_expires_at'),
      lastError: text('last_error'), lastErrorClass: text('last_error_class'), receivedAt: text('received_at'), acceptedAt: text('accepted_at'),
      replyReadyAt: text('reply_ready_at'), publishedAt: text('published_at') };
  }
}

function oldest(left: string | null, right: string): string { return !left || right < left ? right : left; }

export const directChatTurnStore = new DirectChatTurnStore();
