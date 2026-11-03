import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { databaseFile } from '../storage/database-path';
import { agentInboxScope } from './agent-inbox-scope';
import { agentInboxStore, type AgentInboxEnvelopeLike, type AgentInboxStore } from './agent-inbox-store';

/**
 * Which strict-inbox notification an agent session (or pipeline run, or dispatched worker) is acting for.
 *
 * Session tool calls carry only a session id, so the acting notification is recorded server-side:
 * - session: one row per ACTIVATED turn. The Flight Deck runtimes queue work per routing key and deliver a turn only once
 *   the previous one finished; the row is written when the turn's prompt is actually sent (after prompt readiness) from
 *   that turn's own trigger event id (inbox-synthesized events carry the notification id), and retracted when the send
 *   fails. A merely queued notification never changes the session's origin. A turn without a notification (legacy
 *   runtime path, recovery without an event) is recorded as UNBOUND, so a session never keeps acting for a stale origin.
 * - run: one immutable row, recorded when a pipeline run is created during dispatch. The router is awaited inline by
 *   the dispatch (before the outcome is recorded), so the dispatch scope identifies the notification exactly.
 * - worker: one immutable row, the parent's current origin snapshotted when a supervised worker is dispatched.
 * Rows are written only by server code, never from session metadata (session APIs can patch metadata).
 */
export type InboxOriginOwnerKind = 'session' | 'run' | 'worker';
export interface InboxOrigin { subscriptionId: string; notificationId: string }
/** A turn about to be delivered for a Flight Deck trigger: the subscription and the trigger event id (if any). */
export interface InboxTurn { subscriptionId: string; eventId: string | null | undefined }

type OriginRow = { subscriptionId: string; notificationId: string | null };

export class AgentInboxOriginStore {
  private readonly db: Database;
  private schemaReady = false;

