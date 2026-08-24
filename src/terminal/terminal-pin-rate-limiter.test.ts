import { describe, expect, test } from "bun:test";

import { TerminalPinRateLimiter } from "./terminal-pin-rate-limiter";

describe("TerminalPinRateLimiter", () => {
  test("backs off after repeated failures and clears after success", () => {
    let now = 100;
    const limiter = new TerminalPinRateLimiter({ now: () => now, threshold: 3, baseDelayMs: 1000 });
    expect(limiter.recordFailure("npub1admin")).toBe(0);
    expect(limiter.recordFailure("npub1admin")).toBe(0);
    expect(limiter.recordFailure("npub1admin")).toBe(1000);
    expect(limiter.retryAfterMs("npub1admin")).toBe(1000);
    now = 1101;
    expect(limiter.retryAfterMs("npub1admin")).toBe(0);
    expect(limiter.recordFailure("npub1admin")).toBe(2000);
    limiter.clear("npub1admin");
    expect(limiter.retryAfterMs("npub1admin")).toBe(0);
  });
});
