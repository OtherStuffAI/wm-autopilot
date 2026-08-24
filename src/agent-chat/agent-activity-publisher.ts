import { createHash } from 'node:crypto';

import { readLatestCodexUserVisibleActivity } from '../agents/codex-session-messages';
import type { ProcessManager } from '../agents/process-manager';
import { upsertFlightDeckPgAgentActivity } from './tower-client';
import type { RuntimeBotIdentity } from './types';
import { agentActivityPublicationStore, type AgentActivityPublicationStore } from './agent-activity-publication-store';

export type AgentActivityState = 'accepted' | 'working' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface AgentActivityContext {
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
  private latestCommentaryAt = Number.NEGATIVE_INFINITY;
  private terminal = false;
  private established = false;
  private publishQueue = Promise.resolve();
  private runtimeSessionId: string;
  private readonly activityId: string;
  private readonly sequenceBase: number;

  constructor(
    private readonly context: AgentActivityContext,
    private readonly deliver: typeof upsertFlightDeckPgAgentActivity = upsertFlightDeckPgAgentActivity,
    sequenceBase?: number,
    private readonly readLatestActivity = readLatestCodexUserVisibleActivity,
    private readonly log: Pick<Console, 'error'> & Partial<Pick<Console, 'info'>> = console,
    private readonly publicationStore: AgentActivityPublicationStore = agentActivityPublicationStore,
  ) {
    const startedAt = Date.parse(context.startedAt ?? '');
    this.sequenceBase = sequenceBase ?? (Number.isFinite(startedAt) ? startedAt : Date.now()) * 1_000;
    this.sequence = this.sequenceBase;
    this.runtimeSessionId = context.sessionId;
    this.activityId = buildAgentActivityId(context);
  }

  bindSession(sessionId: string): void {
    this.runtimeSessionId = sessionId;
  }

  async publish(state: AgentActivityState, body?: string): Promise<void> {
    return this.enqueuePublish(() => this.publishNow(state, body));
  }

  private enqueuePublish(operation: () => Promise<void>): Promise<void> {
    const queued = this.publishQueue.then(operation, operation);
    this.publishQueue = queued.catch(() => undefined);
    return queued;
  }

  private async publishNow(state: AgentActivityState, body?: string, sourceIdentity?: string): Promise<void> {
    if (this.terminal) return;
    const normalized = body ? normalizeUserVisibleActivity(body) : null;
    if (state === 'working' && normalized === this.lastBody && (normalized || this.lastState === 'working')) return;
    if (normalized) this.lastBody = normalized;
    const terminal = state === 'completed' || state === 'failed' || state === 'cancelled';
    // A replay can construct another publisher for the same durable turn while
    // the owning lifecycle is still active. Its stable sequence makes the
    // replayed receipt stale at Tower; do not let that unestablished replay
    // terminalize the owner's visible activity afterward.
    if (terminal && !this.established) return;
    const eventKey = sourceIdentity ?? `${state}:${normalized ?? ''}`;
    const claim = this.publicationStore.claim(this.activityId, eventKey, this.sequenceBase);
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
      const request = {
        ...this.context,
        activityId: this.activityId,
        state,
        sequence,
        // Tower treats session_id as immutable correlation data for one
        // activity_id. Keep the originally published value when the pending
        // turn later binds to its concrete runtime session.
        sessionId: this.context.sessionId,
        label: state === 'accepted' ? 'Message received' : state === 'working' ? (normalized ? 'Working' : 'Agent started') : undefined,
        summary: normalized ? normalized.replace(/\s+/g, ' ').slice(0, 240) : undefined,
        body: normalized ?? undefined,
        expiresInSeconds: terminal ? 60 : 300,
      };
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
    const activity = await this.readLatestActivity({
      sessionId: native.sessionId,
      workingDirectory: native.workingDirectory,
    }).catch(() => null);
    if (!activity) return;
    const createdAt = Date.parse(activity.createdAt);
    await this.enqueuePublish(async () => {
      if (Number.isFinite(createdAt) && createdAt <= this.latestCommentaryAt) return;
      if (Number.isFinite(createdAt)) this.latestCommentaryAt = createdAt;
      await this.publishNow('working', activity.content, `commentary:${activity.createdAt}:${createHash('sha256').update(activity.content).digest('hex').slice(0, 16)}`);
    });
  }
}
