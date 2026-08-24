import { describe, expect, test } from "bun:test";
import {
  assessAutosessionCleanupCandidate,
  cleanupStaleAutosessions,
  isAutomaticallyStartedSession,
} from "./autosession-cleanup";

const nowMs = Date.parse("2026-07-24T10:30:00.000Z");
const atMinutesAgo = (minutes: number) => new Date(nowMs - minutes * 60 * 1000).toISOString();
const autoSession = (id: string, lastUpdatedAt: string | null) => ({
  id,
  lastUpdatedAt,
  metadata: { AGENT: true },
});

describe("autosession cleanup eligibility", () => {
  test("protects stale sessions Example Operator started", () => {
    expect(assessAutosessionCleanupCandidate({
      id: "user-started",
      lastUpdatedAt: atMinutesAgo(120),
      metadata: { AGENT: false, ownerNpub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpz2c9sm", createdByNpub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpz2c9sm" },
    }, { currentSessionId: "cleanup", nowMs })).toEqual({
      eligible: false,
      reason: "user-started",
    });
  });

  test("stops stale automatically started sessions", () => {
    expect(assessAutosessionCleanupCandidate(autoSession("stale", atMinutesAgo(64)), {
      currentSessionId: "cleanup",
      nowMs,
    })).toEqual({ eligible: true, reason: "eligible" });
  });

  test("protects fresh automatically started sessions", () => {
    expect(assessAutosessionCleanupCandidate(autoSession("fresh", atMinutesAgo(62)), {
      currentSessionId: "cleanup",
      nowMs,
    }).eligible).toBe(false);
  });

  test("protects automatically started sessions at the exact 63 minute boundary", () => {
    expect(assessAutosessionCleanupCandidate(autoSession("boundary", atMinutesAgo(63)), {
      currentSessionId: "cleanup",
      nowMs,
    })).toEqual({ eligible: false, reason: "not-stale" });
  });

  test("protects automatically started sessions with a missing timestamp", () => {
    expect(assessAutosessionCleanupCandidate(autoSession("missing", null), {
      currentSessionId: "cleanup",
      nowMs,
    })).toEqual({ eligible: false, reason: "missing-last-updated-at" });
  });

  test("protects the executing cleanup session", async () => {
    const stopped: string[] = [];
    const result = await cleanupStaleAutosessions([
      autoSession("cleanup", atMinutesAgo(120)),
      autoSession("other", atMinutesAgo(64)),
    ], {
      currentSessionId: "cleanup",
      nowMs,
      stopSession: async (id) => { stopped.push(id); },
    });

    expect(stopped).toEqual(["other"]);
    expect(result.skipped).toContainEqual({ id: "cleanup", reason: "self" });
  });

  test("matches canonical auto-session provenance fallbacks", () => {
    expect(isAutomaticallyStartedSession({ origin: { type: "scheduler" } })).toBe(true);
    expect(isAutomaticallyStartedSession({
      ownerNpub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpz2c9sm",
      metadata: { createdByNpub: "npub1agent" },
    })).toBe(true);
    expect(isAutomaticallyStartedSession({ metadata: { role: "agent-chat" } })).toBe(true);
    expect(isAutomaticallyStartedSession({ metadata: {} })).toBe(false);
  });

  test("classifies either dispatched-worker provenance marker as automatic", () => {
    expect(isAutomaticallyStartedSession({
      origin: { type: "session-dispatch" },
      metadata: { AGENT: false },
    })).toBe(true);
    expect(isAutomaticallyStartedSession({
      metadata: { AGENT: false, role: "dispatched-worker" },
    })).toBe(true);
  });

  test("makes the stale production dispatched-worker shape eligible", () => {
    expect(assessAutosessionCleanupCandidate({
      id: "production-dispatched-worker",
      lastUpdatedAt: atMinutesAgo(64),
      origin: { type: "session-dispatch" },
      metadata: { AGENT: false, role: "dispatched-worker" },
    }, { currentSessionId: "cleanup", nowMs })).toEqual({
      eligible: true,
      reason: "eligible",
    });
  });
});
