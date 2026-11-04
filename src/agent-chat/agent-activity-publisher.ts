import { createHash } from 'node:crypto';

import { readCodexUserVisibleActivities, type CodexUserVisibleActivity } from '../agents/codex-session-messages';
import type { ProcessManager } from '../agents/process-manager';
import { postFlightDeckPgAgentActivityLease, upsertFlightDeckPgAgentActivity, type FlightDeckPgAgentActivityLeaseResponse } from './tower-client';
import type { RuntimeBotIdentity } from './types';
import { agentActivityPublicationStore, type AgentActivityPublicationStore } from './agent-activity-publication-store';
import { liveThreadActivityHub, type LiveThreadActivityHub } from './live-thread-activity';
import { isConvergedAgentActivityError } from './agent-activity-delivery';

export type AgentActivityState = 'accepted' | 'queued' | 'working' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface AgentActivityPublishOptions {
  blockedByTurnId?: string;
  queuePosition?: number;
  heartbeat?: boolean;
}

/** Producer lease timing: 60 s turn-owned heartbeat, 180 s lease (one missed beat plus margin). */
export const AGENT_ACTIVITY_LEASE_TTL_SECONDS = 180;
const AGENT_ACTIVITY_CONTRACT = 'agent-activity/v2' as const;
/** Server-time calibration is accepted only from round trips at most this long. */
const MAX_CALIBRATION_RTT_MS = 5_000;

