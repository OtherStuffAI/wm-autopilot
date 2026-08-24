import { describe, expect, test } from "bun:test";

import {
  buildAssignedOutputRows,
  buildExplicitDisplayRows,
  buildFallbackDisplayRows,
} from "./display-fields.js";

describe("pipeline display fields", () => {
  test("resolves explicit input and output display fields", () => {
    const step = {
      input: {
        chatDispatchInput: {
          latestThread: [
            { authorName: "Example Operator", body: "Can you check the pipeline?" },
            { authorName: "exampleAgent", body: "I will inspect it." },
          ],
        },
      },
      output: {
        intent: "software_implementation",
        dispatchTask: true,
      },
      metadata: {
        display: {
          in: [
            { label: "Thread", path: "$.chatDispatchInput.latestThread", format: "messages" },
          ],
          out: [
            { label: "Intent", path: "$.intent" },
            { label: "Task?", path: "$.dispatchTask" },
          ],
        },
      },
    };

    expect(buildExplicitDisplayRows(step, "in")).toEqual([
      {
        name: "Thread",
        value: "2 messages: Example Operator: Can you check the pipeline? | exampleAgent: I will inspect it.",
        inspectValue: step.input.chatDispatchInput.latestThread,
      },
    ]);
    expect(buildExplicitDisplayRows(step, "out")).toEqual([
      { name: "Intent", value: "software_implementation", inspectValue: "software_implementation" },
      { name: "Task?", value: true, inspectValue: true },
    ]);
  });

  test("uses empty text for missing explicit fields when configured", () => {
    const rows = buildExplicitDisplayRows({
      output: {},
      metadata: {
        display: {
          out: [
            { label: "Thread", path: "$.thread.messages", format: "messages", empty: "No thread loaded" },
          ],
        },
      },
    }, "out");

    expect(rows).toEqual([{ name: "Thread", value: "No thread loaded" }]);
  });

  test("does not render empty explicit fields when step payload was not loaded", () => {
    const rows = buildExplicitDisplayRows({
      metadata: {
        display: {
          in: [
            { label: "Thread", path: "$.chatDispatchInput.latestThread", format: "messages", empty: "No thread messages" },
          ],
        },
      },
    }, "in");

    expect(rows).toEqual([]);
  });

  test("skips empty explicit fields unless empty text is configured", () => {
    const rows = buildExplicitDisplayRows({
      output: { pipelineDefinitionId: null, dispatchTask: false },
      metadata: {
        display: {
          out: [
            { label: "Pipeline", path: "$.pipelineDefinitionId" },
            { label: "Dispatch Task", path: "$.dispatchTask" },
          ],
        },
      },
    }, "out");

    expect(rows).toEqual([{ name: "Dispatch Task", value: false, inspectValue: false }]);
  });

  test("fallback hides known plumbing and promotes readable chat fields", () => {
    const rows = buildFallbackDisplayRows({
      dispatch: { routeId: "route-1" },
      runtime: { commandPrefix: "wm" },
      chat: { messageText: "Can you check the pipeline?", channelId: "chan-1" },
      value: "visible",
    });

    expect(rows).toEqual([
      { name: "Chat Message", value: "Can you check the pipeline?", inspectValue: "Can you check the pipeline?" },
      { name: "value", value: "visible" },
    ]);
  });

  test("fallback promotes hydrate output thread and self-authored fields", () => {
    const rows = buildAssignedOutputRows("$.chatContext", {
      thread: {
        recent_messages: [
          { sender_npub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpz2c9sm", body: "Hey Wingman can you check this?" },
          { sender_npub: "npub1wingman", body: "I will check it." },
        ],
      },
      selfAuthored: true,
      shouldProceed: false,
      suppressionReason: "trigger_thread_message_sender_is_self",
    });

    expect(rows).toEqual([
      {
        name: "Thread",
        value: "2 messages: npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpz2c9sm: Hey Wingman can you check this? | npub1wingman: I will check it.",
        inspectValue: [
          { sender_npub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpz2c9sm", body: "Hey Wingman can you check this?" },
          { sender_npub: "npub1wingman", body: "I will check it." },
        ],
      },
      { name: "Self Authored", value: true },
      { name: "Suppression Reason", value: "trigger_thread_message_sender_is_self" },
    ]);
  });

  test("assigned output rows use fallback filtering below the assign path", () => {
    const rows = buildAssignedOutputRows("$.chatDispatchInput", {
      objective: "Classify the latest chat request.",
      source: { routeId: "route-1" },
      validChildPipelines: [{ name: "do-and-review" }],
    });

    expect(rows).toEqual([
      { name: "chatDispatchInput.objective", value: "Classify the latest chat request." },
    ]);
  });
});
