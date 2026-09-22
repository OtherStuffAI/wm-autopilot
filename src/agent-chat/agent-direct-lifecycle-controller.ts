import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

import type { ProcessManager } from '../agents/process-manager';
import { databaseFile } from '../storage/message-store';
import { AgentActivityPublisher, type AgentActivityContext, type AgentActivityState } from './agent-activity-publisher';
import { upsertFlightDeckPgAgentSessionHealth } from './tower-client';

export const AGENT_DIRECT_ACTIVITY_HEARTBEAT_MS = 60_000;
export const AGENT_DIRECT_SESSION_HEALTH_HEARTBEAT_MS = 120_000;
export const AGENT_DIRECT_RUNTIME_GENERATION = Date.now();

type TerminalState = Extract<AgentActivityState, 'completed' | 'failed' | 'cancelled'>;
type SessionHealthStatus = 'starting' | 'online' | 'idle' | 'busy' | 'errored' | 'stopped';

interface HealthPayload {
  backendConnectionId?: string | null;
  subscriptionId?: string | null;
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  channelId: string;
  threadId: string;
  sessionId: string;
  agentNpub: string;
  status: SessionHealthStatus;
  activeTurnId: string | null;
  generation: number;
  sequence: number;
  errorSummary?: string;
  expiresInSeconds: number;
}

export class AgentSessionHealthPublicationStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_session_health_publications (
      session_id TEXT NOT NULL, generation INTEGER NOT NULL, sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
      updated_at TEXT NOT NULL, PRIMARY KEY(session_id,generation,sequence)
    )`);
  }

  save(payload: HealthPayload): void {
    this.db.query(`INSERT INTO agent_session_health_publications
      (session_id,generation,sequence,payload_json,status,last_error,updated_at)
      VALUES (?1,?2,?3,?4,'pending',NULL,?5)
      ON CONFLICT(session_id,generation,sequence) DO NOTHING`)
      .run(payload.sessionId, payload.generation, payload.sequence, JSON.stringify(payload), new Date().toISOString());
  }

  accept(payload: HealthPayload): void {
    this.db.query(`UPDATE agent_session_health_publications SET status='accepted',last_error=NULL,updated_at=?4
      WHERE session_id=?1 AND generation=?2 AND sequence=?3`)
      .run(payload.sessionId, payload.generation, payload.sequence, new Date().toISOString());
  }

  fail(payload: HealthPayload, error: string): void {
    this.db.query(`UPDATE agent_session_health_publications SET last_error=?4,updated_at=?5
      WHERE session_id=?1 AND generation=?2 AND sequence=?3 AND status!='accepted'`)
      .run(payload.sessionId, payload.generation, payload.sequence, error, new Date().toISOString());
  }

  pending(sessionId: string): HealthPayload[] {
    return (this.db.query(`SELECT payload_json FROM agent_session_health_publications
      WHERE session_id=?1 AND status!='accepted' ORDER BY generation,sequence`).all(sessionId) as { payload_json: string }[])
      .map((row) => JSON.parse(row.payload_json) as HealthPayload);
  }

  nextSequence(sessionId: string, generation: number): number {
    const row = this.db.query(`SELECT MAX(sequence) sequence FROM agent_session_health_publications
      WHERE session_id=?1 AND generation=?2`).get(sessionId, generation) as { sequence: number | null } | null;
    return Number(row?.sequence ?? 0) + 1;
  }
}

const healthStore = new AgentSessionHealthPublicationStore();

function safeErrorSummary(error: unknown): string {
  const value = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, ' ').trim();
  return value.slice(0, 500) || 'Agent runtime failed.';
}

function runtimeStatus(manager: ProcessManager, sessionId: string): SessionHealthStatus {
  const status = manager.getSession(sessionId)?.status;
  if (status === 'starting') return 'starting';
  if (status === 'running') return 'busy';
  if (status === 'error') return 'errored';
  return 'stopped';
}

export class AgentDirectLifecycleController {
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string;
  private terminal: TerminalState | null = null;

  constructor(
    private readonly context: AgentActivityContext,
    private readonly manager: ProcessManager,
    private readonly activity = new AgentActivityPublisher(context),
    private readonly deliverHealth = upsertFlightDeckPgAgentSessionHealth,
    private readonly store = healthStore,
    private readonly generation = AGENT_DIRECT_RUNTIME_GENERATION,
  ) {
    this.sessionId = context.sessionId;
  }

  async accepted(): Promise<void> { await this.activity.publish('accepted'); }

  async queued(blockedByTurnId: string, queuePosition: number): Promise<void> {
    await this.activity.publish('queued', undefined, { blockedByTurnId, queuePosition });
  }

  async working(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    this.activity.bindSession(sessionId);
    await this.activity.publish('working');
    await this.publishHealth('busy', this.context.turnId);
    this.startTimers();
  }

  async commentary(): Promise<void> { await this.activity.publishLatestCommentary(this.manager); }

  async progress(body: string): Promise<void> { await this.activity.publish('working', body); }

  async finish(state: TerminalState, detail?: string): Promise<void> {
    if (this.terminal) return;
    this.terminal = state;
    this.stopTimers();
    await this.activity.publishLatestCommentary(this.manager);
    await this.activity.publish(state, detail);
    await this.publishHealth(state === 'failed' ? 'errored' : 'idle', null,
      state === 'failed' ? detail : undefined);
  }

  private startTimers(): void {
    if (!this.activityTimer) {
      this.activityTimer = setInterval(() => void this.heartbeat(), AGENT_DIRECT_ACTIVITY_HEARTBEAT_MS);
      this.activityTimer.unref?.();
    }
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => void this.publishHealth(runtimeStatus(this.manager, this.sessionId), this.context.turnId),
        AGENT_DIRECT_SESSION_HEALTH_HEARTBEAT_MS);
      this.healthTimer.unref?.();
    }
  }

  private stopTimers(): void {
    if (this.activityTimer) clearInterval(this.activityTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.activityTimer = null;
    this.healthTimer = null;
  }

  private async heartbeat(): Promise<void> {
    if (this.terminal) return;
    const status = runtimeStatus(this.manager, this.sessionId);
    if (status === 'errored' || status === 'stopped') {
      await this.finish('failed', `Agent runtime ${status}.`);
      return;
    }
    await this.activity.heartbeat();
  }

  private async publishHealth(status: SessionHealthStatus, activeTurnId: string | null, error?: string): Promise<void> {
    const payload: HealthPayload = {
      backendConnectionId: this.context.backendConnectionId,
      subscriptionId: this.context.subscriptionId,
      backendBaseUrl: this.context.backendBaseUrl,
      workspaceId: this.context.workspaceId,
      appNpub: this.context.appNpub,
      channelId: this.context.channelId,
      threadId: this.context.threadId,
      sessionId: this.sessionId,
      agentNpub: this.context.agentNpub,
      status,
      activeTurnId,
      generation: this.generation,
      sequence: this.store.nextSequence(this.sessionId, this.generation),
      ...(error ? { errorSummary: safeErrorSummary(error) } : {}),
      expiresInSeconds: 600,
    };
    this.store.save(payload);
    for (const pending of this.store.pending(this.sessionId)) {
      try {
        await this.deliverHealth({ ...pending, botIdentity: this.context.botIdentity });
        this.store.accept(pending);
      } catch (publishError) {
        this.store.fail(pending, safeErrorSummary(publishError));
        break;
      }
    }
  }
}
