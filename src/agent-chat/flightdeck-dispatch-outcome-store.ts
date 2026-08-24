import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import {
  FLIGHT_DECK_GENUINE_FAILURE_LABEL,
  FLIGHT_DECK_PROVISIONAL_TIMEOUT_LABEL,
  FLIGHT_DECK_RECOVERED_SUCCESS_LABEL,
  FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED,
  resolveFlightDeckDispatchReason,
} from './flightdeck-dispatch-metadata';
import type { AgentChatDispatchHistoryEntry } from './types';
import { isSessionWaitTimeout } from './flightdeck-dispatch-lifecycle';
import { initialiseFlightDeckDispatchOutcomeSchema } from './flightdeck-dispatch-outcome-schema';
import {
  isPipelineDispatchLaunch,
  outcomeForDispatchHistory,
  outcomeKeyForDispatchHistory,
  triggerForDispatchHistory,
} from './flightdeck-dispatch-outcome-helpers';

export type FlightDeckDispatchTrigger = 'chat' | 'task' | 'doc';
export type FlightDeckDispatchAction = 'pipeline' | 'session';
export type FlightDeckDispatchOutcome = 'queued' | 'launched' | 'suppressed' | 'ignored' | 'failed';

export interface FlightDeckDispatchOutcomeRecord {
  id: number;
  outcomeKey: string;
  subscriptionId: string;
  receivedAt: string;
  trigger: FlightDeckDispatchTrigger;
  outcome: FlightDeckDispatchOutcome;
  action: FlightDeckDispatchAction | null;
  actionId: string | null;
  recordId: string;
  agentId: string;
  dispatchAction: string;
  status: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  sourceLabel: string;
  details: Record<string, unknown> | null;
  updatedAt: string;
}

export interface FlightDeckDispatchOutcomePage {
  rows: FlightDeckDispatchOutcomeRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface RecordFlightDeckSessionOutcomeInput {
  subscriptionId: string;
  recordId: string;
  agentId: string;
  sessionId: string;
  receivedAt?: string;
  sourceLabel?: string | null;
  details?: Record<string, unknown> | null;
}

export type RecordFlightDeckSessionQueuedInput = Omit<RecordFlightDeckSessionOutcomeInput, 'sessionId'>;

export interface RecordFlightDeckSessionRecoveryInput extends RecordFlightDeckSessionOutcomeInput {
  evidence: 'final_turn' | 'flightdeck_delivery';
  publishedMessageId?: string | null;
}

const DEFAULT_DB_PATH = databaseFile;

export class FlightDeckDispatchOutcomeStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  recordHistory(subscriptionId: string, entry: AgentChatDispatchHistoryEntry): FlightDeckDispatchOutcomeRecord | null {
    const trigger = triggerForDispatchHistory(entry);
    const recordId = entry.recordId ?? entry.bindingId;
    if (!trigger || !recordId) return null;
    if (entry.kind === 'chat' && entry.action === 'chat_dispatch' && !entry.sessionId) return null;
    const action: FlightDeckDispatchAction | null = entry.sessionId
      ? 'session'
      : isPipelineDispatchLaunch(entry)
        ? 'pipeline'
        : null;
    const actionId = action === 'session' ? entry.sessionId ?? null : action === 'pipeline' ? entry.pipelineRunId ?? null : null;
    const reason = resolveFlightDeckDispatchReason(entry);
    return this.save({
      outcomeKey: `${subscriptionId}:${outcomeKeyForDispatchHistory(entry)}`,
      subscriptionId,
      receivedAt: entry.at,
      trigger,
      outcome: outcomeForDispatchHistory(entry, action),
      action,
      actionId,
      recordId,
      agentId: entry.agentId,
      dispatchAction: entry.action,
      status: entry.status ?? null,
      reasonCode: reason.code,
      reasonLabel: reason.label,
      sourceLabel: entry.sourceLabel?.trim() || FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED,
      details: entry.details ?? null,
    });
  }