  /** Opening never writes; the table is created on the first recorded origin. */
  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  private hasSchema(): boolean {
    if (this.schemaReady) return true;
    return Boolean(this.db.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'agent_inbox_origins'").get());
  }

  private ensureSchema() {
    if (this.schemaReady) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_inbox_origins (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('session', 'run', 'worker')),
        owner_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        notification_id TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_inbox_origins_owner ON agent_inbox_origins (owner_kind, owner_id, row_id);
    `);
    this.schemaReady = true;
  }

  /** The session's turn for this notification (or an unbound turn) is being delivered now; returns the row id. */
  recordTurn(sessionId: string, turn: { subscriptionId: string; notificationId: string | null }): number {
    this.ensureSchema();
    const result = this.db.query('INSERT INTO agent_inbox_origins (owner_kind, owner_id, subscription_id, notification_id, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .run('session', sessionId, turn.subscriptionId, turn.notificationId, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /** The turn's prompt was never delivered: the session keeps acting for its previous turn. */
  retractTurn(rowId: number) {
    if (!this.hasSchema()) return;
    this.db.query("DELETE FROM agent_inbox_origins WHERE row_id = ?1 AND owner_kind = 'session'").run(rowId);
  }

  /** A run's origin is fixed at creation; later calls never replace it. */
  recordRun(runId: string, origin: InboxOrigin) {
    this.recordOnce('run', runId, origin);
  }

  /** A worker's origin is the parent's snapshot at dispatch; later calls never replace it. */
  recordWorker(workerSessionId: string, origin: InboxOrigin) {
    this.recordOnce('worker', workerSessionId, origin);
  }

  private recordOnce(kind: 'run' | 'worker', ownerId: string, origin: InboxOrigin) {
    this.ensureSchema();
    this.db.query(`INSERT INTO agent_inbox_origins (owner_kind, owner_id, subscription_id, notification_id, recorded_at)
      SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM agent_inbox_origins WHERE owner_kind = ?1 AND owner_id = ?2)`)
      .run(kind, ownerId, origin.subscriptionId, origin.notificationId, new Date().toISOString());
  }

  /** Session turns newest first (unbound turns included); a run or worker has exactly one immutable row. */
  history(kind: InboxOriginOwnerKind, ownerId: string): OriginRow[] {
    if (!this.hasSchema()) return [];
    const once = kind !== 'session';
    const rows = this.db.query(`SELECT subscription_id, notification_id FROM agent_inbox_origins WHERE owner_kind = ?1 AND owner_id = ?2 ORDER BY row_id ${once ? 'ASC' : 'DESC'}`)
      .all(kind, ownerId) as Array<{ subscription_id: string; notification_id: string | null }>;
    const list = rows.map((row) => ({ subscriptionId: row.subscription_id, notificationId: row.notification_id }));
    return once ? list.slice(0, 1) : list;
  }
}

let shared: AgentInboxOriginStore | null = null;
export function agentInboxOriginStore(): AgentInboxOriginStore {
  return testStores?.origins ?? (shared ??= new AgentInboxOriginStore());
}

// Tests only: runtime paths that record turns use the shared stores; this points them at disposable databases.
let testStores: { inbox: AgentInboxStore; origins: AgentInboxOriginStore } | null = null;
export function setAgentInboxOriginStoresForTests(stores: { inbox: AgentInboxStore; origins: AgentInboxOriginStore } | null) {
  testStores = stores;
}
const inboxState = (): AgentInboxStore => testStores?.inbox ?? agentInboxStore();

// In-process ownership of running dispatch attempts. A write made inline by the current turn (before the attempt records
// its outcome) acts for exactly this attempt. Reference-counted, so an overlapping retry of the same notification (for
// example an old poll loop finishing after a reconnect) never ends the other attempt's ownership. Lost on restart.
const activeAttempts = new Map<string, number>();
const attemptKey = (subscriptionId: string, notificationId: string) => `${subscriptionId}\u0000${notificationId}`;

export function beginActiveInboxAttempt(subscriptionId: string, notificationId: string): () => void {
  const key = attemptKey(subscriptionId, notificationId);
  activeAttempts.set(key, (activeAttempts.get(key) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (activeAttempts.get(key) ?? 1) - 1;
    if (remaining > 0) activeAttempts.set(key, remaining);
    else activeAttempts.delete(key);
  };
}

export function isActiveInboxAttempt(subscriptionId: string, notificationId: string): boolean {
  return (activeAttempts.get(attemptKey(subscriptionId, notificationId)) ?? 0) > 0;
}

/** The notification the inbox processor is dispatching right now (never a helper-call scope). */
export function currentDispatchOrigin(): InboxOrigin | null {
  const scope = agentInboxScope.getStore();
  return scope?.subscriptionId && scope.dispatch ? { subscriptionId: scope.subscriptionId, notificationId: scope.notification.id } : null;
}

/** Inbox-synthesized events use the notification id (a full review request adds a `:review` sibling event). */
export function notificationIdForEvent(eventId: string | null | undefined): string | null {
  const id = eventId?.trim();
  if (!id) return null;
  return id.endsWith(':review') ? id.slice(0, -':review'.length) : id;
}

/**
 * Records the turn being delivered to a strict-inbox session (no-op for legacy subscriptions). Returns the row id so the
 * caller can retract it when the prompt is not delivered.
 */
export function recordInboxTurn(sessionId: string, turn: InboxTurn | null | undefined,
  stores: { inbox?: Pick<AgentInboxStore, 'isInboxRequired'>; origins?: Pick<AgentInboxOriginStore, 'recordTurn'> } = {}): number | null {
  if (!turn?.subscriptionId || !(stores.inbox ?? inboxState()).isInboxRequired(turn.subscriptionId)) return null;
  return (stores.origins ?? agentInboxOriginStore()).recordTurn(sessionId, { subscriptionId: turn.subscriptionId, notificationId: notificationIdForEvent(turn.eventId) });
}

export function retractInboxTurn(rowId: number | null, store?: Pick<AgentInboxOriginStore, 'retractTurn'>) {
  if (rowId !== null) (store ?? agentInboxOriginStore()).retractTurn(rowId);
}

/** Records a pipeline run's origin when the run is created during strict-inbox dispatch. No-op otherwise. */
export function recordInboxRunOrigin(runId: string, store?: Pick<AgentInboxOriginStore, 'recordRun'>) {
  const origin = currentDispatchOrigin();
  if (origin) (store ?? agentInboxOriginStore()).recordRun(runId, origin);
}

export type OriginRefusalCode = 'agent_inbox_no_origin' | 'agent_inbox_origin_expired';
export type LiveOrigin = { ok: true; origin: InboxOrigin; envelope: AgentInboxEnvelopeLike } | { ok: false; code: OriginRefusalCode };

const instant = (value: unknown) => (typeof value === 'string' && value ? Date.parse(value) : Number.NaN);

/**
 * Whether an origin may still act (fail closed on anything missing or malformed). Live means: the subscription is an
 * established strict inbox (mode, Tower subscription, valid floor); the notification is recorded for it with a valid
 * occurrence time at or after the floor and is not revoked; and either this process is dispatching that attempt right
 * now (before its outcome is recorded) or its recorded outcome is `handled`. Failed, suppressed, source-gone, unknown,
 * revoked and pre-floor notifications are never live, and there is no renewal. Tower re-checks for classified bots.
 */
export function liveInboxOrigin(origin: InboxOrigin | null, store: Pick<AgentInboxStore, 'bindingRecord' | 'get'> = inboxState()): LiveOrigin {
  if (!origin) return { ok: false, code: 'agent_inbox_no_origin' };
  const state = store.get(origin.subscriptionId);
  const floorAt = instant(state?.floorAt);
  if (!state || state.mode !== 'inbox_required' || !state.towerSubscriptionId || !Number.isFinite(floorAt)) return { ok: false, code: 'agent_inbox_origin_expired' };
  const record = store.bindingRecord(origin.subscriptionId, origin.notificationId);
  if (!record) return { ok: false, code: 'agent_inbox_no_origin' };
  const envelope = record.envelope;
  if (envelope.id !== origin.notificationId || envelope.state !== 'active') return { ok: false, code: 'agent_inbox_origin_expired' };
  const occurredAt = instant((envelope as { occurred_at?: unknown }).occurred_at);
  if (!Number.isFinite(occurredAt) || occurredAt < floorAt) return { ok: false, code: 'agent_inbox_origin_expired' };
  const active = !record.handledAt && isActiveInboxAttempt(origin.subscriptionId, origin.notificationId);
  if (!active && record.outcome !== 'handled') return { ok: false, code: 'agent_inbox_origin_expired' };
  return { ok: true, origin, envelope };
}

export interface InboxLocation { channelId?: string | null; threadId?: string | null; taskId?: string | null; docId?: string | null }

/** Same location rules as before: a thread, task or document the notification is sourced in, or its channel for creations. */
export function originCovers(envelope: AgentInboxEnvelopeLike, where: InboxLocation & { channelOnly?: boolean }): boolean {
  const source = envelope.source;
  if (!source) return false;
  if (where.channelOnly) return Boolean(where.channelId && source.channel_id === where.channelId);
  if (where.taskId) return source.task_id === where.taskId;
  if (where.docId) return source.doc_id === where.docId;
  if (where.threadId) return source.thread_id === where.threadId && (!where.channelId || source.channel_id === where.channelId);
  if (where.channelId) return source.channel_id === where.channelId && !source.thread_id && !source.task_id && !source.doc_id;
  return false;
}

/**
 * Who a helper call acts for. A dispatched worker acts only for its dispatch snapshot and a pipeline-run session only for
 * its run's origin: a missing snapshot is never replaced by session turns. Other sessions act for their turns.
 */
export interface InboxOriginOwner { sessionId: string; subscriptionId: string; runId?: string | null; worker?: boolean }

function ownerRows(owner: InboxOriginOwner, store: Pick<AgentInboxOriginStore, 'history'>): OriginRow[] {
  // A recorded worker snapshot is authoritative even if the session's (patchable) role metadata no longer says so.
  const worker = store.history('worker', owner.sessionId);
  const rows = worker.length || owner.worker ? worker
    : owner.runId ? store.history('run', owner.runId)
      : store.history('session', owner.sessionId);
  return rows.filter((row) => row.subscriptionId === owner.subscriptionId);
}

/** Candidate origins for reads: the current one first, then earlier turns of the same session (never another owner). */
export function inboxOriginCandidates(owner: InboxOriginOwner, store: Pick<AgentInboxOriginStore, 'history'> = agentInboxOriginStore()): InboxOrigin[] {
  return ownerRows(owner, store).filter((row): row is InboxOrigin => Boolean(row.notificationId));
}

/** A pipeline run's own origin (immutable), or null. */
export function runInboxOrigin(runId: string, subscriptionId: string, store: Pick<AgentInboxOriginStore, 'history'> = agentInboxOriginStore()): InboxOrigin | null {
  const row = store.history('run', runId).find((entry) => entry.subscriptionId === subscriptionId);
  return row?.notificationId ? { subscriptionId: row.subscriptionId, notificationId: row.notificationId } : null;
}

/** The single origin the owner acts for right now; null when there is none or the current turn is unbound. */
export function currentInboxOrigin(owner: InboxOriginOwner, store: Pick<AgentInboxOriginStore, 'history'> = agentInboxOriginStore()): InboxOrigin | null {
  const current = ownerRows(owner, store)[0];
  return current?.notificationId ? { subscriptionId: current.subscriptionId, notificationId: current.notificationId } : null;
}

/**
 * Snapshots a supervising session's CURRENT origin for its dispatched worker (immutable). Nothing is recorded when the
 * parent has no origin, and the worker then acts for nothing; it never falls back to session turns.
 */
export function snapshotWorkerInboxOrigin(parent: { id: string; metadata?: { flightdeckSubscriptionId?: string; role?: string } | null }, workerSessionId: string,
  store: Pick<AgentInboxOriginStore, 'history' | 'recordWorker'> = agentInboxOriginStore()) {
  const subscriptionId = parent.metadata?.flightdeckSubscriptionId;
  if (!subscriptionId) return;
  const origin = currentInboxOrigin({ sessionId: parent.id, subscriptionId, worker: parent.metadata?.role === 'dispatched-worker' }, store);
  if (origin) store.recordWorker(workerSessionId, origin);
}
