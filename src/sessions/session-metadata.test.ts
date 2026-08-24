import { describe, expect, test } from "bun:test";

import { normaliseSessionMetadata } from "./session-metadata";

describe("normaliseSessionMetadata", () => {
  test("preserves Agent Direct Chat source coordinates", () => {
    expect(normaliseSessionMetadata({ AGENT: true, billingMode: "subscription", sessionClass: "flightdeck_chat",
      flightdeckTowerServiceNpub: " tower ", flightdeckWorkspaceId: " workspace ", flightdeckScopeId: " scope ",
      flightdeckChannelId: " channel ", flightdeckThreadId: " thread ", flightdeckAgentNpub: " agent ",
      flightdeckRoutingKey: " route ", sessionGeneration: 2 })).toMatchObject({ sessionClass: "flightdeck_chat",
      flightdeckTowerServiceNpub: "tower", flightdeckWorkspaceId: "workspace", flightdeckScopeId: "scope",
      flightdeckChannelId: "channel", flightdeckThreadId: "thread", flightdeckAgentNpub: "agent",
      flightdeckRoutingKey: "route", sessionGeneration: 2 });
  });
  test("normalises autonomous hook metadata fields", () => {
    expect(
      normaliseSessionMetadata({
        AGENT: true,
        billingMode: "credits",
        goal: "  Finish the release checklist  ",
        nextAction: "REFLECT" as never,
        nextActionPayload: "  Focus on tests first  ",
        nextActionTemplate: "  Current goal: {{goal}}  ",
        bindingType: "FLOW_RUN" as never,
        bindingId: "  thread-123  ",
        flowId: "  flow-1  ",
        flowRunId: "  run-9  ",
        tags: [" Flight Deck ", "NIP-98", "flight_deck", "bad<tag>"],
      }),
    ).toMatchObject({
      AGENT: true,
      billingMode: "credits",
      goal: "Finish the release checklist",
      nextAction: "reflect",
      nextActionPayload: "Focus on tests first",
      nextActionTemplate: "Current goal: {{goal}}",
      bindingType: "flow_run",
      bindingId: "thread-123",
      flowId: "flow-1",
      flowRunId: "run-9",
      tags: ["flight-deck", "nip-98", "badtag"],
    });
  });

  test("drops invalid autonomous hook values while preserving backward compatibility", () => {
    expect(
      normaliseSessionMetadata({
        AGENT: false,
        billingMode: "subscription",
        goal: "   ",
        nextAction: "launch" as never,
        nextActionPayload: "   ",
        nextActionTemplate: "   ",
        bindingType: "job" as never,
        bindingId: "   ",
        flowId: "   ",
        flowRunId: "   ",
      }),
    ).toMatchObject({
      AGENT: false,
      billingMode: "subscription",
    });
  });

  test("normalises pinned file lists", () => {
    expect(
      normaliseSessionMetadata({
        AGENT: true,
        billingMode: "subscription",
        pinnedFiles: ["  /tmp/a.md  ", "", "/tmp/b.md", "/tmp/a.md", 123 as never],
      }),
    ).toMatchObject({
      AGENT: true,
      billingMode: "subscription",
      pinnedFiles: ["/tmp/a.md", "/tmp/b.md"],
    });
  });

  test("preserves the per-session speech settings", () => {
    expect(
      normaliseSessionMetadata({
        AGENT: false,
        billingMode: "subscription",
        speechGenerateAudio: true,
        speechAlwaysRead: true,
      }),
    ).toMatchObject({
      AGENT: false,
      billingMode: "subscription",
      speechGenerateAudio: true,
      speechAlwaysRead: true,
    });
  });

  test("drops legacy flow orchestration binding metadata", () => {
    expect(
      normaliseSessionMetadata({
        AGENT: true,
        billingMode: "subscription",
        bindingType: "FLOW_ORCHESTRATION" as never,
        bindingId: "  run-42  ",
      }),
    ).toMatchObject({
      AGENT: true,
      billingMode: "subscription",
    });
    expect(
      normaliseSessionMetadata({
        AGENT: true,
        billingMode: "subscription",
        bindingType: "FLOW_ORCHESTRATION" as never,
        bindingId: "  run-42  ",
      }).bindingType,
    ).toBeUndefined();
  });
});