  recordSession(input: RecordFlightDeckSessionOutcomeInput): FlightDeckDispatchOutcomeRecord {
    return this.save({
      outcomeKey: `${input.subscriptionId}:${input.agentId}:${input.recordId}:session`,
      subscriptionId: input.subscriptionId,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      trigger: 'chat',
      outcome: 'launched',
      action: 'session',
      actionId: input.sessionId,
      recordId: input.recordId,
      agentId: input.agentId,
      dispatchAction: 'chat_dispatch',
      status: 'running',
      reasonCode: null,
      reasonLabel: null,
      sourceLabel: input.sourceLabel?.trim() || FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED,
      details: input.details ?? null,
    });
  }

  recordSessionQueued(input: RecordFlightDeckSessionQueuedInput): FlightDeckDispatchOutcomeRecord {
    return this.save({
      outcomeKey: `${input.subscriptionId}:${input.agentId}:${input.recordId}:session`,
      subscriptionId: input.subscriptionId,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      trigger: 'chat',
      outcome: 'queued',
      action: null,
      actionId: null,
      recordId: input.recordId,
      agentId: input.agentId,
      dispatchAction: 'chat_dispatch_queued',
      status: 'queued',
      reasonCode: 'session_creation_pending',
      reasonLabel: 'Waiting for durable session',
      sourceLabel: input.sourceLabel?.trim() || FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED,
      details: input.details ?? null,
    });
  }

  recordSessionFailure(input: Omit<RecordFlightDeckSessionOutcomeInput, 'sessionId'> & {
    error: string;
    reasonCode?: string;
    reasonLabel?: string;
  }): FlightDeckDispatchOutcomeRecord {
    return this.save({
      outcomeKey: `${input.subscriptionId}:${input.agentId}:${input.recordId}:session`,
      subscriptionId: input.subscriptionId,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      trigger: 'chat',
      outcome: 'failed',
      action: null,
      actionId: null,
      recordId: input.recordId,
      agentId: input.agentId,
      dispatchAction: 'chat_session_failed',
      status: 'failed',
      reasonCode: input.reasonCode ?? 'dispatch_failed',
      reasonLabel: input.reasonLabel ?? FLIGHT_DECK_GENUINE_FAILURE_LABEL,
      sourceLabel: input.sourceLabel?.trim() || FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED,
      details: { ...(input.details ?? {}), error: input.error },
    });
  }

  recordSessionWaitTimeout(input: RecordFlightDeckSessionOutcomeInput & { error: string }): FlightDeckDispatchOutcomeRecord {
    const outcomeKey = `${input.subscriptionId}:${input.agentId}:${input.recordId}:session`;
    const existingRow = this.db.query('SELECT * FROM flightdeck_dispatch_outcomes WHERE outcome_key = ?1').get(outcomeKey);
    const existing = existingRow ? this.mapRow(existingRow as Record<string, string | number | null>) : null;
    return this.save({
      outcomeKey,
      subscriptionId: input.subscriptionId,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      trigger: 'chat',
      outcome: 'launched',
      action: 'session',
      actionId: input.sessionId,
      recordId: input.recordId,
      agentId: input.agentId,
      dispatchAction: 'chat_session_wait_timeout',
      status: 'waiting',
      reasonCode: 'provisional_timeout',
      reasonLabel: FLIGHT_DECK_PROVISIONAL_TIMEOUT_LABEL,
      sourceLabel: input.sourceLabel?.trim() || FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED,
      details: appendTimeoutDiagnostic({ ...(existing?.details ?? {}), ...(input.details ?? {}) }, input.error),
    });
  }

