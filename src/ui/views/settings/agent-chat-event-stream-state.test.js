import { describe, expect, test } from "bun:test";

import {
  getEventRecordId,
  resolveEventFamily,
  resolveEventState,
} from "./agent-chat-event-stream-state.js";

describe("agent chat event stream state", () => {
  test("maps Flight Deck PG message events to chat records and dispatch history", () => {
    const event = {
      eventId: "event-pg-message",
      eventType: "flightdeck_pg.message.created",
      at: "2026-06-11T12:15:06.969Z",
      payload: {
        entity_type: "message",
        entity_id: "message-pg-1",
      },
    };
    const subscription = {
      recentDispatches: [
        {
          recordId: "message-pg-1",
          bindingId: "thread-pg-1",
          action: "chat_pipeline_dispatch",
          status: "running",
          pipelineRunId: "run-pg-1",
        },
      ],
    };

    expect(resolveEventFamily(event)).toBe("chat");
    expect(getEventRecordId(event)).toBe("message-pg-1");
    expect(resolveEventState(subscription, event)).toMatchObject({
      label: "Pipeline Dispatched",
      tone: "success",
    });
  });

  test("maps Flight Deck PG self-authored suppressions by entity id", () => {
    const event = {
      eventId: "event-pg-self",
      eventType: "flightdeck_pg.message.created",
      at: "2026-06-11T12:15:06.969Z",
      payload: {
        entity_type: "message",
        entity_id: "message-self-1",
      },
    };
    const subscription = {
      recentDispatches: [
        {
          recordId: "message-self-1",
          bindingId: "message-self-1",
          action: "chat_pipeline_suppressed",
          status: "suppressed",
          suppressionReason: "self_authored",
        },
      ],
    };

    expect(resolveEventState(subscription, event)).toMatchObject({
      label: "Skipped Self",
      tone: "muted",
    });
  });
});
