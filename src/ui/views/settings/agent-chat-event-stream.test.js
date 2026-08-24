import { describe, expect, test } from "bun:test";

import { getRecentEventRows, resolveEventState } from "./agent-chat-event-stream-state.js";

describe("agent chat event stream diagnostics", () => {
  test("shows suppressed dispatches as suppressed states instead of errors", () => {
    const event = {
      eventId: "1193",
      eventType: "record-changed",
      at: "2026-05-12T13:58:20.074Z",
      payload: {
        family_hash: "npub1app:comment",
        record_id: "comment-record-1",
        version: 1,
      },
    };
    const subscription = {
      recentDispatches: [
        {
          recordId: "comment-record-1",
          status: "suppressed",
          suppressionReason: "route_disabled",
        },
      ],
    };

    expect(resolveEventState(subscription, event)).toMatchObject({
      label: "Route Disabled",
      tone: "warning",
    });
  });

  test("keeps genuine failed diagnostics in the error state", () => {
    const event = {
      eventId: "1192",
      eventType: "record-changed",
      at: "2026-05-12T13:58:10.074Z",
      payload: {
        family_hash: "npub1app:task",
        record_id: "task-record-1",
        version: 1,
      },
    };
    const subscription = {
      lastRecordPullResult: {
        ok: false,
        code: "record_pull_failed",
        details: { record_id: "task-record-1" },
      },
      recentDispatches: [],
    };

    expect(resolveEventState(subscription, event)).toMatchObject({
      label: "Error",
      tone: "danger",
    });
  });

  test("omits transport events from the work event list", () => {
    const subscription = {
      recentSseEvents: [
        { eventId: null, eventType: "connected", at: "2026-05-12T13:58:29.624Z", payload: { event_id: 1193 } },
        { eventId: "1193", eventType: "record-changed", at: "2026-05-12T13:58:20.074Z", payload: { family_hash: "npub1app:comment", record_id: "comment-record-1" } },
        { eventId: null, eventType: "heartbeat", at: "2026-05-12T13:58:15.624Z", payload: {} },
      ],
    };

    expect(getRecentEventRows(subscription)).toEqual([
      expect.objectContaining({ eventId: "1193", eventType: "record-changed" }),
    ]);
  });
});