  recordSessionRecovered(input: RecordFlightDeckSessionRecoveryInput): FlightDeckDispatchOutcomeRecord | null {
    const outcomeKey = `${input.subscriptionId}:${input.agentId}:${input.recordId}:session`;
    const existingRow = this.db.query('SELECT * FROM flightdeck_dispatch_outcomes WHERE outcome_key = ?1').get(outcomeKey);
    if (!existingRow) return null;
    const existing = this.mapRow(existingRow as Record<string, string | number | null>);
    const timeoutError = typeof existing.details?.error === 'string' ? existing.details.error : null;
    if (existing.reasonCode === 'recovered_success') return null;
    if (existing.reasonCode !== 'provisional_timeout' && !isSessionWaitTimeout(timeoutError)) return null;
    const recoveredAt = new Date().toISOString();
    return this.save({
      outcomeKey,
      subscriptionId: input.subscriptionId,
      receivedAt: existing.receivedAt,
      trigger: 'chat',
      outcome: 'launched',
      action: 'session',
      actionId: existing.actionId ?? input.sessionId,
      recordId: input.recordId,
      agentId: input.agentId,
      dispatchAction: 'chat_session_recovered',
      status: 'recovered',
      reasonCode: 'recovered_success',
      reasonLabel: FLIGHT_DECK_RECOVERED_SUCCESS_LABEL,
      sourceLabel: input.sourceLabel?.trim() || existing.sourceLabel,
      details: {
        ...(existing.details ?? {}),
        recovery: {
          evidence: input.evidence,
          recovered_at: recoveredAt,
          ...(input.publishedMessageId ? { published_message_id: input.publishedMessageId } : {}),
        },
      },
    });
  }

  listPage(
    subscriptionIds: string[],
    input: { limit: number; offset: number; includeIgnoredAndSuppressed?: boolean },
  ): FlightDeckDispatchOutcomePage {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    const offset = Math.max(0, Math.floor(input.offset));
    if (subscriptionIds.length === 0) return { rows: [], total: 0, limit, offset };
    const placeholders = subscriptionIds.map((_, index) => `?${index + 1}`).join(', ');
    const outcomeFilter = input.includeIgnoredAndSuppressed === false
      ? " AND outcome NOT IN ('ignored', 'suppressed')"
      : '';
    const totalRow = this.db.query(
      `SELECT COUNT(*) AS total FROM flightdeck_dispatch_outcomes
       WHERE subscription_id IN (${placeholders})${outcomeFilter}`,
    ).get(...subscriptionIds) as { total?: number } | null;
    const rows = this.db.query(
      `SELECT * FROM flightdeck_dispatch_outcomes
       WHERE subscription_id IN (${placeholders})${outcomeFilter}
       ORDER BY received_at DESC, id DESC
       LIMIT ?${subscriptionIds.length + 1} OFFSET ?${subscriptionIds.length + 2}`,
    ).all(...subscriptionIds, limit, offset) as Array<Record<string, string | number | null>>;
    return {
      rows: rows.map((row) => this.mapRow(row)),
      total: Number(totalRow?.total ?? 0),
      limit,
      offset,
    };
  }

  private save(input: Omit<FlightDeckDispatchOutcomeRecord, 'id' | 'updatedAt'>): FlightDeckDispatchOutcomeRecord {
    const updatedAt = new Date().toISOString();
    this.db.query(
      `INSERT INTO flightdeck_dispatch_outcomes (
         outcome_key, subscription_id, received_at, trigger, outcome, action, action_id,
         record_id, agent_id, dispatch_action, status, reason_code, reason_label, source_label,
         details_json, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(outcome_key) DO UPDATE SET
         received_at = MIN(flightdeck_dispatch_outcomes.received_at, excluded.received_at),
         outcome = CASE WHEN excluded.outcome IN ('launched', 'failed') THEN excluded.outcome ELSE flightdeck_dispatch_outcomes.outcome END,
         action = COALESCE(excluded.action, flightdeck_dispatch_outcomes.action),
         action_id = COALESCE(excluded.action_id, flightdeck_dispatch_outcomes.action_id),
         dispatch_action = excluded.dispatch_action,
         status = excluded.status,
         reason_code = CASE
           WHEN excluded.reason_code IS NOT NULL THEN excluded.reason_code
           WHEN flightdeck_dispatch_outcomes.reason_code IN ('provisional_timeout', 'recovered_success')
             THEN flightdeck_dispatch_outcomes.reason_code
           WHEN excluded.outcome = 'launched' THEN NULL
           ELSE COALESCE(excluded.reason_code, flightdeck_dispatch_outcomes.reason_code)
         END,
         reason_label = CASE
           WHEN excluded.reason_label IS NOT NULL THEN excluded.reason_label
           WHEN flightdeck_dispatch_outcomes.reason_code IN ('provisional_timeout', 'recovered_success')
             THEN flightdeck_dispatch_outcomes.reason_label
           WHEN excluded.outcome = 'launched' THEN NULL
           ELSE COALESCE(excluded.reason_label, flightdeck_dispatch_outcomes.reason_label)
         END,
         source_label = CASE
           WHEN excluded.source_label = '${FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED}' THEN flightdeck_dispatch_outcomes.source_label
           ELSE excluded.source_label
         END,
         details_json = excluded.details_json,
         updated_at = excluded.updated_at`,
    ).run(
      input.outcomeKey,
      input.subscriptionId,
      input.receivedAt,
      input.trigger,
      input.outcome,
      input.action,
      input.actionId,
      input.recordId,
      input.agentId,
      input.dispatchAction,
      input.status,
      input.reasonCode,
      input.reasonLabel,
      input.sourceLabel,
      input.details ? JSON.stringify(input.details) : null,
      updatedAt,
    );
    const row = this.db.query('SELECT * FROM flightdeck_dispatch_outcomes WHERE outcome_key = ?1').get(input.outcomeKey);
    if (!row) throw new Error(`Failed to persist Flight Deck dispatch outcome ${input.outcomeKey}.`);
    return this.mapRow(row as Record<string, string | number | null>);
  }

