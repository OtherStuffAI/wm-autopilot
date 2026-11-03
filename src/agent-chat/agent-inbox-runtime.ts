import {
  AgentInboxError, ackAgentInboxNotification, createAgentInboxSubscription, fetchAgentInboxContext, listAgentInbox,
  type AgentInboxAckOutcome, type AgentInboxEnvelope, type AgentInboxRequestContext,
} from './agent-inbox-client';
import { AgentInboxUnboundReadError, agentInboxScope, synthesizeInboxEvents, type AgentInboxContext } from './agent-inbox-scope';
import type { AgentInboxStore } from './agent-inbox-store';
import type { FlightDeckPgEvent } from './tower-client';
import type { WorkspaceSubscriptionRecord } from './types';

/**
 * One poll cycle of a strict-inbox subscription.
 *
 * Failure taxonomy (never skip authorization):
 * - auth (401/403 identity/membership/subscription): halt; the cursor does not advance; operator-visible.
 * - unsupported (Tower lacks the inbox): fail closed; never fall back to `/events`.
 * - source_gone (Tower-confirmed 410): ack `source_gone`, continue.
 * - relationship/access revoked, tombstones: ack `suppressed`, continue.
 * - transient: retry with backoff; attempts are durable and bounded, then ack `failed_permanent` (dead letter).
 * - cursor/gap: recover through the same consumer (acked position) or the explicit retention recovery cursor.
 * Handling is recorded durably before the ack, so a crash between them never re-executes work.
 */
export type InboxPollResult =
  | { status: 'idle' | 'more' }
  | { status: 'backoff' | 'halt' | 'unsupported'; code: string; message: string };

export interface AgentInboxProcessorDeps {
  store: AgentInboxStore;
  dispatch: (record: WorkspaceSubscriptionRecord, event: FlightDeckPgEvent) => Promise<unknown>;
  record: (record: WorkspaceSubscriptionRecord, entry: { notification: AgentInboxEnvelope; outcome: string; code: string | null; detail?: string }) => void;
  /**
   * Ambiguous in-flight reconciliation: true when the handlers durably accepted this notification after `since` (an
   * earlier attempt crashed between handler acceptance and the handled record). Never replays accepted work.
   */
  reconcile?: (record: WorkspaceSubscriptionRecord, notification: AgentInboxEnvelope, since: string) => Promise<boolean> | boolean;
  client?: Partial<{
    createSubscription: typeof createAgentInboxSubscription;
    list: typeof listAgentInbox;
    context: typeof fetchAgentInboxContext;
    ack: typeof ackAgentInboxNotification;
  }>;
  maxAttempts?: number;
  pageSize?: number;
}

type HandleResult = 'done' | 'retry' | 'halt';

