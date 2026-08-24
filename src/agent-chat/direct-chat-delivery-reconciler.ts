import { randomUUID } from 'node:crypto';
import type { ProcessManager } from '../agents/process-manager';
import type { ChatInterceptStateStore } from './chat-intercept-state-store';
import {
  buildDirectChatPublicationPayload,
  directChatTurnStore,
  type DirectChatTurnRecord,
  type DirectChatTurnStore,
} from './direct-chat-turn-store';
import { inspectAcceptedFinalResponse } from './session-runtime-session-ops';
import { createFlightDeckPgChannelMessage } from './tower-client';
import { buildDirectChatRoutingKey } from './direct-chat-contract';
import { BROKER_KEY_IDENTITY_MISMATCH, BROKER_KEY_NOT_PROVISIONED } from '../signing/broker-key-vault';
import type { RuntimeBotIdentity } from './types';
import type { DuplicateCallbackPublicationFilter } from './duplicate-callback-publication-filter';
import type { FlightDeckDispatchOutcomeStore } from './flightdeck-dispatch-outcome-store';

export interface AgentDirectDeliveryTransport {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
}

interface AgentDirectDeliveryReconcilerDependencies {
  manager: ProcessManager;
  resolveTransport: (record: DirectChatTurnRecord) => AgentDirectDeliveryTransport | null;
  withProfileIdentity: <T>(
    record: DirectChatTurnRecord,
    operation: (identity: RuntimeBotIdentity) => Promise<T>,
  ) => Promise<T>;
  store?: DirectChatTurnStore;
  interceptStore?: ChatInterceptStateStore;
  publish?: typeof createFlightDeckPgChannelMessage;
  intervalMs?: number;
  activeIntervalMs?: number;
  unavailableIntervalMs?: number;
  leaseMs?: number;
  random?: () => number;
  now?: () => number;
  log?: Pick<Console, 'error' | 'warn'>;
  instanceId?: string;
  publicationFilter?: DuplicateCallbackPublicationFilter;
  dispatchOutcomeStore?: FlightDeckDispatchOutcomeStore;
}