  private mapRow(row: Record<string, string | number | null>): FlightDeckDispatchOutcomeRecord {
    let details: Record<string, unknown> | null = null;
    if (typeof row.details_json === 'string') {
      try {
        const parsed = JSON.parse(row.details_json) as unknown;
        details = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch {
        details = null;
      }
    }
    const historicalReason = resolveFlightDeckDispatchReason({
      at: String(row.received_at),
      kind: String(row.trigger) === 'doc' ? 'document' : String(row.trigger) as 'chat' | 'task',
      action: String(row.dispatch_action),
      agentId: String(row.agent_id),
      sessionId: typeof row.action_id === 'string' && row.action === 'session' ? row.action_id : null,
      recordId: String(row.record_id),
      status: typeof row.status === 'string' ? row.status : String(row.outcome),
      details,
    });
    return {
      id: Number(row.id),
      outcomeKey: String(row.outcome_key),
      subscriptionId: String(row.subscription_id),
      receivedAt: String(row.received_at),
      trigger: String(row.trigger) as FlightDeckDispatchTrigger,
      outcome: String(row.outcome) as FlightDeckDispatchOutcome,
      action: row.action ? String(row.action) as FlightDeckDispatchAction : null,
      actionId: typeof row.action_id === 'string' ? row.action_id : null,
      recordId: String(row.record_id),
      agentId: String(row.agent_id),
      dispatchAction: String(row.dispatch_action),
      status: typeof row.status === 'string' ? row.status : null,
      reasonCode: typeof row.reason_code === 'string' ? row.reason_code : historicalReason.code,
      reasonLabel: typeof row.reason_label === 'string' ? row.reason_label : historicalReason.label,
      sourceLabel: typeof row.source_label === 'string' && row.source_label.trim()
        ? row.source_label
        : FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED,
      details,
      updatedAt: String(row.updated_at),
    };
  }

  private initialise(): void {
    initialiseFlightDeckDispatchOutcomeSchema(this.db);
  }
}

function appendTimeoutDiagnostic(details: Record<string, unknown> | null | undefined, error: string): Record<string, unknown> {
  const diagnostics = Array.isArray(details?.diagnostic_history) ? [...details.diagnostic_history] : [];
  if (!diagnostics.some((entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).code === 'session_wait_timeout'
  ))) {
    diagnostics.push({ code: 'session_wait_timeout', message: error, recorded_at: new Date().toISOString() });
  }
  return { ...(details ?? {}), error, diagnostic_history: diagnostics };
}

export const flightDeckDispatchOutcomeStore = new FlightDeckDispatchOutcomeStore();
