import type { AgentDefinitionStore } from './agent-definition-store';
import type { AgentDefinitionRecord } from './types';
import { fetchNewestNostrProfile, type NostrProfileMetadata } from '../identity/nostr-profile-metadata';

export const DEFAULT_AGENT_PROFILE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type TimerHandle = ReturnType<typeof setInterval> & { unref?: () => void };

export class AgentProfileMetadataCache {
  private timer: TimerHandle | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly options: {
    store: AgentDefinitionStore;
    defaultAgentNpub: string | null;
    relays: string[];
    intervalMs?: number;
    fetchProfile?: (input: { npub: string; relays: string[] }) => Promise<NostrProfileMetadata | null>;
    now?: () => Date;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
    log?: Pick<Console, 'warn'>;
  }) {}

  start(): Promise<void> {
    if (this.timer) return this.refreshPromise ?? Promise.resolve();
    const setIntervalFn = this.options.setIntervalFn ?? setInterval;
    this.timer = setIntervalFn(() => void this.refresh(), this.options.intervalMs
      ?? DEFAULT_AGENT_PROFILE_REFRESH_INTERVAL_MS) as TimerHandle;
    this.timer.unref?.();
    return this.refresh();
  }

  stop(): void {
    if (!this.timer) return;
    (this.options.clearIntervalFn ?? clearInterval)(this.timer);
    this.timer = null;
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshDefaultAgent().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refreshDefaultAgent(): Promise<void> {
    if (!this.options.defaultAgentNpub) return;
    const agent = this.options.store.getByBotNpub(this.options.defaultAgentNpub);
    if (!agent) return;
    const attemptedAt = (this.options.now ?? (() => new Date()))().toISOString();
    try {
      const fetched = await (this.options.fetchProfile ?? fetchNewestNostrProfile)({
        npub: agent.botNpub,
        relays: this.options.relays,
      });
      if (!fetched) throw new Error('No valid kind-0 profile event found');
      const previous = agent.publicProfileRefresh;
      if (isOlder(fetched, previous)) {
        this.options.store.updatePublicProfileRefresh(agent.agentId, {
          ...emptyRefresh(previous), lastAttemptAt: attemptedAt, result: 'unchanged', error: null,
        });
        return;
      }
      const succeededAt = (this.options.now ?? (() => new Date()))().toISOString();
      this.options.store.updatePublicProfileSnapshot(agent.agentId, fetched.profile, {
        lastAttemptAt: attemptedAt,
        lastSuccessAt: succeededAt,
        sourceEventId: fetched.eventId,
        sourceEventCreatedAt: fetched.createdAt,
        result: fetched.eventId === previous?.sourceEventId ? 'unchanged' : 'hydrated',
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.updatePublicProfileRefresh(agent.agentId, {
        ...emptyRefresh(agent.publicProfileRefresh), lastAttemptAt: attemptedAt, result: 'failed', error: message,
      });
      this.options.log?.warn(`[nostr] agent profile refresh failed for ${agent.agentId}: ${message}`);
    }
  }
}

function emptyRefresh(value: AgentDefinitionRecord['publicProfileRefresh']) {
  return value ?? {
    lastAttemptAt: null, lastSuccessAt: null, sourceEventId: null,
    sourceEventCreatedAt: null, result: null, error: null,
  };
}

function isOlder(event: NostrProfileMetadata, previous: AgentDefinitionRecord['publicProfileRefresh']): boolean {
  if (previous?.sourceEventCreatedAt === null || previous?.sourceEventCreatedAt === undefined) return false;
  return event.createdAt < previous.sourceEventCreatedAt
    || (event.createdAt === previous.sourceEventCreatedAt
      && event.eventId.localeCompare(previous.sourceEventId ?? '') < 0);
}