export type AgentActivityHeartbeatOutcome =
  | 'renewed' | 'resumed' | 'legacy' | 'terminal' | 'revoked' | 'missing' | 'failed';

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
  private publishQueue: Promise<unknown> = Promise.resolve();
  private runtimeSessionId: string;
  /** null until a Tower response says whether it serves the v2 lease route. */
  private leaseCapable: boolean | null = null;
  private leaseEpoch = 1;
  private leaseSequence = 0;
  private clockOffsetMs: number | null = null;
  private uncalibratedLogged = false;
  private readonly activityId: string;
  private readonly sequenceBase: number;

  constructor(
    private readonly context: AgentActivityContext,
    private readonly deliver: typeof upsertFlightDeckPgAgentActivity = upsertFlightDeckPgAgentActivity,
    sequenceBase?: number,
    private readonly readLatestActivity: (input: Parameters<typeof readCodexUserVisibleActivities>[0]) => Promise<CodexUserVisibleActivity[] | CodexUserVisibleActivity | null> = readCodexUserVisibleActivities,
    private readonly log: Pick<Console, 'error'> & Partial<Pick<Console, 'info'>> = console,
    private readonly publicationStore: AgentActivityPublicationStore = agentActivityPublicationStore,
    private readonly liveActivity: LiveThreadActivityHub = liveThreadActivityHub,
    private readonly deliverLease: typeof postFlightDeckPgAgentActivityLease = postFlightDeckPgAgentActivityLease,
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

  /**
   * Best-effort lease renewal, never durably stored or replayed. The caller (the
   * turn supervisor) must already have verified it owns a live turn; that
   * ownership is also what authorizes an explicit resume after expiry. Towers
   * without the v2 lease route get a legacy non-durable heartbeat PUT in
   * `legacy.state` (queued rows stay queued).
   */
  async heartbeat(legacy: { state: AgentActivityState; options?: AgentActivityPublishOptions } = { state: 'working' }): Promise<AgentActivityHeartbeatOutcome> {
    return this.enqueuePublish(() => this.beat(legacy));
  }

  private enqueuePublish<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.publishQueue.then(operation, operation);
    this.publishQueue = queued.catch(() => undefined);
    return queued;
  }

  private calibrate(serverTime: unknown, sentAt: number, receivedAt: number): void {
    const parsed = typeof serverTime === 'string' ? Date.parse(serverTime) : Number.NaN;
    if (!Number.isFinite(parsed) || receivedAt - sentAt > MAX_CALIBRATION_RTT_MS) return;
    this.clockOffsetMs = parsed - (sentAt + receivedAt) / 2;
  }

  /** Server-calibrated observation time, or undefined (Tower then uses its own time). */
  private calibratedNow(): string | undefined {
    if (this.clockOffsetMs === null) {
      if (!this.uncalibratedLogged) {
        this.uncalibratedLogged = true;
        this.log.info?.('[agent-activity] server clock not yet calibrated; lease uses Tower receipt time', { activityId: this.activityId });
      }
      return undefined;
    }
    return new Date(Date.now() + this.clockOffsetMs).toISOString();
  }

  private adoptLease(row: unknown): void {
    if (!row || typeof row !== 'object') return;
    const epoch = Number((row as Record<string, unknown>).lease_epoch);
    const sequence = Number((row as Record<string, unknown>).lease_sequence);
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(sequence) || sequence < 0) return;
    if (epoch !== this.leaseEpoch) {
      this.leaseEpoch = epoch;
      this.leaseSequence = sequence;
    } else this.leaseSequence = Math.max(this.leaseSequence, sequence);
  }

  private async leaseCall(action: 'renew' | 'resume_challenge' | 'resume',
    extra: { leaseEpoch?: number; leaseSequence?: number; observedAt?: string; challenge?: string } = {}): Promise<FlightDeckPgAgentActivityLeaseResponse | null> {
    let lastError: unknown = null;
    // One attempt plus one quick retry; a missed beat is dropped, never queued.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      const sentAt = Date.now();
      try {
        const response = await this.deliverLease({
          backendConnectionId: this.context.backendConnectionId,
          subscriptionId: this.context.subscriptionId,
          backendBaseUrl: this.context.backendBaseUrl,
          workspaceId: this.context.workspaceId,
          activityId: this.activityId,
          appNpub: this.context.appNpub,
          botIdentity: this.context.botIdentity,
          turnId: this.context.turnId,
          sessionId: this.context.sessionId,
          agentNpub: this.context.agentNpub,
          action,
          expiresInSeconds: AGENT_ACTIVITY_LEASE_TTL_SECONDS,
          ...extra,
          signal: controller.signal,
        });
        this.calibrate(response.body?.server_time, sentAt, Date.now());
        if (response.status >= 500 && attempt === 0) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        clearTimeout(timeout);
      }
    }
    this.log.error('[agent-activity] lease call dropped', { activityId: this.activityId, turnId: this.context.turnId, action,
      error: lastError instanceof Error ? lastError.message : String(lastError) });
    return null;
  }

  private async beat(legacy: { state: AgentActivityState; options?: AgentActivityPublishOptions }): Promise<AgentActivityHeartbeatOutcome> {
    if (this.terminal) return 'terminal';
    if (this.leaseCapable === false) {
      await this.publishNow(legacy.state, undefined, undefined, { ...legacy.options, heartbeat: true });
      return 'legacy';
    }
    for (let round = 0; round < 3; round += 1) {
      const response = await this.leaseCall('renew', {
        leaseEpoch: this.leaseEpoch,
        // Wall-clock floor keeps separate publishers for one lifecycle (queued, then working) increasing.
        leaseSequence: Math.max(this.leaseSequence + 1, Date.now()),
        observedAt: this.calibratedNow(),
      });
      if (!response) return 'failed';
      if (response.status === 200) {
        this.leaseCapable = true;
        this.adoptLease(response.body?.agent_activity);
        return 'renewed';
      }
      if (response.status === 404 && !response.code) {
        // Older Tower without the lease route: v1 PUTs still renew there.
        this.leaseCapable = false;
        await this.publishNow(legacy.state, undefined, undefined, { ...legacy.options, heartbeat: true });
        return 'legacy';
      }
      if (response.status === 404) return 'missing';
      if (response.status === 401 || response.status === 403) return 'revoked';
      this.leaseCapable = true;
      switch (response.code) {
        case 'agent_activity_terminal':
          this.terminal = true;
          return 'terminal';
        case 'stale_lease_epoch':
        case 'stale_lease_sequence':
          this.adoptLease(response.body?.current);
          continue;
        case 'heartbeat_too_old':
          // calibrate() already refreshed the offset from this response.
          continue;
        case 'agent_activity_lease_expired':
          return this.resume();
        default:
          this.log.error('[agent-activity] lease renewal rejected', { activityId: this.activityId, status: response.status, code: response.code });
          return 'failed';
      }
    }
    return 'failed';
  }

  /** Explicit, audited recovery after expiry: fresh Tower challenge, then epoch+1. */
  private async resume(): Promise<AgentActivityHeartbeatOutcome> {
    const issued = await this.leaseCall('resume_challenge');
    const challenge = issued?.status === 200 ? issued.body?.challenge as { value?: unknown; next_lease_epoch?: unknown } | undefined : undefined;
    const nextEpoch = Number(challenge?.next_lease_epoch);
    if (typeof challenge?.value !== 'string' || !Number.isSafeInteger(nextEpoch)) {
      this.log.error('[agent-activity] lease resume challenge unavailable', { activityId: this.activityId, status: issued?.status ?? null, code: issued?.code ?? null });
      return issued?.code === 'agent_activity_terminal' ? 'terminal' : 'failed';
    }
    const resumed = await this.leaseCall('resume', { leaseEpoch: nextEpoch, leaseSequence: Date.now(), challenge: challenge.value });
    if (resumed?.status !== 200) {
      this.log.error('[agent-activity] lease resume rejected', { activityId: this.activityId, status: resumed?.status ?? null, code: resumed?.code ?? null });
      return 'failed';
    }
    this.adoptLease(resumed.body?.agent_activity);
    this.log.info?.('[agent-activity] lease resumed after expiry', { activityId: this.activityId, turnId: this.context.turnId, leaseEpoch: this.leaseEpoch });
    return 'resumed';
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
      expiresInSeconds: terminal ? 60 : AGENT_ACTIVITY_LEASE_TTL_SECONDS,
      // v2: state and commentary never move the lease; a late durable create
      // replay therefore cannot make a dead turn look current.
      contract: AGENT_ACTIVITY_CONTRACT,
      observedAt: this.calibratedNow(),
      blockedByTurnId: state === 'queued' ? options.blockedByTurnId : undefined,
      queuePosition: state === 'queued' ? options.queuePosition : undefined,
    };
    // Heartbeats carry no payload, so the durable recovery loop never replays them.
    const claim = this.publicationStore.claim(this.activityId, eventKey, this.sequenceBase, new Date().toISOString(),
      options.heartbeat ? undefined : publicRequest);
    this.sequence = Math.max(this.sequence, claim.sequence);
    if (!claim.duplicate) {
      this.liveActivity.publish({
        workspaceId: this.context.workspaceId,
        channelId: this.context.channelId,
        threadId: this.context.threadId,
        agentNpub: this.context.agentNpub,
        sessionId: this.runtimeSessionId,
        turnId: this.context.turnId,
        sequence: claim.sequence,
        lifecycle: state,
        commentary: normalized,
        activityStatus: publicRequest.label ?? state,
        timestamp: new Date().toISOString(),
      });
    }
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
        const sentAt = Date.now();
        try {
          towerResult = await this.deliver({ ...request, signal: controller.signal });
          delivered = true;
          this.calibrate(towerResult?.server_time, sentAt, Date.now());
          const contractVersion = (towerResult?.agent_activity as { contract_version?: unknown } | undefined)?.contract_version;
          if (contractVersion === 2) this.leaseCapable = true;
          else if (contractVersion === undefined && towerResult?.agent_activity && this.leaseCapable === null) this.leaseCapable = false;
          this.adoptLease(towerResult?.agent_activity);
        } catch (error) {
          if (isConvergedAgentActivityError(error)) {
            delivered = true;
            towerResult = {};
            break;
          }
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
    if (session?.metadata?.agentTransport === 'claude-sdk') {
      const messages = await manager.getAdapter(this.runtimeSessionId)?.fetchMessages() ?? [];
      const boundary = messages.findLastIndex((message) => message.role === 'user');
      await this.enqueuePublish(async () => {
        for (const message of messages.slice(boundary + 1)) {
          // Public assistant commentary only. Never publish exposed reasoning or tool payloads.
          if (message.role !== 'agent-working') continue;
          const startedAt = Date.parse(this.context.startedAt ?? '');
          if (Number.isFinite(startedAt) && Date.parse(message.createdAt) < startedAt) continue;
          const hash = createHash('sha256').update(message.content).digest('hex').slice(0, 16);
          await this.publishNow('working', message.content,
            `commentary:${this.runtimeSessionId}:${message.messageId ?? message.createdAt}:${hash}`);
        }
      });
      return;
    }
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