export class AgentInboxProcessor {
  private readonly maxAttempts: number;
  constructor(private readonly deps: AgentInboxProcessorDeps) {
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  private get client() {
    return {
      createSubscription: this.deps.client?.createSubscription ?? createAgentInboxSubscription,
      list: this.deps.client?.list ?? listAgentInbox,
      context: this.deps.client?.context ?? fetchAgentInboxContext,
      ack: this.deps.client?.ack ?? ackAgentInboxNotification,
    };
  }

  private fail(record: WorkspaceSubscriptionRecord, error: unknown): InboxPollResult {
    const e = error instanceof AgentInboxError ? error : new AgentInboxError(0, 'internal_error', 'transient', error instanceof Error ? error.message : String(error));
    this.deps.store.update(record.subscriptionId, { lastErrorCode: e.code, lastErrorClass: e.errorClass, lastErrorAt: new Date().toISOString() });
    if (e.errorClass === 'auth') return { status: 'halt', code: e.code, message: e.message };
    if (e.errorClass === 'unsupported') return { status: 'unsupported', code: 'agent_inbox_unsupported', message: 'Tower does not offer the strict agent inbox (agent_notifications.v1); no fallback is used.' };
    return { status: 'backoff', code: e.code, message: e.message };
  }

  async pollOnce(record: WorkspaceSubscriptionRecord, request: AgentInboxRequestContext): Promise<InboxPollResult> {
    const store = this.deps.store;
    let state = store.get(record.subscriptionId);
    if (!state || state.mode !== 'inbox_required') return { status: 'halt', code: 'agent_inbox_not_enabled', message: 'Subscription is not opted into the strict inbox.' };
    if (!state.cursor || !state.towerSubscriptionId) {
      try {
        const created = await this.client.createSubscription(request, state.consumerId ?? `autopilot:${record.subscriptionId}`);
        state = store.update(record.subscriptionId, {
          towerSubscriptionId: created.subscription.id, cursor: created.cursor, floorAt: created.subscription.floor_at,
          ...(created.gap ? { lastGap: JSON.stringify({ ...created.gap, at: new Date().toISOString() }) } : {}),
        })!;
      } catch (error) {
        return this.fail(record, error);
      }
    }
    let page;
    try {
      page = await this.client.list(request, state.cursor!, this.deps.pageSize ?? 50);
    } catch (error) {
      if (error instanceof AgentInboxError && error.errorClass === 'cursor') {
        // Re-anchor through the same consumer: Tower returns the acked position (never history before the floor).
        store.update(record.subscriptionId, { cursor: null, towerSubscriptionId: null });
        return { status: 'backoff', code: error.code, message: 'Cursor re-anchored through the subscription consumer.' };
      }
      if (error instanceof AgentInboxError && error.errorClass === 'gap' && typeof error.details.recovery_cursor === 'string') {
        store.update(record.subscriptionId, { cursor: error.details.recovery_cursor, lastGap: JSON.stringify({ ...error.details, recovery_cursor: undefined, at: new Date().toISOString() }) });
        return { status: 'more' };
      }
      return this.fail(record, error);
    }
    for (const notification of page.notifications) {
      const outcome = await this.handle(record, request, state.towerSubscriptionId!, notification);
      if (outcome === 'halt') return this.fail(record, this.lastError ?? new AgentInboxError(403, 'agent_inbox_halted', 'auth', 'Authorization failure while handling a notification'));
      if (outcome === 'retry') return { status: 'backoff', code: this.lastError instanceof AgentInboxError ? this.lastError.code : 'agent_inbox_retry', message: 'Notification will be retried.' };
    }
    store.update(record.subscriptionId, { cursor: page.next_cursor, lastOkAt: new Date().toISOString(), lastErrorCode: null, lastErrorClass: null });
    return { status: page.has_more ? 'more' : 'idle' };
  }

  private lastError: unknown = null;

  private async finish(record: WorkspaceSubscriptionRecord, request: AgentInboxRequestContext, subscriptionId: string, n: AgentInboxEnvelope, outcome: AgentInboxAckOutcome, code: string | null, detail?: string): Promise<HandleResult> {
    this.deps.store.markHandled(record.subscriptionId, n.id, n.seq, outcome, code);
    this.deps.record(record, { notification: n, outcome, code, detail });
    try {
      await this.client.ack(request, n.id, { subscriptionId, outcome, code });
    } catch (error) {
      this.lastError = error;
      // Tower no longer knows this id for us (retention/never visible): nothing to acknowledge.
      if (error instanceof AgentInboxError && error.errorClass === 'not_found') { this.deps.store.markAcked(record.subscriptionId, n.id); return 'done'; }
      return error instanceof AgentInboxError && error.errorClass === 'auth' ? 'halt' : 'retry';
    }
    this.deps.store.markAcked(record.subscriptionId, n.id);
    return 'done';
  }

  private async handle(record: WorkspaceSubscriptionRecord, request: AgentInboxRequestContext, subscriptionId: string, n: AgentInboxEnvelope): Promise<HandleResult> {
    const store = this.deps.store;
    const ledger = store.ledger(record.subscriptionId, n.id);
    if (ledger?.ackedAt) return 'done';
    if (ledger?.handledAt && ledger.outcome) {
      return this.finish(record, request, subscriptionId, n, ledger.outcome as AgentInboxAckOutcome, ledger.code); // ack only; never re-execute
    }
    if (n.state === 'revoked') return this.finish(record, request, subscriptionId, n, 'suppressed', 'revoked');
    if (!n.source || !n.kind) return this.finish(record, request, subscriptionId, n, 'failed_permanent', 'malformed_envelope');
    // A previous attempt started but never recorded an outcome (crash/restart). Reconcile with the handlers' durable
    // evidence before anything else; accepted work is acknowledged, never dispatched again.
    if (ledger?.startedAt && !ledger.handledAt && this.deps.reconcile && await this.deps.reconcile(record, n, ledger.startedAt)) {
      return this.finish(record, request, subscriptionId, n, 'handled', 'reconciled_in_flight');
    }
    const attempt = store.beginAttempt(record.subscriptionId, n.id, n.seq, n as any);
    if (attempt.attempts > this.maxAttempts) {
      return this.finish(record, request, subscriptionId, n, 'failed_permanent', 'max_attempts', this.lastError instanceof Error ? this.lastError.message : undefined);
    }
    let context: AgentInboxContext;
    try {
      context = await this.client.context<AgentInboxContext>(request, n.id);
    } catch (error) {
      this.lastError = error;
      if (error instanceof AgentInboxError) {
        if (error.errorClass === 'source_gone') return this.finish(record, request, subscriptionId, n, 'source_gone', 'source_gone');
        if (error.errorClass === 'relationship') return this.finish(record, request, subscriptionId, n, 'suppressed', error.code);
        if (error.errorClass === 'not_found') { store.markHandled(record.subscriptionId, n.id, n.seq, 'suppressed', 'not_found'); store.markAcked(record.subscriptionId, n.id); return 'done'; }
        if (error.errorClass === 'auth') return 'halt';
      }
      return 'retry';
    }
    const profileNpub = request.botIdentity.botNpub;
    const events = synthesizeInboxEvents(n, context, profileNpub);
    if (!events.length) return this.finish(record, request, subscriptionId, n, 'suppressed', 'unsupported_kind');
    try {
      for (const event of events) {
        await agentInboxScope.run({ notification: n, context, profileNpub }, () => this.deps.dispatch(record, event));
      }
    } catch (error) {
      this.lastError = error;
      if (error instanceof AgentInboxUnboundReadError) {
        return this.finish(record, request, subscriptionId, n, 'failed_permanent', 'context_unbound', error.message);
      }
      const status = Number((error as { status?: unknown })?.status ?? 0);
      if (status === 401) return 'halt';
      if (status === 403) return this.finish(record, request, subscriptionId, n, 'failed_permanent', String((error as { detailCode?: unknown })?.detailCode ?? 'write_refused'), error instanceof Error ? error.message : undefined);
      return 'retry';
    }
    return this.finish(record, request, subscriptionId, n, 'handled', null);
  }
}
