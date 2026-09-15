import { describe, expect, test } from "bun:test";

import {
  buildSessionMetadataPath,
  buildSessionMetadataUpdateBody,
  shouldResolveSessionMetadataTargetId,
} from "./session-metadata-cli";

describe("session metadata CLI helpers", () => {
  test("builds self-space and owner-space metadata endpoints", () => {
    expect(buildSessionMetadataPath("session-1")).toBe("/api/sessions/session-1/metadata");
    expect(buildSessionMetadataPath("session-1", "npub1owner")).toBe(
      "/api/owners/npub1owner/sessions/session-1/metadata",
    );
  });

  test("builds metadata update bodies from the provided flags", () => {
    expect(
      buildSessionMetadataUpdateBody({
        goal: "",
        nextAction: "reflect",
        nextActionPayload: "Focus on tests",
        nextActionTemplate: "Goal: {{goal}}",
        bindingType: "task",
        bindingId: "task-7",
      }),
    ).toEqual({
      goal: "",
      nextAction: "reflect",
      nextActionPayload: "Focus on tests",
      nextActionTemplate: "Goal: {{goal}}",
      bindingType: "task",
      bindingId: "task-7",
    });
    expect(buildSessionMetadataUpdateBody({})).toBeUndefined();
  });

  test("skips broad session lookup for exact self or full metadata targets", () => {
    const sessionId = "a2bd012f-c421-4fcc-9f63-4fed4538c0b7";

    expect(shouldResolveSessionMetadataTargetId(sessionId, sessionId)).toBeFalse();
    expect(shouldResolveSessionMetadataTargetId(sessionId)).toBeFalse();
    expect(shouldResolveSessionMetadataTargetId("a2bd012f", sessionId)).toBeTrue();
  });
});
