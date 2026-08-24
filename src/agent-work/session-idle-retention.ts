import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { scheduleSessionArchive } from '../storage/session-archiver';

const DEFAULT_IDLE_RETENTION_MINUTES = 60;

type SessionEvent =
  | { type: 'session-started'; session: SessionSnapshot }
  | { type: 'session-updated'; session: SessionSnapshot }
  | { type: 'session-stopped'; session: SessionSnapshot }
  | { type: 'session-deleted'; session: SessionSnapshot };

export interface AgentWorkSessionIdleRetentionDependencies {
  processManager: Pick<ProcessManager, 'on' | 'listSessions' | 'getSession' | 'stopSession'>;
  idleRetentionMinutes?: number;
}

function isAgentWorkSession(session: SessionSnapshot | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return session.metadata?.role === 'agent-work' || session.origin?.type === 'agent-work';
}

function isLiveSession(session: SessionSnapshot | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return session.status === 'running' || session.status === 'starting';
}

function resolveStartedAtMs(session: SessionSnapshot): number {
  const timestamp = Date.parse(session.startedAt);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

export class AgentWorkSessionIdleRetention {
  private readonly manager: AgentWorkSessionIdleRetentionDependencies['processManager'];
  private readonly idleRetentionMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: (() => void) | null;

  constructor(deps: AgentWorkSessionIdleRetentionDependencies) {
    this.manager = deps.processManager;
    this.idleRetentionMs = Math.max(1_000, (deps.idleRetentionMinutes ?? DEFAULT_IDLE_RETENTION_MINUTES) * 60_000);
    this.unsubscribe = this.manager.on((event) => {
      void this.handleEvent(event as SessionEvent);
    });
    for (const session of this.manager.listSessions()) {
      this.trackExistingSession(session);
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private trackExistingSession(session: SessionSnapshot): void {
    if (!isAgentWorkSession(session) || !isLiveSession(session)) {
      return;
    }
    this.scheduleTimer(session, resolveStartedAtMs(session));
  }

  private async handleEvent(event: SessionEvent): Promise<void> {
    if (event.type === 'session-deleted' || event.type === 'session-stopped') {
      this.clearTimer(event.session.id);
      return;
    }
    if (!isAgentWorkSession(event.session) || !isLiveSession(event.session)) {
      this.clearTimer(event.session.id);
      return;
    }
    this.scheduleTimer(event.session, Date.now());
  }

  private scheduleTimer(session: SessionSnapshot, activityAtMs: number): void {
    this.clearTimer(session.id);
    const elapsed = Math.max(0, Date.now() - activityAtMs);
    const delayMs = Math.max(1_000, this.idleRetentionMs - elapsed);
    const timer = setTimeout(() => {
      this.timers.delete(session.id);
      void this.expireSession(session.id);
    }, delayMs);
    timer.unref?.();
    this.timers.set(session.id, timer);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private async expireSession(sessionId: string): Promise<void> {
    const session = this.manager.getSession(sessionId) ?? null;
    if (!isAgentWorkSession(session) || !isLiveSession(session)) {
      return;
    }
    const stopped = await this.manager.stopSession(sessionId);
    if (stopped || !this.manager.getSession(sessionId)) {
      scheduleSessionArchive(sessionId, this.manager as ProcessManager);
    }
  }
}
