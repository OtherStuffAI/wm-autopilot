import { AgentActivityPublisher, type AgentActivityContext } from './agent-activity-publisher';
import { agentActivityPublicationStore, type AgentActivityPublicationStore } from './agent-activity-publication-store';
import { upsertFlightDeckPgAgentActivity } from './tower-client';
import type { RuntimeBotIdentity } from './types';

export type PublicActivityRequest = Omit<Parameters<typeof upsertFlightDeckPgAgentActivity>[0], 'botIdentity' | 'signal'>;
export type ActivityIdentityRunner = (request: PublicActivityRequest,
  operation: (identity: RuntimeBotIdentity) => Promise<void>) => Promise<void>;

/** Owns durable retries even after the session lifecycle has finished. */
export class AgentActivityRecovery {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly resolveIdentity: (request: PublicActivityRequest) => RuntimeBotIdentity | null,
    private readonly store: AgentActivityPublicationStore = agentActivityPublicationStore,
    private readonly deliver = upsertFlightDeckPgAgentActivity,
    private readonly log: Pick<Console, 'error'> = console,
    private readonly withProfileIdentity?: ActivityIdentityRunner) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.recover(); }, 10_000);
    this.timer.unref();
    void this.recover();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private async withIdentity(request: PublicActivityRequest, operation: (identity: RuntimeBotIdentity) => Promise<void>): Promise<void> {
    const identity = this.resolveIdentity(request);
    if (identity) await operation(identity);
    else if (this.withProfileIdentity) await this.withProfileIdentity(request, operation);
  }

  async recover(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const item of this.store.pendingCommentarySources(100)) {
        this.store.touchCommentarySource(item.activityId);
        const context = item.payload.context as Omit<AgentActivityContext, 'botIdentity'>;
        try {
          await this.withIdentity(context as PublicActivityRequest, async (botIdentity) => {
            const publisher = new AgentActivityPublisher({ ...context, botIdentity }, this.deliver,
              undefined, undefined, this.log, this.store);
            await publisher.publishCommentaryFromSource(item.payload.source);
          });
        } catch (error) {
          this.log.error('[agent-activity] transcript recovery pending', { activityId: item.activityId,
            error: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const item of this.store.pending(100)) {
        const request = item.payload as PublicActivityRequest;
        try {
          await this.withIdentity(request, async (botIdentity) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2_000);
            try {
              await this.deliver({ ...request, botIdentity, signal: controller.signal });
              this.store.markAccepted(item.activityId, item.eventKey);
            } finally { clearTimeout(timeout); }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.markFailed(item.activityId, item.eventKey, message);
          this.store.deferAfterFailure(item.activityId, item.eventKey);
          this.log.error('[agent-activity] durable retry pending', { activityId: item.activityId,
            sequence: item.sequence, error: message });
        }
      }
    } catch (error) {
      this.log.error('[agent-activity] recovery pass failed; will retry', {
        error: error instanceof Error ? error.message : String(error) });
    } finally { this.running = false; }
  }
}
