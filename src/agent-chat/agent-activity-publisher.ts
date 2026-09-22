import { createHash } from 'node:crypto';

import { readCodexUserVisibleActivities, type CodexUserVisibleActivity } from '../agents/codex-session-messages';
import type { ProcessManager } from '../agents/process-manager';
import { upsertFlightDeckPgAgentActivity } from './tower-client';
import type { RuntimeBotIdentity } from './types';
import { agentActivityPublicationStore, type AgentActivityPublicationStore } from './agent-activity-publication-store';

export type AgentActivityState = 'accepted' | 'queued' | 'working' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface AgentActivityPublishOptions {
  blockedByTurnId?: string;
  queuePosition?: number;
  heartbeat?: boolean;
}

export interface AgentActivityContext {
  backendConnectionId?: string | null;
  subscriptionId?: string | null;
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
  triggerMessageId: string;
  sessionId: string;
  agentNpub: string;
  turnId: string;
  startedAt?: string;
}

export function buildAgentActivityId(context: Pick<AgentActivityContext, 'workspaceId' | 'turnId' | 'agentNpub'>): string {
  return createHash('sha256').update(`${context.workspaceId}:${context.turnId}:${context.agentNpub}`).digest('hex').slice(0, 32);
}

export function normalizeUserVisibleActivity(value: string, maxLength = 4_000): string | null {
  const clean = value.replace(/\u0000/g, '').trim();
  if (!clean) return null;
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export class AgentActivityPublisher {
  private sequence: number;
  private lastBody = '';
  private lastState: AgentActivityState | null = null;
  private terminal = false;
  private established = false;
  private heartbeatCount = 0;
  private publishQueue = Promise.resolve();
  private runtimeSessionId: string;
  private readonly activityId: string;
  private readonly sequenceBase: number;

  constructor(
    private readonly context: AgentActivityContext,
    private readonly deliver: typeof upsertFlightDeckPgAgentActivity = upsertFlightDeckPgAgentActivity,
    sequenceBase?: number,
    private readonly readLatestActivity: (input: Parameters<typeof readCodexUserVisibleActivities>[0]) => Promise<CodexUserVisibleActivity[] | CodexUserVisibleActivity | null> = readCodexUserVisibleActivities,
    private readonly log: Pick<Console, 'error'> & Partial<Pick<Console, 'info'>> = console,
    private readonly publicationStore: AgentActivityPublicationStore = agentActivityPublicationStore,
  ) {
    const startedAt = Date.parse(context.startedAt ?? '');
    this.sequenceBase = sequenceBase ?? (Number.isFinite(startedAt) ? startedAt : Date.now()) * 1_000;
    this.sequence = this.sequenceBase;
    this.runtimeSessionId = context.sessionId;
    this.activityId = buildAgentActivityId(context);
    const saved = this.publicationStore.contextFor(this.activityId);
    if (typeof saved?.sessionId === 'string') this.context = { ...context, sessionId: saved.sessionId };
  }

  bindSession(sessionId: string): void {
    this.runtimeSessionId = sessionId;
  }

  async publish(state: AgentActivityState, body?: string, options?: AgentActivityPublishOptions): Promise<void> {
    return this.enqueuePublish(() => this.publishNow(state, body, undefined, options));
  }

  async heartbeat(): Promise<void> {
    return this.publish('working', undefined, { heartbeat: true });
  }

  private enqueuePublish(operation: () => Promise<void>): Promise<void> {
    const queued = this.publishQueue.then(operation, operation);
    this.publishQueue = queued.catch(() => undefined);
    return queued;
  }

  private async publishNow(state: AgentActivityState, body?: string, sourceIdentity?: string,
    options: AgentActivityPublishOptions = {}): Promise<void> {
    if (this.terminal && !sourceIdentity) return;
    const normalized = body ? normalizeUserVisibleActivity(body) : null;
    if (!options.heartbeat && !sourceIdentity && state === 'working'
      && normalized === this.lastBody && (normalized || this.lastState === 'working')) return;
    const terminal = state === 'completed' || state === 'failed' || state === 'cancelled';
    // A replay can construct another publisher for the same durable turn while
    // the owning lifecycle is still active. Its stable sequence makes the
    // replayed receipt stale at Tower; do not let that unestablished replay
    // terminalize the owner's visible activity afterward.
    if (terminal && !this.established && !this.publicationStore.hasPending(this.activityId)) return;
    const eventKey = sourceIdentity ?? (options.heartbeat ? `heartbeat:${Date.now()}:${++this.heartbeatCount}` : `${state}:${normalized ?? ''}`);
    const { botIdentity: _identity, ...publicContext } = this.context;
    const publicRequest = {
      ...publicContext,
      activityId: this.activityId,
      state,
      // Tower treats session_id as immutable correlation data for one
      // activity_id. Keep the originally published value when the pending
      // turn later binds to its concrete runtime session.
      sessionId: this.context.sessionId,
      label: state === 'queued' ? 'Queued' : state === 'accepted' ? 'Message received'
        : state === 'working' ? (normalized ? 'Working' : 'Agent started') : undefined,
      summary: normalized ? normalized.replace(/\s+/g, ' ').slice(0, 240) : undefined,
      body: normalized ?? undefined,
      expiresInSeconds: terminal ? 60 : 300,
      blockedByTurnId: state === 'queued' ? options.blockedByTurnId : undefined,
      queuePosition: state === 'queued' ? options.queuePosition : undefined,
    };
    const claim = this.publicationStore.claim(this.activityId, eventKey, this.sequenceBase, new Date().toISOString(), publicRequest);
    this.sequence = Math.max(this.sequence, claim.sequence);
    if (claim.duplicate) {
      if (claim.accepted && state === 'working') this.established = true;
      if (claim.accepted && terminal) this.terminal = true;
      return;
    }
    const sequence = claim.sequence;
    const correlation = {
      publicationId: `${this.activityId}:${sequence}`,
      activityId: this.activityId,
      workspaceId: this.context.workspaceId,
      channelId: this.context.channelId,
      threadId: this.context.threadId,
      triggerMessageId: this.context.triggerMessageId,
      sessionId: this.context.sessionId,
      runtimeSessionId: this.runtimeSessionId,
      turnId: this.context.turnId,
      eventKey,
      state,
      sequence,
    };
    try {
      const request = { ...publicRequest, sequence, botIdentity: this.context.botIdentity };
      let delivered = false;
      let lastError: unknown = null;
      let towerResult: Awaited<ReturnType<typeof upsertFlightDeckPgAgentActivity>> | null = null;
      this.log.info?.('[agent-activity] publication emitted', { ...correlation, stage: 'emitted' });
      for (let attempt = 0; attempt < 2 && !delivered; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2_000);
        try {
          towerResult = await this.deliver({ ...request, signal: controller.signal });
          delivered = true;
        } catch (error) {
          lastError = error;
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!delivered) {
        const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
        this.publicationStore.markFailed(this.activityId, eventKey, errorMessage);
        this.log.error('[agent-activity] Tower publication failed after retry', {
          ...correlation, stage: 'publication_failed', attempts: 2,
          status: (lastError as { status?: unknown })?.status ?? null,
          detailCode: (lastError as { detailCode?: unknown })?.detailCode ?? null,
          details: (lastError as { details?: unknown })?.details ?? null,
          error: errorMessage,
        });
        return;
      }
      this.publicationStore.markAccepted(this.activityId, eventKey);
      const towerActivity = towerResult?.agent_activity ?? towerResult?.activity ?? null;
      const towerEvent = towerResult?.event ?? null;
      const towerOutbox = towerResult?.outbox && typeof towerResult.outbox === 'object'
        ? towerResult.outbox as Record<string, unknown>
        : null;
      this.log.info?.('[agent-activity] publication Tower-accepted', {
        ...correlation,
        stage: 'tower_accepted',
        towerRecordId: (towerActivity as { id?: unknown } | null)?.id ?? null,
        towerEventId: towerEvent?.event_id ?? towerEvent?.id ?? null,
        towerEventCursor: towerEvent?.cursor ?? null,
        towerOutboxEventId: towerOutbox?.id ?? null,
        towerOutboxRowVersion: towerOutbox?.row_version ?? null,
        uiConsumable: Boolean(towerActivity),
        uiConsumableVia: towerOutbox ? 'sse_and_hydration' : 'hydration',
      });
      if (normalized) this.lastBody = normalized;
      this.lastState = state;
      this.established = true;
      if (terminal) this.terminal = true;
    } catch (error) {
      this.publicationStore.markFailed(this.activityId, eventKey, error instanceof Error ? error.message : String(error));
      this.log.error('[agent-activity] advisory publication failed', {
        ...correlation, stage: 'publisher_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async publishLatestCommentary(manager: ProcessManager): Promise<void> {
    const session = manager.getSession(this.runtimeSessionId);
    const native = session?.metadata?.nativeAgentSession;
    if (session?.agent !== 'codex' || native?.agent !== 'codex' || !native.sessionId || !native.workingDirectory) return;
    await this.publishCommentaryFromSource({ sessionId: native.sessionId,
      workingDirectory: native.workingDirectory, startedAt: this.context.startedAt });
  }

  async publishCommentaryFromSource(source: Parameters<typeof readCodexUserVisibleActivities>[0]): Promise<void> {
    await this.enqueuePublish(async () => {
      const { botIdentity: _identity, ...context } = this.context;
      const generation = this.publicationStore.saveCommentarySource(this.activityId, { context, source });
      let result: Awaited<ReturnType<typeof this.readLatestActivity>>;
      try {
        result = await this.readLatestActivity(source);
      } catch (error) {
        this.log.error('[agent-activity] commentary read failed; will retry', { sessionId: this.runtimeSessionId,
          error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const activities = Array.isArray(result) ? result : result ? [result] : [];
      for (const activity of activities) {
        const startedAt = Date.parse(this.context.startedAt ?? '');
        if (Number.isFinite(startedAt) && Date.parse(activity.createdAt) < startedAt) continue;
        const hash = createHash('sha256').update(activity.content).digest('hex').slice(0, 16);
        const identity = `commentary:${source.sessionId}:${activity.sourceId ?? activity.createdAt}:${hash}`;
        this.publicationStore.migrateLegacyCommentary(this.activityId, identity, `commentary:${activity.createdAt}:${hash}`);
        await this.publishNow('working', activity.content, identity);
      }
      this.publicationStore.finishCommentarySource(this.activityId, generation);
    });
  }
}
