export const FLIGHT_DECK_PG_EVENT_POLL_STALE_CODE = 'flightdeck_pg_event_poll_stale';

export interface FlightDeckPgEventWatchdogTiming {
  checkIntervalMs: number;
  freshnessThresholdMs: number;
  startupGraceMs: number;
}

export function resolveFlightDeckPgEventWatchdogTiming(input: {
  pollIntervalMs: number;
  pollTimeoutMs: number;
  checkIntervalMs?: number;
  freshnessThresholdMs?: number;
  startupGraceMs?: number;
}): FlightDeckPgEventWatchdogTiming {
  const derivedFreshnessThresholdMs = (input.pollTimeoutMs * 2) + (input.pollIntervalMs * 5);
  const freshnessThresholdMs = Math.max(1, input.freshnessThresholdMs ?? derivedFreshnessThresholdMs);
  const startupGraceMs = Math.max(
    1,
    input.startupGraceMs ?? Math.max(freshnessThresholdMs, input.pollTimeoutMs + input.pollIntervalMs),
  );
  const checkIntervalMs = Math.max(
    1,
    input.checkIntervalMs ?? Math.min(input.pollIntervalMs, Math.max(250, Math.floor(freshnessThresholdMs / 4))),
  );
  return { checkIntervalMs, freshnessThresholdMs, startupGraceMs };
}

interface WatchdogState {
  runtimeToken: object;
  startedAt: number;
  lastSuccessfulPollAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  stale: boolean;
}

export class FlightDeckPgEventFreshnessWatchdog {
  private readonly states = new Map<string, WatchdogState>();

  constructor(
    private readonly timing: FlightDeckPgEventWatchdogTiming,
    private readonly onStale: (subscriptionId: string, runtimeToken: object) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(subscriptionId: string, runtimeToken: object): void {
    const existing = this.states.get(subscriptionId);
    if (existing?.runtimeToken === runtimeToken) {
      return;
    }
    this.stop(subscriptionId);
    const state: WatchdogState = {
      runtimeToken,
      startedAt: this.now(),
      lastSuccessfulPollAt: null,
      timer: null,
      stale: false,
    };
    this.states.set(subscriptionId, state);
    this.schedule(subscriptionId, state);
  }

  recordSuccessfulPoll(subscriptionId: string, runtimeToken: object): void {
    const state = this.states.get(subscriptionId);
    if (!state || state.runtimeToken !== runtimeToken) {
      return;
    }
    state.lastSuccessfulPollAt = this.now();
    state.stale = false;
  }

  stop(subscriptionId: string): void {
    const state = this.states.get(subscriptionId);
    if (!state) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.states.delete(subscriptionId);
  }

  private schedule(subscriptionId: string, state: WatchdogState): void {
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.states.get(subscriptionId) !== state || state.stale) {
        return;
      }
      const referenceAt = state.lastSuccessfulPollAt ?? state.startedAt;
      const maximumAgeMs = state.lastSuccessfulPollAt == null
        ? this.timing.startupGraceMs
        : this.timing.freshnessThresholdMs;
      if (this.now() - referenceAt > maximumAgeMs) {
        state.stale = true;
        this.onStale(subscriptionId, state.runtimeToken);
        return;
      }
      this.schedule(subscriptionId, state);
    }, this.timing.checkIntervalMs);
    (state.timer as unknown as { unref?: () => void }).unref?.();
  }
}
