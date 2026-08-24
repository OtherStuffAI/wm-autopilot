import { describe, expect, test } from "bun:test";

import { LOGIN_CHALLENGE_TTL_MS, LoginChallengeStore } from "./login-challenge-store";

describe("LoginChallengeStore", () => {
  test("consumes a challenge exactly once", () => {
    const store = new LoginChallengeStore();
    const issued = store.issue(1_000);

    expect(store.consume(issued.challenge, 1_001)).toBe(true);
    expect(store.consume(issued.challenge, 1_002)).toBe(false);
  });

  test("rejects an expired challenge", () => {
    const store = new LoginChallengeStore();
    const issued = store.issue(1_000);

    expect(store.consume(issued.challenge, 1_000 + LOGIN_CHALLENGE_TTL_MS)).toBe(false);
  });

  test("issues unpredictable unique challenges", () => {
    const store = new LoginChallengeStore();
    const first = store.issue();
    const second = store.issue();

    expect(first.challenge).not.toBe(second.challenge);
    expect(first.challenge.length).toBeGreaterThanOrEqual(40);
  });
});
