import { describe, expect, test } from "bun:test";

import { hasEquivalentIncomingUser } from "./conversation-sync.js";

const canonical = {
  role: "user",
  content: "check it works",
  createdAt: "2026-08-07T03:18:06.879Z",
};

describe("user transcript deduplication", () => {
  test("collapses an optimistic AgentAPI row with a nearby canonical turn", () => {
    expect(hasEquivalentIncomingUser({
      ...canonical,
      createdAt: "2026-08-07T03:18:06.400Z",
      pending: true,
    }, [canonical])).toBeTrue();
  });

  test("retains a genuinely new pending prompt through a stale snapshot", () => {
    expect(hasEquivalentIncomingUser({
      ...canonical,
      createdAt: "2026-08-07T03:19:06.400Z",
      pending: true,
    }, [canonical])).toBeFalse();
  });

  test("requires exact timestamps before deleting confirmed legacy rows", () => {
    expect(hasEquivalentIncomingUser({
      ...canonical,
      createdAt: "2026-08-07T03:18:06.400Z",
      pending: false,
    }, [canonical])).toBeFalse();
    expect(hasEquivalentIncomingUser(canonical, [canonical])).toBeTrue();
  });

  test("never merges different content or non-user rows", () => {
    expect(hasEquivalentIncomingUser({ ...canonical, content: "another prompt", pending: true }, [canonical])).toBeFalse();
    expect(hasEquivalentIncomingUser({ ...canonical, role: "assistant", pending: true }, [canonical])).toBeFalse();
  });
});
