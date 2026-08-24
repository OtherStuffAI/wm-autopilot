export interface TerminalPinRateLimiterOptions {
  now?: () => number;
  threshold?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface AttemptState {
  failures: number;
  blockedUntil: number;
}

export class TerminalPinRateLimiter {
  private readonly attempts = new Map<string, AttemptState>();
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: TerminalPinRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.threshold = options.threshold ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
  }

  retryAfterMs(key: string): number {
    const state = this.attempts.get(key);
    if (!state) return 0;
    return Math.max(0, state.blockedUntil - this.now());
  }

  recordFailure(key: string): number {
    const previous = this.attempts.get(key) ?? { failures: 0, blockedUntil: 0 };
    const failures = previous.failures + 1;
    const exponent = Math.max(0, failures - this.threshold);
    const delay = failures < this.threshold
      ? 0
      : Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** exponent));
    const blockedUntil = delay > 0 ? this.now() + delay : 0;
    this.attempts.set(key, { failures, blockedUntil });
    return delay;
  }

  clear(key?: string): void {
    if (key) this.attempts.delete(key);
    else this.attempts.clear();
  }
}
