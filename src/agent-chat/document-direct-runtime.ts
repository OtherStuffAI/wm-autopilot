import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AgentType } from '../config';
import { isAgentType } from '../agent-types';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { databaseFile } from '../storage/message-store';
import type { AgentDefinitionStore } from './agent-definition-store';
import { sendPromptAndAwaitFinalResponse } from './session-runtime-session-ops';
import {
  decodeFlightDeckPgDocumentBody,
  fetchFlightDeckPgChannel,
  fetchFlightDeckPgDocument,
  fetchFlightDeckPgDocumentComments,
  type FlightDeckPgEvent,
} from './tower-client';
import type { AgentDefinitionRecord, RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';
import {
  buildDocumentDirectRoutingKey,
  buildDocumentDirectTurnId,
  normaliseDocumentDirectTrigger,
  type DocumentDirectTrigger,
  type DocumentDirectTriggerReason,
} from './document-direct-contract';

export type DocumentCallbackKind = 'document_update' | 'document_comment_reply';
export type DocumentTurnOutcome = 'processing' | 'complete' | 'incomplete' | 'failed';

export interface DocumentDirectBindingView {
  routingKey: string;
  subscriptionId: string;
  workspaceId: string;
  agentId: string;
  agentNpub: string;
  documentId: string;
  sessionId: string | null;
  generation: number;
  trigger: string | null;
  lastActivityAt: string;
  queuedCount: number;
  callbackOutcome: DocumentTurnOutcome | null;
  callbackAttempts: number;
  openSessionRef: string | null;
}

interface DocumentDirectState {
  routingKey: string;
  subscriptionId: string;
  workspaceId: string;
  agentId: string;
  agentNpub: string;
  documentId: string;
  sessionId: string | null;
  generation: number;
  previousSessionIds: string[];
  activeTurnId: string | null;
  lastTurnId: string | null;
  lastTrigger: string | null;
  lastBody: string | null;
  lastBodyVersion: string | null;
  lastBodyHash: string | null;
  lastActivityAt: string;
}

interface QueuedDocumentEvent {
  sequence: number;
  routingKey: string;
  eventId: string;
  eventSignature: string;
  reason: DocumentDirectTriggerReason;
  sourceCommentId: string | null;
  source: Record<string, unknown>;
}

interface DocumentRuntimeInput {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  event: FlightDeckPgEvent;
}

interface DocumentRuntimeDependencies {
  defaultAgent: AgentType;
  processManager: ProcessManager;
  agentStore: AgentDefinitionStore;
  store?: DocumentDirectStore;
  fetchDocument?: typeof fetchFlightDeckPgDocument;
  fetchComments?: typeof fetchFlightDeckPgDocumentComments;
  fetchChannel?: typeof fetchFlightDeckPgChannel;
  sendFinalResponse?: typeof sendPromptAndAwaitFinalResponse;
  log?: Pick<Console, 'error' | 'warn'>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function compactDocumentDiff(previous: string | null, current: string): string {
  if (previous === null) return '(first processed version; no prior body)';
  if (previous === current) return '(document body unchanged)';
  const before = previous.split('\n');
  const after = current.split('\n');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const render = (prefixMarker: string, lines: string[]) => lines.slice(0, 20).map((line) => `${prefixMarker}${line}`).join('\n');
  return [
    `@@ line ${prefix + 1} @@`,
    render('-', removed),
    render('+', added),
    removed.length > 20 || added.length > 20 ? `… ${removed.length} removed / ${added.length} added lines (full bodies retained)` : '',
  ].filter(Boolean).join('\n');
}

export class DocumentDirectStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_direct_sessions (
        routing_key TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, agent_npub TEXT NOT NULL, document_id TEXT NOT NULL, session_id TEXT,
        generation INTEGER NOT NULL, previous_session_ids_json TEXT NOT NULL, active_turn_id TEXT,
        last_turn_id TEXT, last_trigger TEXT, last_body TEXT, last_body_version TEXT, last_body_hash TEXT,
        last_activity_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_direct_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, routing_key TEXT NOT NULL, event_signature TEXT NOT NULL,
        event_id TEXT NOT NULL, reason TEXT NOT NULL, source_comment_id TEXT, source_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL,
        UNIQUE(routing_key, event_signature)
      );
      CREATE INDEX IF NOT EXISTS idx_document_direct_events_queue
        ON document_direct_events(routing_key, state, sequence);
      CREATE TABLE IF NOT EXISTS document_direct_turns (
        turn_id TEXT PRIMARY KEY, routing_key TEXT NOT NULL, session_id TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL, required_callbacks_json TEXT NOT NULL,
        outcome TEXT NOT NULL, final_turn_captured INTEGER NOT NULL DEFAULT 0,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_direct_callbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        kind TEXT NOT NULL, document_id TEXT NOT NULL, comment_id TEXT, state TEXT NOT NULL,
        error TEXT, attempted_at TEXT NOT NULL, completed_at TEXT
      );
    `);
  }

  get(routingKey: string): DocumentDirectState | null {
    const row = this.db.query('SELECT * FROM document_direct_sessions WHERE routing_key=?1').get(routingKey) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      routingKey: String(row.routing_key), subscriptionId: String(row.subscription_id), workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id), agentNpub: String(row.agent_npub), documentId: String(row.document_id),
      sessionId: text(row.session_id), generation: Number(row.generation),
      previousSessionIds: JSON.parse(String(row.previous_session_ids_json || '[]')),
      activeTurnId: text(row.active_turn_id), lastTurnId: text(row.last_turn_id), lastTrigger: text(row.last_trigger),
      lastBody: row.last_body === null ? null : String(row.last_body), lastBodyVersion: text(row.last_body_version),
      lastBodyHash: text(row.last_body_hash), lastActivityAt: String(row.last_activity_at),
    };
  }

  save(state: DocumentDirectState): DocumentDirectState {
    const now = new Date().toISOString();
    this.db.query(`INSERT INTO document_direct_sessions
      (routing_key,subscription_id,workspace_id,agent_id,agent_npub,document_id,session_id,generation,
       previous_session_ids_json,active_turn_id,last_turn_id,last_trigger,last_body,last_body_version,last_body_hash,last_activity_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
      ON CONFLICT(routing_key) DO UPDATE SET session_id=excluded.session_id,generation=excluded.generation,
       previous_session_ids_json=excluded.previous_session_ids_json,active_turn_id=excluded.active_turn_id,
       last_turn_id=excluded.last_turn_id,last_trigger=excluded.last_trigger,last_body=excluded.last_body,
       last_body_version=excluded.last_body_version,last_body_hash=excluded.last_body_hash,
       last_activity_at=excluded.last_activity_at,updated_at=excluded.updated_at`)
      .run(state.routingKey, state.subscriptionId, state.workspaceId, state.agentId, state.agentNpub, state.documentId,
        state.sessionId, state.generation, JSON.stringify(state.previousSessionIds), state.activeTurnId, state.lastTurnId,
        state.lastTrigger, state.lastBody, state.lastBodyVersion, state.lastBodyHash, state.lastActivityAt, now);
    return this.get(state.routingKey)!;
  }

  enqueue(routingKey: string, trigger: DocumentDirectTrigger): boolean {
    return this.db.query(`INSERT OR IGNORE INTO document_direct_events
      (routing_key,event_signature,event_id,reason,source_comment_id,source_json,state,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,'queued',?7)`)
      .run(routingKey, trigger.eventSignature, trigger.eventId, trigger.reason, trigger.sourceCommentId,
        JSON.stringify(trigger.source), new Date().toISOString()).changes > 0;
  }

  queued(routingKey: string): QueuedDocumentEvent[] {
    return this.db.query(`SELECT sequence,routing_key,event_id,event_signature,reason,source_comment_id,source_json
      FROM document_direct_events WHERE routing_key=?1 AND state='queued' ORDER BY sequence`).all(routingKey).map((row: any) => ({
        sequence: Number(row.sequence), routingKey: String(row.routing_key), eventId: String(row.event_id),
        eventSignature: String(row.event_signature), reason: row.reason as DocumentDirectTriggerReason,
        sourceCommentId: text(row.source_comment_id), source: JSON.parse(String(row.source_json)),
      }));
  }

  completeEvents(sequences: number[]): void {
    const statement = this.db.query("UPDATE document_direct_events SET state='completed' WHERE sequence=?1");
    this.db.transaction(() => sequences.forEach((sequence) => statement.run(sequence)))();
  }

  startTurn(turnId: string, state: DocumentDirectState, events: QueuedDocumentEvent[], required: string[]): void {
    const now = new Date().toISOString();
    this.db.query(`INSERT OR REPLACE INTO document_direct_turns
      (turn_id,routing_key,session_id,source_event_ids_json,required_callbacks_json,outcome,created_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,'processing',?6,?6)`)
      .run(turnId, state.routingKey, state.sessionId!, JSON.stringify(events.map((event) => event.eventId)), JSON.stringify(required), now);
    this.save({ ...state, activeTurnId: turnId, lastActivityAt: now });
  }

  recordCallback(input: { sessionId: string; kind: DocumentCallbackKind; documentId: string; commentId?: string | null; state: 'succeeded' | 'failed'; error?: string | null }): void {
    const state = this.db.query('SELECT active_turn_id FROM document_direct_sessions WHERE session_id=?1 AND active_turn_id IS NOT NULL')
      .get(input.sessionId) as { active_turn_id?: string } | null;
    const turnId = text(state?.active_turn_id);
    if (!turnId) return;
    const now = new Date().toISOString();
    this.db.query(`INSERT INTO document_direct_callbacks
      (turn_id,session_id,kind,document_id,comment_id,state,error,attempted_at,completed_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)`)
      .run(turnId, input.sessionId, input.kind, input.documentId, input.commentId ?? null, input.state, input.error ?? null, now);
  }

  finishTurn(turnId: string, finalCaptured: boolean, error: string | null = null): DocumentTurnOutcome {
    const turn = this.db.query('SELECT required_callbacks_json FROM document_direct_turns WHERE turn_id=?1')
      .get(turnId) as { required_callbacks_json: string } | null;
    const required = turn ? JSON.parse(turn.required_callbacks_json) as string[] : [];
    const successful = this.db.query("SELECT kind,comment_id FROM document_direct_callbacks WHERE turn_id=?1 AND state='succeeded'")
      .all(turnId) as Array<{ kind: string; comment_id: string | null }>;
    const met = required.every((item) => {
      const [kind, commentId] = item.split(':', 2);
      return successful.some((attempt) => attempt.kind === kind && (!commentId || attempt.comment_id === commentId));
    });
    const outcome: DocumentTurnOutcome = error ? 'failed' : met ? 'complete' : 'incomplete';
    this.db.query(`UPDATE document_direct_turns SET outcome=?2,final_turn_captured=?3,error=?4,updated_at=?5 WHERE turn_id=?1`)
      .run(turnId, outcome, finalCaptured ? 1 : 0, error, new Date().toISOString());
    return outcome;
  }

  clearActiveTurn(routingKey: string): void {
    this.db.query('UPDATE document_direct_sessions SET active_turn_id=NULL,updated_at=?2 WHERE routing_key=?1')
      .run(routingKey, new Date().toISOString());
  }

  listBindings(input: { workspaceId: string; documentId: string }): DocumentDirectBindingView[] {
    const states = this.db.query('SELECT routing_key FROM document_direct_sessions WHERE workspace_id=?1 AND document_id=?2 ORDER BY agent_id')
      .all(input.workspaceId, input.documentId) as Array<{ routing_key: string }>;
    return states.flatMap(({ routing_key: routingKey }) => {
      const state = this.get(routingKey)!;
      const generations = [...state.previousSessionIds, state.sessionId].filter((id): id is string => Boolean(id));
      return generations.map((sessionId, index) => {
        const turn = this.db.query(`SELECT outcome,updated_at,source_event_ids_json FROM document_direct_turns
          WHERE routing_key=?1 AND session_id=?2 ORDER BY created_at DESC LIMIT 1`)
          .get(routingKey, sessionId) as { outcome?: string; updated_at?: string; source_event_ids_json?: string } | null;
        const sourceEventIds = turn?.source_event_ids_json ? JSON.parse(turn.source_event_ids_json) as string[] : [];
        const latestSourceEventId = sourceEventIds.at(-1);
        const generationTrigger = latestSourceEventId
          ? text((this.db.query('SELECT reason FROM document_direct_events WHERE routing_key=?1 AND event_id=?2 ORDER BY sequence DESC LIMIT 1')
            .get(routingKey, latestSourceEventId) as { reason?: string } | null)?.reason)
          : null;
        const callbackAttempts = Number((this.db.query(`SELECT count(*) count FROM document_direct_callbacks
          WHERE session_id=?1`).get(sessionId) as { count?: number } | null)?.count ?? 0);
        const current = sessionId === state.sessionId;
        const queuedCount = current ? Number((this.db.query(`SELECT count(*) count FROM document_direct_events
          WHERE routing_key=?1 AND state='queued'`).get(routingKey) as { count?: number } | null)?.count ?? 0) : 0;
        return {
          routingKey, subscriptionId: state.subscriptionId, workspaceId: state.workspaceId,
          agentId: state.agentId, agentNpub: state.agentNpub, documentId: state.documentId,
          sessionId, generation: index + 1, trigger: generationTrigger,
          lastActivityAt: text(turn?.updated_at) ?? state.lastActivityAt, queuedCount,
          callbackOutcome: text(turn?.outcome) as DocumentTurnOutcome | null, callbackAttempts,
          openSessionRef: `/live?session=${encodeURIComponent(sessionId)}`,
        };
      }).sort((a, b) => b.generation - a.generation);
    });
  }

  getBySession(sessionId: string): DocumentDirectState | null {
    const row = this.db.query('SELECT routing_key FROM document_direct_sessions WHERE session_id=?1 ORDER BY updated_at DESC LIMIT 1')
      .get(sessionId) as { routing_key?: string } | null;
    return row?.routing_key ? this.get(row.routing_key) : null;
  }
}

export class DocumentDirectRuntime {
  readonly store: DocumentDirectStore;
  private readonly running = new Map<string, Promise<void>>();
  private readonly contexts = new Map<string, DocumentRuntimeInput>();
  private readonly log: Pick<Console, 'error' | 'warn'>;

  constructor(private readonly deps: DocumentRuntimeDependencies) {
    this.store = deps.store ?? new DocumentDirectStore();
    this.log = deps.log ?? console;
  }

  async handle(input: DocumentRuntimeInput): Promise<{ handled: boolean; reason: string }> {
    const trigger = normaliseDocumentDirectTrigger(input.event);
    if (!trigger || !input.subscription.workspaceId) return { handled: false, reason: 'ineligible_event' };
    const payload = object(input.event.payload);
    const actor = text(input.event.actor_npub) ?? text(payload.author_npub) ?? text(object(payload.author).actor_npub);
    const workspaceIdentity = input.subscription.workspaceServiceNpub?.trim() || input.subscription.workspaceOwnerNpub;
    const agents = this.deps.agentStore.listByWorkspaceAndBot(workspaceIdentity, input.subscription.botNpub)
      .filter((agent) => agent.enabled
        && trigger.targetAgentNpubs.includes(agent.botNpub)
        && actor !== agent.botNpub
        && actor !== input.subscription.wsKeyNpub);
    for (const agent of agents) {
      const routingKey = buildDocumentDirectRoutingKey({
        towerServiceNpub: input.subscription.towerServiceNpub || input.subscription.backendBaseUrl,
        workspaceId: input.subscription.workspaceId,
        agentId: agent.botNpub,
        documentId: trigger.documentId,
      });
      if (!this.store.enqueue(routingKey, trigger)) continue;
      this.contexts.set(routingKey, input);
      if (!this.running.has(routingKey)) {
        const work = this.run(routingKey, agent).finally(() => this.running.delete(routingKey));
        this.running.set(routingKey, work);
        void work.catch((error) => this.log.error('[document-direct] document session failed', {
          routingKey, error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return { handled: agents.length > 0, reason: agents.length ? 'document_direct_queued' : 'not_targeted' };
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.running.values());
  }

  private async run(routingKey: string, agent: AgentDefinitionRecord): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while (this.store.queued(routingKey).length > 0) {
      const input = this.contexts.get(routingKey)!;
      const events = this.store.queued(routingKey);
      const state = this.store.get(routingKey) ?? this.initialState(routingKey, input, agent, events[0]!);
      let turnId: string | null = null;
      try {
        const hydration = await this.hydrate(input, state.documentId);
        const session = await this.resolveSession(state, agent, input.subscription);
        const current = this.store.get(routingKey)!;
        turnId = buildDocumentDirectTurnId(routingKey, events.map((event) => event.eventSignature));
        const required = this.requiredCallbacks(events);
        this.store.startTurn(turnId, current, events, required);
        await (this.deps.sendFinalResponse ?? sendPromptAndAwaitFinalResponse)(
          this.deps.processManager, session.id, this.buildPrompt(current, events, hydration, required),
        );
        // Safe boundary: refresh again after the turn. A newly queued event is
        // intentionally left for the next loop and never interrupts this turn.
        const finalHydration = await this.hydrate(input, state.documentId);
        const finalBody = finalHydration.bodyText;
        const outcome = this.store.finishTurn(turnId, true);
        this.store.completeEvents(events.map((event) => event.sequence));
        this.store.save({ ...this.store.get(routingKey)!, activeTurnId: null, lastTurnId: turnId,
          lastTrigger: events.at(-1)?.reason ?? null, lastBody: finalBody,
          lastBodyVersion: finalHydration.bodyVersion, lastBodyHash: bodyHash(finalBody),
          lastActivityAt: new Date().toISOString() });
        if (outcome === 'incomplete') this.log.warn('[document-direct] required callbacks were not completed', { routingKey, turnId, required });
      } catch (error) {
        if (turnId) this.store.finishTurn(turnId, false, error instanceof Error ? error.message : String(error));
        this.store.clearActiveTurn(routingKey);
        throw error;
      }
    }
  }

  private initialState(routingKey: string, input: DocumentRuntimeInput, agent: AgentDefinitionRecord, event: QueuedDocumentEvent): DocumentDirectState {
    return this.store.save({ routingKey, subscriptionId: input.subscription.subscriptionId,
      workspaceId: input.subscription.workspaceId!, agentId: agent.agentId, agentNpub: agent.botNpub,
      documentId: text(event.source.document_id) ?? text(event.source.doc_id) ?? normaliseDocumentDirectTrigger(input.event)!.documentId,
      sessionId: null, generation: 0, previousSessionIds: [], activeTurnId: null, lastTurnId: null,
      lastTrigger: null, lastBody: null, lastBodyVersion: null, lastBodyHash: null, lastActivityAt: new Date().toISOString() });
  }

  private async resolveSession(state: DocumentDirectState, agent: AgentDefinitionRecord, subscription: WorkspaceSubscriptionRecord): Promise<SessionSnapshot> {
    const existing = state.sessionId ? this.deps.processManager.getSession(state.sessionId) : null;
    const compatible = existing?.metadata?.agentChatAgentId === agent.agentId
      && existing?.metadata?.agentChatBotNpub === agent.botNpub
      && existing.agent === (agent.directChat?.sessionAgent || this.deps.defaultAgent)
      && existing.workingDirectory === (agent.directChat?.directory || agent.workingDirectory);
    if (compatible && (existing?.status === 'running' || existing?.status === 'starting')) return existing;
    const previousSessionIds = state.sessionId ? [...new Set([...state.previousSessionIds, state.sessionId])] : state.previousSessionIds;
    const generation = state.generation + 1;
    const configuredAgent = agent.directChat?.sessionAgent;
    const sessionAgent = configuredAgent && isAgentType(configuredAgent) ? configuredAgent : this.deps.defaultAgent;
    const session = await this.deps.processManager.createSession(
      sessionAgent, agent.directChat?.directory || agent.workingDirectory,
      `${agent.label || agent.agentId} Document ${state.documentId}`.slice(0, 120),
      { type: 'agent-work', id: state.documentId, label: `${state.routingKey}:generation:${generation}` },
      undefined, subscription.managedByNpub ?? undefined,
      { AGENT: true, role: 'agent-work', bindingType: 'document', bindingId: state.documentId,
        nextAction: 'reflect', createdByNpub: subscription.managedByNpub ?? undefined,
        flightdeckTowerServiceNpub: subscription.towerServiceNpub || subscription.backendBaseUrl,
        agentChatAgentId: agent.agentId, agentChatBotNpub: agent.botNpub,
        flightdeckWorkspaceId: subscription.workspaceId!, flightdeckAgentNpub: agent.botNpub,
        flightdeckRoutingKey: state.routingKey, sessionGeneration: generation },
      agent.directChat?.model ?? undefined,
    );
    this.store.save({ ...state, sessionId: session.id, generation, previousSessionIds, lastActivityAt: new Date().toISOString() });
    return session;
  }

  private async hydrate(input: DocumentRuntimeInput, documentId: string): Promise<{ document: Record<string, unknown>; bodyText: string; bodyVersion: string | null; comments: unknown[]; commentsTruncated: boolean; linkedContext: unknown; compactDiff: string; previousBody: string | null }> {
    const base = { backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
      appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity };
    const documentResult = await (this.deps.fetchDocument ?? fetchFlightDeckPgDocument)({ ...base, documentId, includeBody: true });
    const document = object(documentResult.doc);
    const bodyText = decodeFlightDeckPgDocumentBody(documentResult) ?? '';
    const comments: unknown[] = [];
    let commentsCursor: string | null = null;
    do {
      const commentsResult = await (this.deps.fetchComments ?? fetchFlightDeckPgDocumentComments)({
        ...base, documentId, limit: 500, cursor: commentsCursor,
      });
      comments.push(...commentsResult.comments);
      commentsCursor = commentsResult.next_cursor;
    } while (commentsCursor);
    const channelId = text(document.channel_id);
    const linkedContext = channelId ? await (this.deps.fetchChannel ?? fetchFlightDeckPgChannel)({ ...base, channelId }) : null;
    const state = [...this.contexts.keys()].map((key) => this.store.get(key)).find((candidate) => candidate?.documentId === documentId) ?? null;
    const bodyVersion = text(documentResult.body?.sha256_hex) ?? text(String(document.row_version ?? ''));
    return { document, bodyText, bodyVersion,
      comments, commentsTruncated: false, linkedContext,
      compactDiff: compactDocumentDiff(state?.lastBody ?? null, bodyText), previousBody: state?.lastBody ?? null };
  }

  private requiredCallbacks(events: QueuedDocumentEvent[]): string[] {
    return [...new Set(events.flatMap((event) => event.reason === 'document_comment_mention_added' && event.sourceCommentId
      ? [`document_comment_reply:${event.sourceCommentId}`]
      : ['document_update']))];
  }

  private buildPrompt(state: DocumentDirectState, events: QueuedDocumentEvent[], hydration: Awaited<ReturnType<DocumentDirectRuntime['hydrate']>>, required: string[]): string {
    return [
      state.generation === 1 && !state.lastTurnId ? 'FLIGHT DECK DOCUMENT SESSION' : 'FLIGHT DECK DOCUMENT SESSION UPDATE', '',
      'This session is canonically bound to the document ID below. Moving the document does not change the binding.',
      'Use only explicit Flight Deck document callbacks: flightdeck_doc_update and flightdeck_doc_reply. Never post the captured final assistant turn to Flight Deck.',
      'Before acting, use typed helpers to refresh the complete document and inline comment tree. Reply inline to the triggering parent comment IDs.',
      'Your turn is incomplete unless every required callback below succeeds. Do not merely describe an intended edit or reply in your final turn.',
      '', `Routing binding: ${state.routingKey}`, `Generation: ${state.generation}`,
      `Previous sessions: ${state.previousSessionIds.join(', ') || '-'}`,
      `Required callbacks: ${required.join(', ')}`, `Source event IDs in order: ${events.map((event) => event.eventId).join(', ')}`,
      'Ordered trigger batch:', JSON.stringify(events.map((event) => ({ event_id: event.eventId, reason: event.reason,
        source_comment_id: event.sourceCommentId, source: event.source })), null, 2), '',
      `Last successfully processed body version/hash: ${state.lastBodyVersion ?? '-'} / ${state.lastBodyHash ?? '-'}`,
      'Compact body diff:', hydration.compactDiff, '',
      'Previous full body (also retained durably for local diff tools):', state.lastBody ?? '(none)', '',
      'Current full body:', hydration.bodyText, '',
      'Current document, full inline comment tree, and linked channel context:',
      JSON.stringify({ document: hydration.document, comments: hydration.comments,
        commentsTruncated: hydration.commentsTruncated, linkedContext: hydration.linkedContext }, null, 2),
    ].join('\n');
  }
}
