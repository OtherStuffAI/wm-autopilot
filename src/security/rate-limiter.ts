/**
 * Rate Limiter
 *
 * Simple in-memory sliding-window rate limiter. No external dependencies.
 *
 * Each key (e.g. sessionId or "global") tracks timestamps of recent calls.
 * Expired entries are pruned on each check.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WindowEntry {
  timestamps: number[];
}

interface RateLimiterOptions {
  /** Maximum number of calls allowed within the window. */
  maxCalls: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

// ---------------------------------------------------------------------------
// RateLimiter class
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly maxCalls: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, WindowEntry>();

  constructor(options: RateLimiterOptions) {
    this.maxCalls = options.maxCalls;
    this.windowMs = options.windowMs;
  }

  /**
   * Check whether the given key is rate-limited.
   * If allowed, records the call and returns `null`.
   * If denied, returns a 429 Response.
   */
  check(key: string): Response | null {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Prune expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= this.maxCalls) {
      const retryAfter = Math.ceil(
        (entry.timestamps[0]! + this.windowMs - now) / 1000,
      );
      return Response.json(
        { error: "Rate limit exceeded", retryAfterSeconds: retryAfter },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter) },
        },
      );
    }

    entry.timestamps.push(now);
    return null; // allowed
  }

  /** Remove all tracked state (useful for tests). */
  clear(): void {
    this.windows.clear();
  }
}
