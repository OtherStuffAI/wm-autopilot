import { describe, expect, test } from "bun:test";
import {
  configureFlightDeckPipelineInvocation,
  deliverPipelineMessageToFlightDeckRoute,
  normalizeFlightDeckPipelineInvocation,
  resolveFlightDeckPipelineInvocation,
  returnPipelineMarkdownToFlightDeckThread,
} from "./flightdeck-invocation";

const valid = {
  workspaceId: "2e5caefd-dd65-45d2-b747-ee874e8e5fc9",
  threadId: "c87e026d-23c5-4fe9-b752-117f18cf4a10",
  frmNpub: "npub1requester",
  prompt: " Ask the council. ",
};

describe("Flight Deck pipeline invocation", () => {
  test("normalizes the four domain fields", () => {
    expect(normalizeFlightDeckPipelineInvocation(valid)).toEqual(valid);
  });

  test("rejects missing, malformed, and extra invocation fields", async () => {
    expect(() => normalizeFlightDeckPipelineInvocation({ ...valid, prompt: "" })).toThrow("prompt is required");
    expect(() => normalizeFlightDeckPipelineInvocation({ ...valid, workspaceId: "workspace" })).toThrow("workspaceId must be a UUID");
    expect(() => normalizeFlightDeckPipelineInvocation({ ...valid, frmNpub: "hex" })).toThrow("frmNpub must be an npub");
    await expect(resolveFlightDeckPipelineInvocation({ ...valid, signerNpub: valid.frmNpub })).rejects.toThrow("Unexpected");
  });

  test("keeps requester context separate from the configured sender", async () => {
    configureFlightDeckPipelineInvocation({
      resolve: async (input) => ({ ...input, channelId: "channel-1", senderNpub: "npub1managed" }),
      send: async (input) => ({ delivered: true, requesterNpub: input.frmNpub, senderNpub: "npub1managed" }),
    });
    const result = await returnPipelineMarkdownToFlightDeckThread({ ...valid, message: "# Answer" });
    expect(result).toMatchObject({ delivered: true, requesterNpub: "npub1requester", senderNpub: "npub1managed" });
  });

  test("delivers with the exact route and stable idempotency key", async () => {
    let sent: Record<string, unknown> = {};
    configureFlightDeckPipelineInvocation({
      resolve: async (input) => ({ ...input, channelId: "unused", senderNpub: "npub1managed" }),
      send: async (input) => { sent = input; return { delivered: true, messageId: "message-1" }; },
    });
    const route = {
      workspaceId: valid.workspaceId,
      scopeId: "11111111-1111-4111-8111-111111111111",
      channelId: "22222222-2222-4222-8222-222222222222",
      threadId: valid.threadId,
    };
    await expect(deliverPipelineMessageToFlightDeckRoute({ route, message: "Done", idempotencyKey: "audio:abc" }))
      .resolves.toMatchObject({ delivered: true });
    expect(sent).toMatchObject({ ...route, message: "Done", clientRequestId: "audio:abc" });
    configureFlightDeckPipelineInvocation({
      resolve: async (input) => ({ ...input, channelId: "unused", senderNpub: "npub1managed" }),
      send: async () => { throw new Error("Tower write failed"); },
    });
    await expect(deliverPipelineMessageToFlightDeckRoute({ route, message: "Done", idempotencyKey: "audio:abc" }))
      .rejects.toThrow("Tower write failed");
  });
});