function envMs(name: string, fallback: number): number {
  const value = Number(Bun.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class AgentDirectDeliveryReconciler {
  readonly instanceId: string;
  readonly runtimeLeaseOwner: string;
  private readonly store: DirectChatTurnStore;
  private readonly intervalMs: number;
  private readonly activeIntervalMs: number;
  private readonly unavailableIntervalMs: number;
  private readonly leaseMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly log: Pick<Console, 'error' | 'warn'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweep: Promise<void> | null = null;

  constructor(private readonly deps: AgentDirectDeliveryReconcilerDependencies) {
    this.store = deps.store ?? directChatTurnStore;
    this.instanceId = deps.instanceId ?? randomUUID();
    this.runtimeLeaseOwner = `${this.instanceId}:runtime`;
    this.intervalMs = deps.intervalMs ?? envMs('AGENT_DIRECT_RECONCILE_INTERVAL_MS', 2_000);
    this.activeIntervalMs = deps.activeIntervalMs ?? envMs('AGENT_DIRECT_ACTIVE_RECONCILE_MS', 2_000);
    this.unavailableIntervalMs = deps.unavailableIntervalMs ?? envMs('AGENT_DIRECT_UNAVAILABLE_RECONCILE_MS', 30_000);
    this.leaseMs = deps.leaseMs ?? envMs('AGENT_DIRECT_DELIVERY_LEASE_MS', 30_000);
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? console;
  }

  start(): void {
    if (this.timer) return;
    this.store.releaseForeignLeases(this.instanceId, this.isoNow());
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  notify(turnId: string): void {
    queueMicrotask(() => void this.processTurnNow(turnId));
  }

  async runOnce(): Promise<void> {
    if (this.sweep) return await this.sweep;
    this.sweep = (async () => {
      for (const record of this.store.listRecoverable()) await this.processTurnNow(record.turnId);
    })().finally(() => { this.sweep = null; });
    await this.sweep;
  }

  async processTurnNow(turnId: string): Promise<DirectChatTurnRecord | null> {
    let current = this.store.get(turnId);
    if (!current || ['completed', 'published', 'suppressed', 'integrity_halt'].includes(current.state)) return current;
    if (!this.hasBinding(current)) {
      this.store.markIntegrityHalt(turnId, 'missing_immutable_binding', 'Agent Direct delivery lacks immutable subscription/workspace/channel/thread/agent binding.');
      return this.store.get(turnId);
    }
    if (current.replyBody && (!current.publicationPayload || !current.payloadHash)) {
      try { current = this.store.freezeReply(turnId, current.replyBody, this.isoNow()); }
      catch { return this.store.get(turnId); }
    }
    const now = this.isoNow();
    const owner = `${this.instanceId}:delivery:${randomUUID()}`;
    const claimed = this.store.claim(turnId, owner, now, this.leaseMs);
    if (!claimed) return this.store.get(turnId);
    try {
      if (!claimed.publicationPayload) return await this.reconcileReply(claimed, owner);
      return await this.publish(claimed, owner);
    } catch (error) {
      await this.handleUnexpected(claimed, owner, error);
      return this.store.get(turnId);
    }
  }

  private async reconcileReply(record: DirectChatTurnRecord, owner: string): Promise<DirectChatTurnRecord | null> {
    if (!record.sessionId) {
      this.store.markFailed(record.turnId, 'session_evidence_missing',
        'Accepted Agent Direct turn has no saved session response source.', this.isoNow(), owner);
      return this.store.get(record.turnId);
    }
    const inspection = await inspectAcceptedFinalResponse(this.deps.manager, record.sessionId, record.prompt ?? '',
      record.sourceMessageIds, record.acceptedAt);
    if (!inspection.reply) {
      if (inspection.sessionState !== 'active') {
        const errorClass = `session_${inspection.sessionState}`;
        const message = `Accepted Agent Direct session is ${inspection.sessionState} and has no authoritative final response.`;
        this.store.markFailed(record.turnId, errorClass, message, this.isoNow(), owner);
        this.preserveContinuityForReplay(record);
        return this.store.get(record.turnId);
      }
      this.store.releaseAwaiting(record.turnId, owner, this.after(this.activeIntervalMs));
      return this.store.get(record.turnId);
    }
    this.store.releaseAwaiting(record.turnId, owner, this.isoNow());
    this.store.freezeReply(record.turnId, inspection.reply.content, inspection.reply.createdAt || this.isoNow());
    return await this.processTurnNow(record.turnId);
  }

  private async publish(record: DirectChatTurnRecord, owner: string): Promise<DirectChatTurnRecord | null> {
    const bindingError = this.validateBinding(record);
    if (bindingError) {
      this.store.markIntegrityHalt(record.turnId, bindingError.errorClass, bindingError.message, this.isoNow(), owner);
      return this.store.get(record.turnId);
    }
    const candidateAt = record.replyReadyAt ?? '';
    const evaluation = this.deps.publicationFilter?.evaluate({
      decisionId: record.turnId,
      routingKey: record.routingKey,
      subscriptionId: record.subscriptionId!,
      agentNpub: record.agentNpub!,
      body: record.publicationPayload?.body ?? record.replyBody ?? '',
      candidateAt,
    });
    if (evaluation?.suppress) {
      const suppressed = this.store.markSuppressed(record.turnId, owner, this.isoNow());
      this.completeIntercept(suppressed, true);
      return suppressed;
    }
    const transport = this.deps.resolveTransport(record);
    if (!transport) {
      this.store.markRetry(record.turnId, owner, this.after(this.unavailableIntervalMs),
        'Agent Direct subscription transport binding is unavailable or no longer matches the saved turn.',
        'transport_binding_unavailable', true);
      return this.store.get(record.turnId);
    }
    const payload = record.publicationPayload ?? buildDirectChatPublicationPayload(record, record.replyBody!);
    try {
      const result = await this.deps.withProfileIdentity(record, async (botIdentity) => {
        if (botIdentity.botNpub !== record.agentNpub) {
          throw Object.assign(new Error('Resolved profile vault identity does not match the saved Agent Direct turn.'), {
            integrityClass: 'profile_vault_identity_mismatch',
          });
        }
        return (this.deps.publish ?? createFlightDeckPgChannelMessage)({
          backendBaseUrl: transport.backendBaseUrl, workspaceId: transport.workspaceId, channelId: record.channelId!,
          appNpub: transport.appNpub, botIdentity, body: payload.body, threadId: payload.threadId,
          clientRequestId: record.clientRequestId, metadata: payload.metadata,
        });
      });
      const messageId = result.message?.id;
      if (!messageId) throw Object.assign(new Error('Tower accepted Agent Direct publication without returning a message id.'), { status: 502 });
      const publishedAt = this.isoNow();
      const published = this.store.markPublished(record.turnId, owner, messageId, publishedAt);
      this.deps.publicationFilter?.recordPublished({ decisionId: record.turnId, routingKey: record.routingKey,
        candidateAt, publishedAt, publishedMessageId: messageId });
      if (record.subscriptionId && record.agentId && record.sessionId) {
        for (const recordId of record.sourceMessageIds) {
          this.deps.dispatchOutcomeStore?.recordSessionRecovered({
            subscriptionId: record.subscriptionId,
            recordId,
            agentId: record.agentId,
            sessionId: record.sessionId,
            evidence: 'flightdeck_delivery',
            publishedMessageId: messageId,
          });
        }
      }
      this.completeIntercept(published, false);
      return published;
    } catch (error) {
      const errorCode = typeof (error as { code?: unknown })?.code === 'string'
        ? String((error as { code: string }).code) : null;
      if (errorCode === BROKER_KEY_NOT_PROVISIONED) {
        this.store.markRetry(record.turnId, owner, this.after(this.unavailableIntervalMs),
          error instanceof Error ? error.message : String(error), BROKER_KEY_NOT_PROVISIONED, true);
        return this.store.get(record.turnId);
      }
      if (errorCode === BROKER_KEY_IDENTITY_MISMATCH) {
        this.store.markIntegrityHalt(record.turnId, BROKER_KEY_IDENTITY_MISMATCH,
          error instanceof Error ? error.message : String(error), this.isoNow(), owner);
        return this.store.get(record.turnId);
      }
      const integrityClass = typeof (error as { integrityClass?: unknown })?.integrityClass === 'string'
        ? String((error as { integrityClass: string }).integrityClass) : null;
      if (integrityClass) {
        this.store.markIntegrityHalt(record.turnId, integrityClass,
          error instanceof Error ? error.message : String(error), this.isoNow(), owner);
        return this.store.get(record.turnId);
      }
      const status = Number((error as { status?: unknown })?.status ?? 0);
      const detailCode = typeof (error as { detailCode?: unknown })?.detailCode === 'string'
        ? String((error as { detailCode: string }).detailCode) : null;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 409 || detailCode === 'idempotency_conflict') {
        this.store.markIntegrityHalt(record.turnId, 'idempotency_payload_conflict',
          `Tower has the same client_request_id with a materially different payload: ${message}`, this.isoNow(), owner);
        return this.store.get(record.turnId);
      }
      if (status === 401 || status === 403) {
        this.store.markRetry(record.turnId, owner, this.after(this.unavailableIntervalMs), message, `tower_auth_${status}`, true);
        return this.store.get(record.turnId);
      }
      if (status === 0 || status === 408 || status === 429 || status >= 500) {
        this.store.markRetry(record.turnId, owner, this.after(this.retryDelay(record.attemptCount ?? 1)), message,
          status ? `tower_${status}` : 'tower_network');
        return this.store.get(record.turnId);
      }
      this.store.markIntegrityHalt(record.turnId, `tower_${status || 'publication_error'}`, message, this.isoNow(), owner);
      return this.store.get(record.turnId);
    }
  }

  private async handleUnexpected(record: DirectChatTurnRecord, owner: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.store.markRetry(record.turnId, owner, this.after(this.retryDelay(record.attemptCount ?? 1)), message, 'reconciler_error');
    this.log.error('[agent-direct-delivery] reconciliation failed', { turnId: record.turnId, error: message });
  }

  private completeIntercept(record: DirectChatTurnRecord | null, suppressed: boolean): void {
    if (!record || !this.deps.interceptStore) return;
    const intercept = this.deps.interceptStore.getByRoutingKey(record.routingKey);
    if (!intercept) return;
    const at = record.publishedAt ?? record.updatedAt ?? this.isoNow();
    this.deps.interceptStore.save({ ...intercept,
      lastAgentMessageIdPublished: suppressed ? intercept.lastAgentMessageIdPublished : record.publishedMessageId,
      lastCompletedTurnId: record.turnId, state: 'idle', lastDecision: suppressed ? 'ignore' : 'respond',
      lastActivityAt: at, updatedAt: at });
  }

  private preserveContinuityForReplay(record: DirectChatTurnRecord): void {
    if (!this.deps.interceptStore || !record.sessionId) return;
    const intercept = this.deps.interceptStore.getByRoutingKey(record.routingKey);
    if (!intercept || (intercept.sessionId && intercept.sessionId !== record.sessionId)) return;
    const at = this.isoNow();
    this.deps.interceptStore.save({
      ...intercept,
      sessionId: record.sessionId,
      lastHumanMessageIdDelivered: intercept.lastHumanMessageIdDelivered ?? record.sourceMessageIds.at(-1) ?? null,
      state: intercept.pendingMessageCount > 0 ? 'pending' : intercept.state,
      lastDecision: 'failed',
      lastActivityAt: at,
      updatedAt: at,
    });
  }

  private hasBinding(record: DirectChatTurnRecord): boolean {
    return Boolean(record.subscriptionId && record.backendBaseUrl && record.workspaceId && record.sourceAppNpub
      && record.channelId && record.threadId && record.agentId && record.agentNpub && record.towerServiceNpub);
  }

  private validateBinding(record: DirectChatTurnRecord): { errorClass: string; message: string } | null {
    const expectedRoutingKey = buildDirectChatRoutingKey({ towerServiceNpub: record.towerServiceNpub!,
      workspaceId: record.workspaceId!, channelId: record.channelId!, threadId: record.threadId!, agentNpub: record.agentNpub! });
    if (expectedRoutingKey !== record.routingKey) {
      return { errorClass: 'routing_binding_mismatch', message: 'Saved Agent Direct routing key does not match its immutable workspace, channel, thread, and agent binding.' };
    }
    const session = record.sessionId ? this.deps.manager.getSession(record.sessionId) : null;
    if (!session) return null;
    const metadata = session.metadata;
    if (!metadata || metadata.agentChatAgentId !== record.agentId || metadata.flightdeckAgentNpub !== record.agentNpub
      || metadata.flightdeckRoutingKey !== record.routingKey || metadata.flightdeckWorkspaceId !== record.workspaceId
      || metadata.flightdeckChannelId !== record.channelId || metadata.flightdeckThreadId !== record.threadId) {
      return { errorClass: 'session_turn_binding_mismatch', message: 'Live session metadata does not match the saved Agent Direct turn binding.' };
    }
    return null;
  }

  private retryDelay(attempt: number): number {
    const base = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(8, Math.max(0, attempt - 1))));
    return Math.round(base * (0.75 + this.random() * 0.5));
  }

  private isoNow(): string { return new Date(this.now()).toISOString(); }
  private after(ms: number): string { return new Date(this.now() + ms).toISOString(); }
}
